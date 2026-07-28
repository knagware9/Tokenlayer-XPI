# Identity Domain — Pluggable Domain Shell (ID-E) — Design

**Goal:** Make XI's two configurable domains — **Tokenization** and **Identity** — first-class and pluggable. A sidebar **domain switcher** reorganizes the navigation to the active domain's surfaces plus shared chrome (instead of today's flat interleaving), and a **deployment enablement flag** lets an install ship Tokenization-only, Identity-only, or both. This is the final sub-project of the "one XI app, two pluggable domains" vision.

**Program context:** ID-E is sub-project 5 (last) of the Identity program: **ID-A** credential use-case engine · **ID-B** issuer/holder/verifier runtime · **ID-C** entity wallet + My Credentials · **ID-D** passwordless QR login (all MERGED) · **ID-E** pluggable domain shell (this spec).

**Tech stack:** apps/api (Fastify — one env flag + a small `GET /config` route) + apps/web (React + Vite + Tailwind — a `Domain` model, an `AppShell` domain switcher, and the App.tsx/PlatformHome nav split). **No packages/core change; no new persistence model.**

---

## The seam being collapsed

Today there is **no `Domain` concept anywhere** (grep confirms only 4 API comment lines mention "domain"). "Identity" is one `NavItem`/`PlatformTab` interleaved with Tokenization items in flat, role-gated arrays:
- `App.tsx` builds two flat `items` arrays (the PlatformHome-landing branch and the operator-console branch), each mixing Tokenization ids (`dashboard`, `use-cases`, `create`, `assets`, `invoices`, `networks`) and Identity ids (`identity`, `verify`, `organizations`, `org-wallet`) gated by `isPlatform || isOrgAdmin`.
- `AppShell` is a pure controlled list renderer — it partitions `items` only by a `pinned` flag (main list + pinned footer); no sections, no domain awareness.
- `PlatformHome`'s `PlatformTab` union + `tabs` array mix both domains too.
- The router is single-segment (`useCaseKey` = first path segment); no domain notion in the URL.

ID-E introduces the `Domain` model and drives all three nav constructions (both App.tsx branches + PlatformHome tabs) from it.

---

## Scope

**In scope (ID-E):**
- A `Domain` model (`tokenization` | `identity`) + a web registry mapping each domain to its nav-item ids.
- Deployment enablement: `ENABLED_DOMAINS` env + `GET /config` → `{ domains }`.
- A sidebar domain switcher (shown only when >1 domain is enabled); active domain persisted in `localStorage["tl:domain"]`.
- Nav split by domain in both App.tsx branches and PlatformHome's tab set; default-view-on-switch.

**Out of scope (deferred / YAGNI):**
- URL domain prefixes (`/identity/…` vs `/tokenize/…`) — the active domain is a preference, not a route; a prefix would rework the load-bearing single-segment router and break existing `/<useCaseKey>` links. Persisted client-side instead.
- Per-org domain toggles (each org enabling domains independently) — a heavier multi-tenant config; the demo uses one deployment-level flag.
- Per-domain filtering of the shared Approvals queue — kept whole so no pending item is hidden.
- Any packages/core change; any change to the Buyer/investor branch (its own portfolio shell, unchanged).

---

## Architecture

Three layers:

1. **Deployment enablement (api)** — `env.enabledDomains: DomainKey[]` from `ENABLED_DOMAINS` (default both); `AppDeps.enabledDomains`; an authed `GET /config` returning `{ domains }`.
2. **Domain model + switcher (web)** — `apps/web/src/domains.ts` (the `DomainKey` type, the ordered domain list with label + icon, and `NAV_DOMAIN: Record<navItemId, DomainKey | "shared">`); an `AppShell` header switcher.
3. **Nav split (web)** — App.tsx holds `enabledDomains` (from `GET /config`) + `activeDomain` (from localStorage); both `items` arrays and PlatformHome's tabs render `shared + activeDomain` items only.

The unifying rule: **every nav item has a domain** (`tokenization`, `identity`, or `shared`); the shell shows `shared ∪ items(activeDomain)`; the switcher chooses `activeDomain` among `enabledDomains`.

---

## 1. Deployment enablement (api)

- **env** (`apps/api/src/env.ts`): `enabledDomains: string[]` from `ENABLED_DOMAINS` (comma-separated, default `"tokenization,identity"`, trimmed/filtered; validated against the two known keys — an unknown token is dropped with a boot warning; empty ⇒ default both).
- **AppDeps** (`apps/api/src/context.ts`): `enabledDomains: string[]`, wired at all construction sites (server + test helpers + harness scripts) — server uses `env.enabledDomains`, others default `["tokenization","identity"]`.
- **Route** `GET /config` (authed, `apps/api/src/http/routes.ts`) → `{ domains: deps.enabledDomains }`. A trivial read; the single source of truth for what the web renders. Schema in `schemas.ts` (loose response).

## 2. Domain model + switcher (web)

`apps/web/src/domains.ts`:
```ts
export type DomainKey = "tokenization" | "identity";
export interface DomainDef { key: DomainKey; label: string; icon: IconName; defaultView: string; }
export const DOMAINS: DomainDef[] = [
  { key: "tokenization", label: "Tokenization", icon: "coins", defaultView: "dashboard" },
  { key: "identity",     label: "Identity",     icon: "shield", defaultView: "identity" },
];
// Which domain each nav-item id belongs to ("shared" = visible in every domain).
export const NAV_DOMAIN: Record<string, DomainKey | "shared"> = {
  dashboard: "tokenization", "use-cases": "tokenization", create: "tokenization",
  assets: "tokenization", invoices: "tokenization", networks: "tokenization",
  identity: "identity", verify: "identity", organizations: "identity", "org-wallet": "identity",
  approvals: "shared", users: "shared", profile: "shared", credentials: "shared", back: "shared", logout: "shared",
};
```

**Switcher** — `AppShell` gains optional props `{ domains?: DomainDef[]; activeDomain?: DomainKey; onDomainChange?: (d: DomainKey) => void }`. When `domains` has >1 entry, it renders a compact segmented switcher at the top of the sidebar (above the `main` list); with ≤1 it renders nothing extra. `AppShell`'s existing `main`/`pinned` partitioning is unchanged — the caller still supplies the already-domain-filtered `items`.

## 3. Nav split (web)

`App.tsx`:
- State: `enabledDomains: DomainKey[]` (from `api.config()`, fallback `["tokenization","identity"]` on error); `activeDomain: DomainKey` = the persisted `localStorage["tl:domain"]` if it's in `enabledDomains`, else `enabledDomains[0]`.
- A helper `visibleItems(all: NavItem[]): NavItem[]` keeps an item iff `NAV_DOMAIN[id] === "shared" || NAV_DOMAIN[id] === activeDomain` (unknown ids default to shared, so nothing disappears by accident).
- Both branch `items` arrays keep building the full candidate list exactly as today (all role conditionals intact), then pass through `visibleItems(...)` before reaching `AppShell`.
- Passes `domains = DOMAINS.filter(d => enabledDomains.includes(d.key))`, `activeDomain`, and `onDomainChange` to `AppShell`. `onDomainChange(d)` sets `activeDomain`, persists it, and resets `view` to `DOMAINS.find(x=>x.key===d)!.defaultView`.
- The pinned footer + Buyer branch are untouched.

`PlatformHome.tsx`: its `tabs` array is filtered by the same `NAV_DOMAIN` mapping against the active domain (passed down from App or read from the same localStorage helper) so the platform landing's tab bar matches the sidebar. (The `PlatformTab` union is unchanged; only which tabs are listed changes.)

## Data flow

On login the web calls `GET /config` (alongside the existing chains/use-cases loads) → `enabledDomains`. It resolves `activeDomain` from localStorage. The sidebar shows the switcher (if >1 enabled) + `shared ∪ activeDomain` items. Clicking a domain persists it and jumps to that domain's default view. A single-domain deployment (`ENABLED_DOMAINS=identity`) renders no switcher and only Identity + shared nav.

## Error handling

`GET /config` failure ⇒ the web falls back to both domains enabled (degraded but functional). An unknown `ENABLED_DOMAINS` token is dropped at boot with a warning; an empty/all-unknown value defaults to both (never zero domains). A persisted `tl:domain` not in `enabledDomains` is ignored (falls back to the first enabled). Unknown nav ids map to `shared` (fail-open on visibility, never hiding a surface unexpectedly).

## Testing

- **api:** `GET /config` returns `enabledDomains` — both-domain default; a single-domain deployment (build a test app / read env) returns just that one; unknown token dropped.
- **web:** tsc + build; a live browser walkthrough — as a PlatformAdmin (and an OrgAdmin), switch Tokenization⇄Identity and confirm the sidebar reorganizes (Tokenization shows Dashboard/Use Cases/Asset Ledger/Networks; Identity shows Identity/Organizations/Verification/Wallet; Approvals + My Profile persist across both), the active view jumps to the domain default, and the choice survives reload; then boot a single-domain deployment and confirm the switcher is absent.

## Verification / done

Full api suite green (with the `/config` test) + web tsc/build + a live browser walkthrough of the domain switch (both-domains and single-domain), then finish the branch — completing the Identity program (ID-A…ID-E).
