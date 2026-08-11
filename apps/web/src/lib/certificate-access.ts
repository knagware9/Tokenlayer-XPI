import type { CredentialUseCase, Role } from "../types.js";

/**
 * May this user open the certificate designer for this credential use case?
 *
 * The mirror of the server's gate on
 * `PATCH /credential-use-cases/:key/certificate` — INCLUDING the emptiness
 * check before the comparison. A use case with `ownerOrgId: null` (legacy, or
 * platform-owned) belongs to nobody, and a user with no `orgId` matches nobody;
 * written as a bare `===`, those two agree that a use case nobody owns is
 * theirs. Showing the control would only produce a 403 on save, but the same
 * mistake on the server is a cross-tenant write, so the shape is kept identical
 * on both sides rather than approximated here.
 */
export function canDesignCertificate(
  user: { role: Role | string; orgId?: string | null } | null | undefined,
  useCase: Pick<CredentialUseCase, "ownerOrgId">,
): boolean {
  if (!user) return false;
  if (user.role === "PlatformAdmin") return true;
  if (user.role !== "OrgAdmin") return false;
  const orgId = typeof user.orgId === "string" ? user.orgId.trim() : "";
  const owner = typeof useCase.ownerOrgId === "string" ? useCase.ownerOrgId.trim() : "";
  return orgId !== "" && owner !== "" && orgId === owner;
}
