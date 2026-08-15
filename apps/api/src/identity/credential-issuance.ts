/**
 * Shared credential side-effects: sign→anchor→persist issuance and chain-first
 * revocation. Used by the credential proposal kinds AND the onboarding /
 * identity-revoke kinds so the invariants live in exactly one place.
 *
 * EN-D2: BOTH HALVES ARE CHAIN WRITES, and both are withheld for a sandbox act
 * (`sandbox.ts` explains the semantics and why they were chosen). This file is
 * where the defect the live walkthrough found actually was: every issuing path
 * in the platform funnels through `issueCredentialFor`, and it read
 * `deps.registry` directly.
 */
import { randomUUID } from "node:crypto";
import { SANDBOX_CHAIN_ID } from "@tokenlayer/core";
import type { AppDeps } from "../context.js";
import { emitEvent } from "../shared/events.js";
import { coded } from "../shared/executors.js";
import type { CredentialRecord, OrganizationRecord } from "../persistence/types.js";
import { isSandboxCredential, writableRegistry } from "../shared/sandbox.js";

export interface IssueCredentialArgs {
  issuerOrg: OrganizationRecord;
  subjectDid: string;
  type: string;
  claims: Record<string, unknown>;
  validityDays: number;
  credentialUseCaseKey?: string | null;
  proposalId: string | null;
  /** Only the use-case executor ever passes "pending" (ID-L). Defaults to "accepted". */
  initialAcceptance?: CredentialRecord["acceptance"];
  /**
   * EN-D2. Is this a SANDBOX issuance? REQUIRED, and deliberately not derived
   * in here from `credentialUseCaseKey`, because that field cannot answer for
   * every caller: onboarding issues a KycCredential governed by a TOKENIZATION
   * use case and stores no credential-use-case key at all. Required (not
   * optional-defaulting-to-false) so that a new issuance path — the kind this
   * helper exists to funnel — is a COMPILE ERROR until somebody decides which
   * environment it issues into. Getting this wrong in the false direction spends
   * real gas and writes a real on-chain record for a rehearsal.
   */
  sandbox: boolean;
}

/** Sign → anchor (when a registry is present) → persist. Throws ⇒ nothing persisted. */
export async function issueCredentialFor(deps: AppDeps, a: IssueCredentialArgs): Promise<CredentialRecord> {
  // The id is generated BEFORE signing: the VC embeds it in jti + credentialStatus.
  const credentialId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const statusUrl = `${deps.publicApiUrl}/credentials/${credentialId}/status`;
  const { vcJwt, expiresAt } = deps.keystore.issueOrgCredential({
    orgEncSeed: a.issuerOrg.didSeedEncrypted, orgDid: a.issuerOrg.did, subjectDid: a.subjectDid,
    type: a.type, claims: a.claims, credentialId, statusUrl, validityDays: a.validityDays, now,
  });
  // Anchor BEFORE persisting: a throw here fails the caller and no row exists.
  // Keep the receipt — the tx hash is the credential's public on-chain pointer (ID-O).
  //
  // EN-D2: `writableRegistry` is `undefined` for a sandbox issuance, so this
  // whole branch is skipped and NOTHING is written to any chain. The registry
  // lives on REGISTRY_CHAIN_ID and knows nothing about use cases, which is
  // precisely why `deps.registry` must never be read directly on a write path.
  const registry = writableRegistry(deps, a.sandbox);
  let anchorReceipt: { txHash: string; chainId: string } | null = null;
  if (registry) {
    anchorReceipt = await registry.anchor.anchorCredential(registry.vcRegistry, credentialId, vcJwt, now, expiresAt);
  }
  const credential = await deps.credentials.create({
    id: credentialId,
    holderDid: a.subjectDid,
    issuerDid: a.issuerOrg.did,
    type: a.type,
    vcJwt,
    subjectClaims: { id: a.subjectDid, ...a.claims },
    issuedAt: new Date(now * 1000).toISOString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
    proposalId: a.proposalId,
    credentialUseCaseKey: a.credentialUseCaseKey ?? null,
    acceptance: a.initialAcceptance ?? "accepted", acceptanceAt: null, acceptanceNote: null,
    anchorTxHash: anchorReceipt?.txHash ?? null,
    // EN-D2. A sandbox credential records the SANDBOX chain here with a null tx
    // hash: "this credential's anchoring belongs to the simulated chain, and
    // that chain hosts no registry, so there is no transaction". It is not a
    // dressed-up anchor — `anchorTxHash` stays null and `/status` reports
    // `anchored: false` — it is the DURABLE MARKER that makes the negative
    // enforceable later, when only the row is in hand: revocation reads it to
    // decide it has nothing to revoke on-chain, and the public status route
    // reads it to distinguish "sandbox, by design" from "the anchor failed".
    // Deriving that from the use case instead would leave the answer depending
    // on a record that can be deleted, and would answer nothing at all for the
    // onboarding-issued KycCredential, which stores no credential-use-case key.
    anchorChainId: anchorReceipt?.chainId ?? (a.sandbox ? SANDBOX_CHAIN_ID : null),
    revokeTxHash: null,
  });
  // EN-C. Emitted HERE rather than at each route because this is the single
  // chokepoint every issuance path goes through (closed catalog, use-case desk,
  // onboarding, CSV batch) — a new issuing path gets the event for free.
  // NOTE the payload: ids, type, timestamps, acceptance state, tx hash. Never
  // `vcJwt` and never `subjectClaims` — the claims are the private content the
  // credential exists to protect, and an integrator entitled to them fetches the
  // credential with their API key, which re-runs every authorization gate.
  await emitEvent(deps, {
    type: "credential.issued",
    orgId: a.issuerOrg.id,
    useCaseKey: a.credentialUseCaseKey ?? null,
    subjectId: credential.id,
    data: {
      credentialId: credential.id,
      credentialType: credential.type,
      subjectDid: credential.holderDid,
      issuerOrgId: a.issuerOrg.id,
      issuerDid: credential.issuerDid,
      credentialUseCaseKey: credential.credentialUseCaseKey,
      acceptance: credential.acceptance,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
      txHash: credential.anchorTxHash,
      chainId: credential.anchorChainId,
    },
  });
  return credential;
}

/** Chain FIRST, then the database — the DB is never "more revoked" than the chain. */
export async function revokeCredentialById(
  deps: AppDeps, credentialId: string, meta: { reason: string; by: string; at: string },
): Promise<void> {
  const cred = await deps.credentials.get(credentialId);
  if (!cred) throw coded(404, "NOT_FOUND", "credential missing");
  if (cred.revoked) throw coded(409, "ALREADY_REVOKED", "credential is already revoked");
  // EN-D2. Revocation is a chain WRITE, so it is gated by the same rule as
  // issuance — but the sandbox-ness is DERIVED HERE rather than demanded from
  // the caller, which is the opposite choice to `issueCredentialFor` and
  // deliberate. Issuance has the governing use case in hand at every call site;
  // revocation mostly does not (the holder-reject route, the closed-catalog
  // revoke kind and the identity-revoke kind are all handed nothing but a
  // credential id), so a required argument there would be four call sites
  // re-deriving the same thing and one of them eventually getting it wrong. The
  // credential itself already carries the answer — see `isSandboxCredential`.
  const sandbox = await isSandboxCredential(deps, cred);
  const registry = writableRegistry(deps, sandbox);
  let revokeReceipt: { txHash: string } | null = null;
  if (registry) {
    revokeReceipt = await registry.anchor.revokeCredential(registry.vcRegistry, cred.id);
  }
  await deps.credentials.revoke(cred.id, { ...meta, txHash: revokeReceipt?.txHash ?? null });
  // EN-C. Same reasoning as issuance: POST /credentials/:id/revoke returns 202 +
  // a proposal, so the revocation itself happens on approval, in the proposal
  // executor — and the holder-reject and offboarding paths reach it too. This
  // helper is where the chain-first revocation actually succeeds, so it is the
  // only place the event can be emitted once and be true everywhere.
  // The owning org is the SIGNING org, resolved from the credential's issuer DID
  // (the acting user may be a use-case-scoped desk operator in another org).
  const issuerOrg = await deps.organizations.findByDid(cred.issuerDid).catch(() => null);
  await emitEvent(deps, {
    type: "credential.revoked",
    orgId: issuerOrg?.id ?? null,
    useCaseKey: cred.credentialUseCaseKey,
    subjectId: cred.id,
    data: {
      credentialId: cred.id,
      credentialType: cred.type,
      subjectDid: cred.holderDid,
      issuerOrgId: issuerOrg?.id ?? null,
      issuerDid: cred.issuerDid,
      credentialUseCaseKey: cred.credentialUseCaseKey,
      reason: meta.reason,
      revokedAt: meta.at,
      txHash: revokeReceipt?.txHash ?? null,
    },
  });
}
