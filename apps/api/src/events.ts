/**
 * EN-C, the EMIT PATH: record a domain fact in the durable outbox, then fan it
 * out to every endpoint that asked for it. Three decisions are load-bearing.
 *
 * 1. FAN-OUT HAPPENS HERE, NOT AT DISPATCH. One WebhookDelivery row is written
 *    per (endpoint, event) at emit time, which is what makes the
 *    `@@unique([endpointId, eventId])` pair the idempotency key: the dispatcher
 *    claims existing rows rather than deciding who should have received what,
 *    so a retry, a crash, or a second dispatcher cannot double-send. The price
 *    is that an endpoint registered AFTER an event does not retroactively
 *    receive it — deliberate, and covered by the cursor API (`GET /events?after=`),
 *    which is the supported way for an integrator that was offline to catch up.
 *
 * 2. THIS FUNCTION NEVER THROWS INTO ITS CALLER. Observing must not break
 *    acting. Every call site sits immediately after a state change that has
 *    ALREADY happened — a credential signed and anchored on-chain, a token
 *    minted on a ledger. A webhook subsystem that is down must not turn that
 *    into a 500 and a rolled-back HTTP response, because the chain will not roll
 *    back with it. So: catch everything, log loudly, swallow. The event is lost;
 *    the business fact is not.
 *
 * 3. PAYLOADS ARE REDACTED, DEFENSIVELY AND BY DEPTH. Events travel to third
 *    parties by design, so they get a stricter rule than any internal read
 *    route. EN-B's final review found `GET /proposals` handing a human's bcrypt
 *    `passwordHash` to any API key; the same class of leak here is worse,
 *    because the recipient is outside the platform entirely. The contract is:
 *    identifiers, type, status, timestamps and tx hashes — never the signed
 *    credential, never a secret, never a password hash. An integrator who needs
 *    the credential itself fetches it with their EN-B API key, which re-runs
 *    every authorization gate. `redact` is the belt to the call sites' braces;
 *    call sites must still pass only what they mean to publish.
 */
import type { EventType } from "@tokenlayer/core";
import { KEY_PREFIX_MARKERS } from "./api-keys.js";
import type { AppDeps } from "./context.js";
import { endpointMatches } from "./webhooks/matching.js";

/**
 * Keys that must never reach an integrator, at any nesting depth. Named after
 * the real fields that carry this material in our records, so a call site that
 * spreads a whole row by accident (`data: { ...cred }`) is defused rather than
 * merely discouraged.
 */
const FORBIDDEN_KEYS = new Set([
  "passwordHash",
  "secretHash",
  "secretEncrypted",
  "didSeedEncrypted",
  "vcJwt",
  "presentationVpJwt",
  "secret",
  "password",
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      out[k] = redact(v);
    }
    return out;
  }
  // An API-key secret is recognisable by its marker wherever it lands, including
  // inside a free-text field no key name would have caught. EVERY marker, read
  // from the one map: a sandbox secret is still a secret, and hardcoding
  // `tl_live_` here would have left `tl_test_` credentials landing in the
  // durable outbox and every webhook body built from it.
  if (typeof value === "string" && Object.values(KEY_PREFIX_MARKERS).some((m) => value.startsWith(m))) return "[redacted]";
  return value;
}

export interface EmitInput {
  type: EventType;
  /**
   * The single owning org, or null.
   *
   * null IS NOT A SCOPE ANYONE SUBSCRIBES TO. No route can register an endpoint
   * with a null `orgId`, so a null event fans out to nobody, and `GET /events`
   * shows it only to a PlatformAdmin (who sees every row regardless). It is
   * therefore the value a row lands on when the owning org could not be
   * resolved — an unowned legacy use case, a holder DID that no longer resolves,
   * an org-less desk — and what it means in practice is A DURABLE RECORD THAT IS
   * DELIVERED TO NOBODY, not a bucket with an audience. Prefer a real org id
   * wherever one can be established.
   */
  orgId: string | null;
  useCaseKey?: string | null;
  subjectId?: string | null;
  data: Record<string, unknown>;
}

/** The Fastify `request.log` shape; `console` satisfies it too. */
interface EmitLogger {
  error(obj: unknown, msg?: string): void;
}

/**
 * Record `input` and enqueue a delivery per matching endpoint. Resolves — never
 * rejects — whatever the outbox, the endpoint list or the delivery table does.
 *
 * `log` is the caller's request logger where one is in scope (routes have
 * `request.log`; proposal executors have `ctx.log`), so an emit failure lands in
 * the same correlated request line as everything else that request did. The
 * shared side-effect helpers (`credential-issuance.ts`, `executors.ts`) are
 * called from paths that do not all carry a logger, and fall back to `console`.
 */
export async function emitEvent(deps: AppDeps, input: EmitInput, log: EmitLogger = console): Promise<void> {
  try {
    // `|| null`, not `?? null`. An empty string is not an org and not a use case
    // — it is what a legacy or org-less row stores — and letting one through
    // would make it a MATCHABLE value in `endpointMatches`, which is the same
    // ""-vs-null gate bypass this codebase has already been bitten by twice.
    // Normalised once, here, so no call site can forget.
    const event = await deps.events.append({
      type: input.type,
      orgId: input.orgId || null,
      useCaseKey: input.useCaseKey || null,
      subjectId: input.subjectId ?? null,
      data: redact(input.data) as Record<string, unknown>,
    });
    for (const ep of await deps.webhookEndpoints.listActive()) {
      if (!endpointMatches(ep, event)) continue;
      await deps.webhookDeliveries.enqueue({ endpointId: ep.id, eventId: event.id, eventSeq: event.seq });
    }
  } catch (err) {
    log.error({ err, type: input.type, orgId: input.orgId }, "[events] emit failed");
  }
}

/**
 * The owning org of a tokenization use case, for the asset events' tenancy key.
 *
 * Resolves to null rather than throwing when the use case has vanished or is
 * unowned — this feeds a call that must not fail its caller, so a missing owner
 * must not take the mint down with it. What null costs is DELIVERY, not safety:
 * the event is still recorded, but it matches no endpoint and only a
 * PlatformAdmin can read it back (see `EmitInput.orgId`). Every seeded/legacy
 * tokenization use case has no `ownerOrgId`, so this is the common case on an
 * old deployment, and it is the reason the null bucket must never be readable by
 * an org-less principal.
 */
export async function ownerOrgOfUseCase(deps: AppDeps, useCaseKey: string): Promise<string | null> {
  try {
    return (await deps.useCases.get(useCaseKey)).ownerOrgId ?? null;
  } catch {
    return null;
  }
}
