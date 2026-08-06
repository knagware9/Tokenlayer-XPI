/**
 * Mint an OrganizationMembership for a user: a custodial sub-DID signed into a
 * membership VC by the organization. Shared by the org-member onboarding routes
 * and the boot-time platform-operator provisioning so the issuance invariants
 * (sub-DID → encrypt seed → sign VC → persist both) live in exactly one place.
 */
import { randomUUID } from "node:crypto";
import type { Role } from "@tokenlayer/core";
import type { AppDeps } from "./context.js";
import type { OrganizationRecord, UserRecord } from "./persistence/types.js";

type MembershipDeps = Pick<AppDeps, "keystore" | "users" | "credentials">;

/**
 * Mint a sub-DID + OrganizationMembership VC for `user` under `org`, persisting
 * the encrypted seed on the user and the VC in the credential store. Returns the
 * minted DID. Throws on any failure so the caller can roll back the user row.
 *
 * `linkOrgId` sets the user's tenancy orgId (org-member onboarding). Leave it
 * false for platform operators, who stay globally scoped for routing/RBAC while
 * still holding a verifiable membership credential.
 */
export async function mintOrgMembership(
  deps: MembershipDeps,
  org: OrganizationRecord,
  user: UserRecord,
  role: Role,
  opts: { linkOrgId?: boolean } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const seed = deps.keystore.newSeed();
  const didSeedEncrypted = deps.keystore.encryptSeed(seed);
  const did = deps.keystore.keyOf(didSeedEncrypted).did;
  const memberSince = new Date(now * 1000).toISOString().slice(0, 10);
  const { vcJwt, expiresAt } = deps.keystore.issueMembershipCredential({
    orgEncSeed: org.didSeedEncrypted, orgDid: org.did, userDid: did,
    claims: { organization: org.name, orgId: org.id, role, memberSince }, now,
  });
  await deps.users.update(user.id, { did, didSeedEncrypted, ...(opts.linkOrgId ? { orgId: org.id } : {}) });
  await deps.credentials.create({
    id: randomUUID(),
    holderDid: did, issuerDid: org.did, type: "OrganizationMembership", vcJwt,
    subjectClaims: { id: did, organization: org.name, orgId: org.id, role, memberSince },
    issuedAt: new Date(now * 1000).toISOString(), expiresAt: new Date(expiresAt * 1000).toISOString(),
    revoked: false, revokedAt: null, revokedReason: null, revokedBy: null, proposalId: null,
    credentialUseCaseKey: null,
    acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
  });
  return did;
}
