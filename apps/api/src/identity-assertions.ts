/**
 * THE ONE PREDICATE BEHIND "DOES THIS SUBJECT HOLD A VALID CREDENTIAL?"
 *
 * Two callers ask it, and they MUST agree:
 *
 *   · `ComplianceProvider.hasVerifiedIdentity` — the in-process answer the
 *     LifecycleEngine uses to enforce `compliance.requireVerifiedIdentity`
 *     before an account may receive a token;
 *   · `POST /identity/assertions` — the same answer over HTTP, for a
 *     separately-deployed Tokenization instance that no longer shares this
 *     process (see docs: the product split).
 *
 * If those two ever disagree, splitting the deployment silently changes who may
 * hold a token — the single most dangerous thing about the split, and invisible
 * until an auditor asks why the same account passed on one topology and failed
 * on the other. So there is one function, here, and both call it.
 *
 * DELIBERATELY NOT A DISCLOSURE. It returns a boolean. Claims, issuer and
 * credential id stay behind the holder's consent in the presentation exchange —
 * an assertion that returned contents would be a back door around the consent
 * this platform is built on.
 *
 * `nowMs` is injected rather than read from the clock inside the predicate, so
 * expiry is testable at the boundary instead of only by waiting.
 */
import { PolicyError } from "@tokenlayer/core";
import type { CredentialRecord, CredentialRepository } from "./persistence/types.js";

/**
 * Has this credential passed its expiry?
 *
 * `Date.parse` rather than the lexicographic `c.expiresAt < now` the identity
 * dashboard uses. The two agree for every timestamp this platform writes — ISO
 * 8601, UTC, one format — but they stop agreeing the moment a row carries an
 * offset (`…+05:30`), where string order is not time order. Comparing instants
 * cannot drift that way, and it matches the certificate renderer, which is the
 * component a holder actually sees.
 *
 * Null `expiresAt` means no expiry, not "expired now".
 */
export function isExpired(c: CredentialRecord, nowMs: number): boolean {
  return c.expiresAt !== null && Date.parse(c.expiresAt) < nowMs;
}

/**
 * Is this a credential of `type` that its holder currently holds validly?
 *
 * EXPIRY IS PART OF VALID, and did not used to be. The gate that decides
 * whether an account may receive a token accepted a lapsed KYC credential,
 * while three other components — the verification exchange (`notExpired`), the
 * certificate renderer (the EXPIRED watermark) and the identity dashboard (the
 * "expired" bucket) — all treated the same credential as finished. Four
 * components, two answers, and the one that disagreed was the one enforcing
 * compliance.
 *
 * That is now fixed here, in the single predicate the in-process gate and
 * `POST /identity/assertions` share, so all four agree and a split deployment
 * inherits the agreement.
 */
export function isValidHeldCredential(c: CredentialRecord, type: string, nowMs: number = Date.now()): boolean {
  return !c.revoked && c.acceptance === "accepted" && c.type.includes(type) && !isExpired(c, nowMs);
}

/** True iff `holderDid` holds a valid, unrevoked, unexpired credential of `type`. */
export async function holdsValidCredential(
  credentials: CredentialRepository,
  holderDid: string,
  type: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const held = await credentials.listByHolder(holderDid);
  return held.some((c) => isValidHeldCredential(c, type, nowMs));
}

/**
 * The credential type the tokenization gate means by "verified identity".
 * Named once so the engine's rule, the assertion API and any future policy
 * cannot drift on which type counts.
 */
export const IDENTITY_CREDENTIAL_TYPE = "KycCredential";

/**
 * WHERE THE ANSWER COMES FROM — the seam the product split turns on.
 *
 * One method, deliberately: `holds(subjectDid, credentialType)`. The question
 * is asked about a DID, never a wallet address. Resolving an address to its
 * user and DID stays on tokenization's side of the boundary, because a wallet
 * is a tokenization concept and Identity has no business learning about them.
 * So splitting the deployment moves a credential lookup across the network and
 * nothing else.
 */
export interface IdentityAssertions {
  holds(subjectDid: string, credentialType: string): Promise<boolean>;
}

/** In-process: this deployment owns the credentials and answers from its own store. */
export function localIdentityAssertions(credentials: CredentialRepository): IdentityAssertions {
  return { holds: (did, type) => holdsValidCredential(credentials, did, type) };
}

/**
 * Remote: ask a separately-deployed Identity service over HTTP.
 *
 * FAIL-CLOSED, LOUDLY. A timeout, a refused connection, a 500, a 403 from an
 * expired peer key — every one of them throws. It would be easy to return
 * `false` instead, and it would even look safe (deny on doubt), but it would
 * report "this holder is not verified" for what is actually "we could not ask",
 * and an operator would go looking at the holder's credentials instead of at
 * the network. `compliance-provider.ts` already promises failures propagate;
 * this keeps that promise across the wire.
 *
 * `PolicyError` rather than a bare Error so the surface answers a clean
 * 400 IDENTITY_SERVICE_UNAVAILABLE instead of the generic REQUEST_FAILED the
 * error handler gives anything it does not recognise.
 */
export function httpIdentityAssertions(config: {
  /** Base URL of the identity service's API, e.g. `https://identity.example.com/api/v1`. */
  baseUrl: string;
  /** A peer API key holding the `identity:assert` scope. */
  apiKey: string;
  /** Milliseconds before the call is abandoned. A compliance check must not hang a mint. */
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}): IdentityAssertions {
  const { baseUrl, apiKey, timeoutMs = 5000, fetchImpl = fetch } = config;
  const url = `${baseUrl.replace(/\/+$/, "")}/identity/assertions`;
  return {
    async holds(subjectDid, credentialType) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ subject: subjectDid, credentialType }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw new PolicyError(
          "IDENTITY_SERVICE_UNAVAILABLE",
          `could not reach the identity service to verify '${subjectDid}'`,
          { reason: cause instanceof Error ? cause.message : String(cause) },
        );
      }
      if (!res.ok) {
        // The status is the useful part; the body may carry the peer's own
        // error envelope but is not trusted into ours.
        throw new PolicyError(
          "IDENTITY_SERVICE_UNAVAILABLE",
          `the identity service refused the assertion (HTTP ${res.status})`,
          { status: res.status },
        );
      }
      const body = (await res.json()) as { holds?: unknown };
      if (typeof body.holds !== "boolean") {
        throw new PolicyError("IDENTITY_SERVICE_UNAVAILABLE", "the identity service returned no verdict", {});
      }
      return body.holds;
    },
  };
}

/**
 * Neither: this deployment does not hold credentials and was not told where to
 * ask. Every call throws.
 *
 * The alternative — answering `false` — would silently make every
 * `requireVerifiedIdentity` use case unusable on a misconfigured deployment,
 * and the operator would see "holder not verified" forever with nothing
 * pointing at the missing configuration. This is the same rule the chain
 * registry follows: real or absent, never silently something else.
 */
export function unavailableIdentityAssertions(reason: string): IdentityAssertions {
  return {
    async holds(subjectDid) {
      throw new PolicyError(
        "IDENTITY_SERVICE_UNAVAILABLE",
        `cannot verify '${subjectDid}': ${reason}`,
        { reason },
      );
    },
  };
}

/**
 * WHICH OF THE THREE this deployment gets, decided once at boot.
 *
 * The three cases are the three topologies, and there is deliberately no
 * fourth: a deployment either owns credentials, or knows where to ask, or
 * cannot answer and says so.
 *
 * A function rather than an `if` in `server.ts` because the precedence is the
 * interesting part and it should be testable without booting a server.
 * `env.ts` has already refused the two contradictory configurations (a URL
 * without a key; a remote service on a deployment that also runs the identity
 * domain), so the ordering here never has to arbitrate between them.
 */
export function selectIdentityAssertions(config: {
  subjectIdentifiers?: "did" | "plain";
  /** The domains this deployment serves. Contains "identity" ⇒ it owns the credential store. */
  enabledDomains: readonly string[];
  serviceUrl?: string;
  serviceKey?: string;
  timeoutMs?: number;
  /** The local store, consulted only in the local case. */
  credentials: CredentialRepository;
  fetchImpl?: typeof fetch;
}): IdentityAssertions {
  // PLAIN IDENTIFIERS FIRST. With no subject DIDs there is nothing to assert
  // about, and the reason has to say so: the alternative is a gate that refuses
  // every holder while reporting that some identity service was unreachable.
  // env.ts already refuses `plain` together with a configured service, so this
  // cannot shadow a working remote — it only names the local truth.
  if (config.subjectIdentifiers === "plain") {
    return unavailableIdentityAssertions(
      "this deployment runs users as ordinary accounts (SUBJECT_IDENTIFIERS=plain) — they hold no credentials, " +
        "so a use case requiring a verified identity cannot be satisfied here",
    );
  }
  if (config.serviceUrl && config.serviceKey) {
    return httpIdentityAssertions({
      baseUrl: config.serviceUrl,
      apiKey: config.serviceKey,
      timeoutMs: config.timeoutMs,
      fetchImpl: config.fetchImpl,
    });
  }
  if (config.enabledDomains.includes("identity")) return localIdentityAssertions(config.credentials);
  return unavailableIdentityAssertions(
    "this deployment does not run the identity domain and IDENTITY_SERVICE_URL is not configured",
  );
}
