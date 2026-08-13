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
