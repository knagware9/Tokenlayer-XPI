/**
 * Shared vocabulary for the EN-A organization capability envelope: the labels,
 * the full-envelope seed, the toggle, and the ONE validation rule (with its
 * user-facing copy). Both surfaces that edit an envelope — the signup wizard's
 * CheckGroup and the admin CapabilityEditor — import from here so the rule and
 * the wording can never drift apart. The two visual treatments stay in their
 * own components; only the data is shared.
 */
import { ORG_DOMAINS, ORG_OPERATING_ROLES, type OrgCapabilities, type OrgDomain, type OrgOperatingRole } from "../types.js";

export const DOMAIN_LABELS: Record<OrgDomain, string> = {
  tokenization: "Tokenization",
  identity: "Identity",
};

export const ROLE_LABELS: Record<OrgOperatingRole, string> = {
  Issuer: "Issuer",
  Holder: "Holder",
  Verifier: "Verifier",
};

/**
 * Mirrors core's `orgRoleEnabled`: a null/absent (legacy) envelope enables
 * everything, so read-only surfaces that filter on it stay unrestricted for
 * orgs that predate EN-A.
 */
export function orgRoleEnabled(caps: OrgCapabilities | null | undefined, role: OrgOperatingRole): boolean {
  return caps == null || caps.roles.includes(role);
}

/**
 * Mirrors core's `orgDomainEnabled`, on the same terms as `orgRoleEnabled`: a
 * null/absent (legacy) envelope enables every domain. Used by the webhook
 * subscription picker, which must not offer an org an event class the server
 * would refuse with 403 ORG_CAPABILITY_MISSING.
 */
export function orgDomainEnabled(caps: OrgCapabilities | null | undefined, domain: OrgDomain): boolean {
  return caps == null || caps.domains.includes(domain);
}

/** Is a role gated by the envelope at all? Only the three operating roles are. */
export function isOrgOperatingRole(role: string): role is OrgOperatingRole {
  return (ORG_OPERATING_ROLES as readonly string[]).includes(role);
}

/** The unrestricted envelope, spelled out. What an editor seeds with when the
 * org has no explicit envelope yet (legacy null) — narrowing is deliberate. */
export function fullCapabilities(): OrgCapabilities {
  return { domains: [...ORG_DOMAINS], roles: [...ORG_OPERATING_ROLES] };
}

/** Add or remove one capability from a half of the envelope (immutably). */
export function toggleCapability<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/**
 * The envelope an operator may submit: at least one of each half. (An empty
 * half is a legitimate *stored* state — the platform can grant one — but no UI
 * asks for it, so both editors reject it with the same message.)
 * Returns the error string to show, or null when the draft is submittable.
 */
export function validateEnvelope(caps: OrgCapabilities): string | null {
  if (caps.domains.length === 0) return "Select at least one domain";
  if (caps.roles.length === 0) return "Select at least one operating role";
  return null;
}
