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
 */
import type { CredentialRecord, CredentialRepository } from "./persistence/types.js";

/**
 * Is this a credential of `type` that its holder currently holds validly?
 *
 * KNOWN GAP, PRESERVED ON PURPOSE: expiry is NOT checked here, because the
 * in-process gate never checked it and this extraction must not change
 * behaviour on its way to becoming shared. It is a real inconsistency — the
 * certificate renderer stamps EXPIRED and the identity dashboard counts an
 * expired credential as expired, while this predicate still says yes — and it
 * should be fixed. Fixing it HERE now fixes both callers at once, which is the
 * reason this function exists; doing it as part of the extraction would have
 * hidden a behaviour change inside a refactor.
 */
export function isValidHeldCredential(c: CredentialRecord, type: string): boolean {
  return !c.revoked && c.acceptance === "accepted" && c.type.includes(type);
}

/** True iff `holderDid` holds a valid, unrevoked credential of `type`. */
export async function holdsValidCredential(
  credentials: CredentialRepository,
  holderDid: string,
  type: string,
): Promise<boolean> {
  const held = await credentials.listByHolder(holderDid);
  return held.some((c) => isValidHeldCredential(c, type));
}

/**
 * The credential type the tokenization gate means by "verified identity".
 * Named once so the engine's rule, the assertion API and any future policy
 * cannot drift on which type counts.
 */
export const IDENTITY_CREDENTIAL_TYPE = "KycCredential";
