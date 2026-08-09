import type { IconName } from "./components/ui.js";

export type DomainKey = "tokenization" | "identity";

export interface DomainDef { key: DomainKey; label: string; icon: IconName; defaultView: string; }

/** Ordered domains; the first enabled is the fallback active domain. */
export const DOMAINS: DomainDef[] = [
  { key: "tokenization", label: "Tokenization", icon: "coins", defaultView: "dashboard" },
  { key: "identity", label: "Identity", icon: "shield", defaultView: "identity" },
];

/** Which domain a nav-item id belongs to. "shared" = visible in every domain.
 *  Unknown ids are treated as "shared" (fail-open — never hide a surface). */
export const NAV_DOMAIN: Record<string, DomainKey | "shared"> = {
  dashboard: "tokenization", "use-cases": "tokenization", create: "tokenization",
  assets: "tokenization", invoices: "tokenization", networks: "tokenization",
  identity: "identity", verify: "identity", "org-wallet": "identity", "issue-credentials": "identity", "identity-dashboard": "identity",
  // Organizations is tenant management, not a domain surface — it belongs with
  // profile/approvals/users. Domain-scoping it would strand a tokenization-only
  // org: the Organizations screen carries the capability-request control, so
  // hiding it there would leave no in-app way back from a narrowed envelope.
  organizations: "shared",
  // Developers (API keys) is tenant tooling for the whole account, not a domain
  // surface — the same reasoning as Organizations above, and the same trap: a
  // key can be bound to either domain's roles, so domain-scoping this page would
  // hide an org's own integration credentials behind a switcher they may not have.
  developers: "shared",
  approvals: "shared", users: "shared", profile: "shared", credentials: "shared", back: "shared", logout: "shared",
};

export const DOMAIN_KEYS: DomainKey[] = DOMAINS.map((d) => d.key);
const STORAGE_KEY = "tl:domain";

export function loadActiveDomain(enabled: DomainKey[]): DomainKey {
  const saved = localStorage.getItem(STORAGE_KEY) as DomainKey | null;
  return saved && enabled.includes(saved) ? saved : (enabled[0] ?? "tokenization");
}
export function saveActiveDomain(d: DomainKey): void { localStorage.setItem(STORAGE_KEY, d); }

/** Keep only items visible in the active domain (shared + active-domain items). */
export function itemsForDomain<T extends { id: string }>(items: T[], active: DomainKey): T[] {
  return items.filter((i) => { const d = NAV_DOMAIN[i.id] ?? "shared"; return d === "shared" || d === active; });
}

/** Deployment-enabled domains that this role actually has >=1 non-shared nav item in. */
export function availableDomains(items: { id: string }[], enabled: DomainKey[]): DomainDef[] {
  return DOMAINS.filter((d) => enabled.includes(d.key) && items.some((i) => NAV_DOMAIN[i.id] === d.key));
}
