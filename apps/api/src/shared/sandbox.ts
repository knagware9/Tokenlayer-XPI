/**
 * EN-D2, THE THIRD RULE: **a sandbox act must never produce a real on-chain
 * write.**
 *
 * The feature shipped with two rules and a hole between them: which chains a
 * USE CASE may name, and which PRINCIPAL may act on it — between them they
 * cover everything that reaches a ledger through
 * `deps.chains.resolveAdapter(useCase.chainId)`. The platform's
 * identity registries do not: they live on ONE chain (`REGISTRY_CHAIN_ID`,
 * `besu` in practice) and are reached through `deps.registry`, which is resolved
 * once at boot and consults no use case at all. A live walkthrough proved the
 * consequence — a sandbox credential issuance spent a real transaction on real
 * Besu and left a real record in `VcRegistry`, while every HTTP response said
 * 200/202.
 *
 * THE SEMANTICS CHOSEN: **a sandbox act does not anchor.** The credential is
 * signed, persisted and held exactly as a live one is; nothing is written to any
 * chain; and `GET /credentials/:id/status` says so in as many words
 * (`source: "sandbox"`, `sandbox: true`) rather than reporting the `database`
 * fallback that also means "the anchor failed". The rejected alternative was a
 * simulated registry on the sandbox chain, which buys anchoring FIDELITY at the
 * cost of manufacturing a second thing that looks like an anchor — a tx hash, a
 * `source: "chain"` status, a `GET /registry` answer — for every consumer to
 * re-learn the difference; and because that registry would be in-memory, every
 * restart would silently turn `anchored: true` back into `anchored: false`,
 * which is WORSE than never having claimed it. `registry.ts` states the
 * platform's rule as "we never fake an anchor"; not anchoring is the reading of
 * that rule which needs no exception.
 *
 * WHY THE FLAG IS PASSED AND NOT PEEKED AT. `writableRegistry` takes a boolean
 * rather than looking one up, so the question "is this a sandbox act?" is
 * answered by the caller that knows the answer, at a call site the compiler
 * checks. `issueCredentialFor` makes it a REQUIRED field for the same reason: a
 * future issuance path that forgets to think about the sandbox does not compile.
 */
import { SANDBOX_CHAIN_ID } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import type { IdentityRegistry } from "../identity/registry.js";

/**
 * The identity registry a WRITE may use — `undefined` for a sandbox act.
 *
 * Used by credential issuance and revocation. The other registry writers are
 * deliberately live-only — the boot-time platform-org bootstrap, `POST /orgs`,
 * `POST /orgs/:id/approve`, and `ensureOrg`, all platform governance that a
 * machine principal cannot reach and that has no sandbox counterpart. Each says
 * so where it sits; there is no third kind.
 */
export function writableRegistry(deps: AppDeps, sandbox: boolean): IdentityRegistry | undefined {
  return sandbox ? undefined : deps.registry;
}

/**
 * Is `useCaseKey` a SANDBOX use case, in either domain?
 *
 * BOTH REPOS, for the same reason `deriveMode` consults both: a key is unique
 * across tokenization and identity, and an implementation that knew only one
 * would call every use case of the other domain live. The onboarding path is
 * exactly that case — it issues a KycCredential whose governing use case is a
 * TOKENIZATION one.
 *
 * AN UNRESOLVABLE KEY READS AS LIVE, matching `deriveMode`
 * rather than inventing a third default. It is the pre-EN-D2 answer, so a
 * deployment with no sandbox anywhere behaves byte-for-byte as it did; and the
 * alternative — defaulting a vanished use case to sandbox — would silently stop
 * anchoring REAL credentials, which is a data-integrity failure in the opposite
 * direction and far harder to notice than a refusal.
 */
export async function isSandboxUseCase(deps: AppDeps, useCaseKey: string | null | undefined): Promise<boolean> {
  if (!useCaseKey) return false;
  const uc = (await deps.useCases.get(useCaseKey).catch(() => null))
    ?? (await deps.credentialUseCases.get(useCaseKey).catch(() => null));
  return uc?.sandbox === true;
}

/**
 * Was this credential issued as a SANDBOX credential?
 *
 * Two independent readings, and EITHER ONE is enough to withhold the chain,
 * because this decides a WRITE and the two can only disagree when something has
 * already gone wrong:
 *
 *   1. `anchorChainId === SANDBOX_CHAIN_ID` — the fact recorded on the row at
 *      issuance. This is the load-bearing one: it survives the use case being
 *      deleted, and it is the ONLY thing that answers for the onboarding-issued
 *      KycCredential, whose `credentialUseCaseKey` is null because its governing
 *      use case belongs to the other domain.
 *   2. its credential use case is a sandbox one — the live-config reading, kept
 *      as a belt so that a credential issued before this fix (no marker on the
 *      row) is still not revoked on a real chain.
 *
 * `sandbox` is immutable on a use case once created, so (2) cannot change
 * under a credential's feet.
 */
export async function isSandboxCredential(
  deps: AppDeps,
  cred: { anchorChainId: string | null; credentialUseCaseKey: string | null },
): Promise<boolean> {
  if (cred.anchorChainId === SANDBOX_CHAIN_ID) return true;
  return isSandboxUseCase(deps, cred.credentialUseCaseKey);
}
