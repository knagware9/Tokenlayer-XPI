/**
 * The organization capability envelope (EN-A): which domains a tenant org
 * operates and which operating roles it plays. `null` everywhere means the
 * unrestricted LEGACY envelope — orgs created before EN-A (or by paths that
 * don't choose) keep full powers until the platform sets an explicit envelope.
 * An explicit envelope with an empty array is fully restrictive: [] ≠ null.
 */
import { PolicyError } from "./errors.js";

export const ORG_DOMAINS = ["tokenization", "identity"] as const;
export type OrgDomain = (typeof ORG_DOMAINS)[number];
export const ORG_OPERATING_ROLES = ["Issuer", "Holder", "Verifier"] as const;
export type OrgOperatingRole = (typeof ORG_OPERATING_ROLES)[number];

export interface OrgCapabilities {
  domains: OrgDomain[];
  roles: OrgOperatingRole[];
}

export function orgDomainEnabled(caps: OrgCapabilities | null, domain: OrgDomain): boolean {
  return caps === null || caps.domains.includes(domain);
}

export function orgRoleEnabled(caps: OrgCapabilities | null, role: OrgOperatingRole): boolean {
  return caps === null || caps.roles.includes(role);
}

export function validateOrgCapabilities(input: unknown): OrgCapabilities {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PolicyError("INVALID_CAPABILITIES", "capabilities must be an object with domains and roles arrays");
  }
  const { domains, roles } = input as { domains?: unknown; roles?: unknown };
  const checkList = <T extends string>(value: unknown, allowed: readonly T[], label: string): T[] => {
    if (!Array.isArray(value)) throw new PolicyError("INVALID_CAPABILITIES", `${label} must be an array`);
    for (const v of value) {
      if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
        throw new PolicyError("INVALID_CAPABILITIES", `unknown ${label} entry '${String(v)}'`);
      }
    }
    if (new Set(value).size !== value.length) throw new PolicyError("INVALID_CAPABILITIES", `${label} contains duplicates`);
    return [...value] as T[];
  };
  return {
    domains: checkList(domains, ORG_DOMAINS, "domains"),
    roles: checkList(roles, ORG_OPERATING_ROLES, "roles"),
  };
}
