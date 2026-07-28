# ID-E — Pluggable Domain Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-class `Domain` (`tokenization` | `identity`): a sidebar switcher reorganizes the nav to the active domain + shared chrome, and a deployment flag enables which domains an install runs.

**Architecture:** API adds one env flag (`ENABLED_DOMAINS`) + an authed `GET /config` → `{ domains }`. Web adds a `domains.ts` registry (each nav item → a domain or "shared"), an `AppShell` switcher (shown only when >1 enabled), and App.tsx filters its two nav `items` arrays by the active domain (persisted in `localStorage["tl:domain"]`). No packages/core change; no new persistence model; PlatformHome untouched (its tab bar is dead in production — App always passes an explicit `view`, so the sidebar is authoritative).

**Tech Stack:** apps/api (Fastify + Vitest), apps/web (React + Vite + Tailwind). Spec: `docs/superpowers/specs/2026-07-28-identity-pluggable-domain-shell-design.md`.

**Branch:** create `feat/identity-domain-shell` off `main` before Task 1.

## Verified contracts (grounded in current code — do not re-derive)

- **env** (`apps/api/src/env.ts`): the `Env` interface + a single exported object literal. Precedent — `corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean)`. Mirror this for `enabledDomains`.
- **AppDeps** (`apps/api/src/context.ts`): required fields incl. `publicWebUrl`, `corsOrigins?`, `isProduction?`. Adding a required field means every construction site updates.
- **AppDeps construction sites** (7): `apps/api/src/server.ts` (uses `env.*`), `apps/api/test/helpers.ts`, and harness scripts `apps/api/src/{demo,e2e-buy,e2e-carbon,e2e-tenancy,e2e-usecases}.ts`. (`grep -rn "publicWebUrl:" apps/api/src apps/api/test` enumerates them — each site that sets `publicWebUrl` also needs `enabledDomains`.)
- **Routes** (`apps/api/src/http/routes.ts`): `registerRoutes(app, deps)`; `...auth` spread on authed routes; `notFound(reply, msg)`. `GET /me` (`app.get("/me", { schema: S.me, ...auth }, …)`) is the pattern for a trivial authed read.
- **schemas** (`apps/api/src/http/schemas.ts`): `S` object of route schemas; `bearer = [{ bearerAuth: [] }]`; `errs(...codes)`; loose responses use `additionalProperties: true`.
- **Test harness** (`apps/api/test/helpers.ts`): `buildTestApp(overrides?)`, `loginAs`, `V1`, `auth(token)`. Confirm whether `buildTestApp` accepts a deps override (ID-C passed `{ registry }`); if it does, a single-domain test can pass `{ enabledDomains: ["identity"] }`.
- **web `AppShell`** (`apps/web/src/components/AppShell.tsx`): `AppShell({ items, active, onSelect, children })`; `NavItem = { id, label, icon: IconName, pinned? }`; renders `main = items.filter(!pinned)` then `pinned`. The logo header is at the top of the `<aside>`; the switcher goes between it and `<nav>`.
- **web `App.tsx`**: `const [view, setView] = useState("dashboard")`; `handleSelect(id)` = logout→`navigate("/")+logout()`, back→`navigate("/")`, else `setView(id)`. Three `AppShell` returns: **Buyer** (line ~101, LEAVE UNTOUCHED), **PlatformHome branch** (`isPlatform && !activeUseCase`, line ~126, `items` built ~105-115, `knownIds`/`activeId` ~120-121), **Operator console** (line ~189, `items` built ~134-146, `deskIds`/`activeId` ~187-188). Config/chains load in the `useEffect` at line ~37. `useAuth()` gives `token`.
- **web `api.ts`**: `request<T>(path, token, init?)`; e.g. `chains: (token) => request<ChainInfo[]>("/chains", token)`.
- **web `types.ts`**: add small config + domain types here or in `domains.ts`.
- **`IconName`** (`apps/web/src/components/ui.tsx`): includes `coins`, `shield` (used for the two domain icons).

---

## Task 1: API — deployment enablement (env + config route)

**Files:**
- Modify: `apps/api/src/env.ts`, `apps/api/src/context.ts`, `apps/api/src/server.ts`, `apps/api/test/helpers.ts`, `apps/api/src/{demo,e2e-buy,e2e-carbon,e2e-tenancy,e2e-usecases}.ts`, `apps/api/src/http/routes.ts`, `apps/api/src/http/schemas.ts`
- Test: `apps/api/test/config.test.ts` (new)

- [ ] **Step 1: env** — in `apps/api/src/env.ts` add `enabledDomains: string[];` to the `Env` interface, and to the object literal:
```ts
  enabledDomains: (() => {
    const known = ["tokenization", "identity"];
    const parsed = (process.env.ENABLED_DOMAINS ?? "tokenization,identity")
      .split(",").map((s) => s.trim()).filter(Boolean).filter((d) => known.includes(d));
    return parsed.length > 0 ? parsed : known; // empty/all-unknown ⇒ both (never zero)
  })(),
```

- [ ] **Step 2: AppDeps** — in `apps/api/src/context.ts` add `enabledDomains: string[];` to `AppDeps` (near `publicWebUrl`).

- [ ] **Step 3: Wire construction sites** — add the field to all 7 AppDeps literals: `server.ts` → `enabledDomains: env.enabledDomains,`; each `e2e-*.ts` + `demo.ts` → `enabledDomains: ["tokenization", "identity"],`. For `test/helpers.ts`: add `enabledDomains?: string[]` to `buildTestApp`'s `opts` type and set `enabledDomains: opts.enabledDomains ?? ["tokenization", "identity"]` in its deps literal (so a single-domain deployment is testable). (`grep -rn "publicWebUrl:" apps/api/src apps/api/test` finds all the literals; the `tsc` gate in Step 6 proves none were missed.)

- [ ] **Step 4: Schema** — in `apps/api/src/http/schemas.ts` add to `S`:
```ts
  config: {
    tags: ["Config"], summary: "Deployment configuration (enabled domains)", security: bearer,
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401) },
  },
```

- [ ] **Step 5: Route** — in `apps/api/src/http/routes.ts`, near `GET /me`, add:
```ts
  app.get("/config", { schema: S.config, ...auth }, async () => ({ domains: deps.enabledDomains }));
```

- [ ] **Step 6: Test** — create `apps/api/test/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

describe("GET /config", () => {
  it("returns the enabled domains (default: both)", async () => {
    const app = await buildTestApp();
    const token = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}/config`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().domains).toEqual(["tokenization", "identity"]);
  });
  it("requires auth", async () => {
    const app = await buildTestApp();
    expect((await app.inject({ method: "GET", url: `${V1}/config` })).statusCode).toBe(401);
  });
  it("reflects a single-domain deployment", async () => {
    const app = await buildTestApp({ enabledDomains: ["identity"] });
    const token = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}/config`, headers: auth(token) });
    expect(res.json().domains).toEqual(["identity"]);
  });
});
```
(This third case relies on the `enabledDomains?` opt added to `buildTestApp` in Step 3.)

- [ ] **Step 7: Verify + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/api exec vitest run test/config.test.ts && pnpm --filter @tokenlayer/api exec tsc --noEmit && pnpm -s --filter @tokenlayer/api test`
Expected: config tests pass; typecheck clean (all 7 sites wired); full suite green.
```bash
git add apps/api/src/env.ts apps/api/src/context.ts apps/api/src/server.ts apps/api/test/helpers.ts apps/api/src/demo.ts apps/api/src/e2e-buy.ts apps/api/src/e2e-carbon.ts apps/api/src/e2e-tenancy.ts apps/api/src/e2e-usecases.ts apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/config.test.ts
git commit -m "feat(api): ENABLED_DOMAINS env + GET /config for deployment domain enablement"
```

---

## Task 2: Web — domain model + AppShell switcher + client

**Files:**
- Create: `apps/web/src/domains.ts`
- Modify: `apps/web/src/components/AppShell.tsx`, `apps/web/src/types.ts`, `apps/web/src/api.ts`

- [ ] **Step 1: Domain registry** — create `apps/web/src/domains.ts`:
```ts
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
  identity: "identity", verify: "identity", organizations: "identity", "org-wallet": "identity",
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
```

- [ ] **Step 2: AppShell switcher** — in `apps/web/src/components/AppShell.tsx`:
  - Import `DomainDef, DomainKey` from `../domains.js`.
  - Add optional props: `domains?: DomainDef[]; activeDomain?: DomainKey; onDomainChange?: (d: DomainKey) => void;`.
  - Between the logo header `<div>` and the `<nav>`, render a switcher **only when `domains` has >1 entry**:
```tsx
        {domains && domains.length > 1 && activeDomain && onDomainChange && (
          <div className="px-3 pt-1 pb-2">
            <div className="flex gap-1 rounded-lg bg-white/5 p-1">
              {domains.map((d) => (
                <button
                  key={d.key}
                  onClick={() => onDomainChange(d.key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    activeDomain === d.key ? "bg-white/10 text-white" : "text-slate-400 hover:text-white"
                  }`}
                >
                  <Icon name={d.icon} className="w-4 h-4 shrink-0" />
                  <span className="truncate">{d.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
```
  (`Icon` is already imported. The `main`/`pinned` rendering is unchanged.)

- [ ] **Step 3: Client + types** — in `apps/web/src/types.ts` add `export interface AppConfig { domains: import("./domains.js").DomainKey[]; }` (or a plain `{ domains: string[] }` and narrow in App). In `apps/web/src/api.ts` add:
```ts
  config: (token: string) => request<{ domains: string[] }>("/config", token),
```

- [ ] **Step 4: Verify + commit** — this task adds the switcher + registry but doesn't wire App.tsx yet; it must still typecheck/build (the new AppShell props are optional, so existing calls compile).

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: both clean.
```bash
git add apps/web/src/domains.ts apps/web/src/components/AppShell.tsx apps/web/src/types.ts apps/web/src/api.ts
git commit -m "feat(web): domain registry + AppShell domain switcher + config client"
```

---

## Task 3: Web — App.tsx nav split + config load + switcher wiring

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Domain state + config load** — in `App.tsx`:
  - Import `DOMAINS, DOMAIN_KEYS, type DomainKey, loadActiveDomain, saveActiveDomain, itemsForDomain` from `./domains.js`.
  - Add state: `const [enabledDomains, setEnabledDomains] = useState<DomainKey[]>(DOMAIN_KEYS);` and `const [activeDomain, setActiveDomain] = useState<DomainKey>(() => loadActiveDomain(DOMAIN_KEYS));`.
  - Extend the existing load `useEffect` (line ~37) to also fetch config and reconcile:
```ts
  useEffect(() => {
    if (!token) return;
    void Promise.all([api.chains(token), api.useCases(token), api.config(token)]).then(([c, u, cfg]) => {
      setChains(c); setUseCases(u);
      const enabled = (cfg.domains as DomainKey[]).filter((d) => DOMAIN_KEYS.includes(d));
      const eff = enabled.length ? enabled : DOMAIN_KEYS;
      setEnabledDomains(eff);
      setActiveDomain((cur) => (eff.includes(cur) ? cur : loadActiveDomain(eff)));
    }).catch(() => { setEnabledDomains(DOMAIN_KEYS); });
  }, [token]);
```

- [ ] **Step 2: Domain-change handler** — add near `handleSelect`:
```ts
  const onDomainChange = (d: DomainKey): void => {
    setActiveDomain(d);
    saveActiveDomain(d);
    setView(DOMAINS.find((x) => x.key === d)!.defaultView);
  };
  const shellDomains = DOMAINS.filter((d) => enabledDomains.includes(d.key));
```

- [ ] **Step 3: Filter + wire the Platform branch** — in the `isPlatform && !activeUseCase` branch: after `items` is built, filter it, and reconcile `activeId` against the active domain's default so a stale cross-domain view doesn't render blank. Change the final return to:
```tsx
    const visible = itemsForDomain(items, activeDomain);
    const knownIds = [...Object.keys(platViews), "profile", "credentials"];
    const activeId = knownIds.includes(view) && itemsForDomain([{ id: view }], activeDomain).length ? view : DOMAINS.find((d) => d.key === activeDomain)!.defaultView;
    const panel = /* unchanged */ …;
    return <AppShell items={visible} active={activeId} onSelect={handleSelect} domains={shellDomains} activeDomain={activeDomain} onDomainChange={onDomainChange}>{panel}</AppShell>;
```
(Keep the existing `panel` construction as-is; only `items`→`visible`, the `activeId` reconcile, and the three new props change.)

- [ ] **Step 4: Filter + wire the Operator branch** — same treatment on the operator-console return (line ~189):
```tsx
  const visible = itemsForDomain(items, activeDomain);
  const deskIds = visible.map((i) => i.id).filter((id) => id !== "back" && id !== "logout");
  const activeId = deskIds.includes(view) ? view : (deskIds.includes(DOMAINS.find((d) => d.key === activeDomain)!.defaultView) ? DOMAINS.find((d) => d.key === activeDomain)!.defaultView : (deskIds[0] ?? "dashboard"));
  return <AppShell items={visible} active={activeId} onSelect={handleSelect} domains={shellDomains} activeDomain={activeDomain} onDomainChange={onDomainChange}>{panel}</AppShell>;
```
(The operator branch's default view for tokenization is `dashboard`/`assets`; for identity, `identity`. The reconcile keeps `view` if it's in the visible set, else jumps to the domain default, else the first visible desk item. Leave the `panel` if/else chain unchanged — it already handles every `view`.)

- [ ] **Step 5: Leave the Buyer branch untouched** — do NOT pass domain props to the Buyer `AppShell` (line ~101); investors have a single portfolio shell, no domain switch.

- [ ] **Step 6: Verify + commit**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build`
Expected: both clean. Fix all type errors.
```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): domain-split navigation + switcher wiring in the app shell"
```

---

## Task 4: Verify — full suite + live browser walkthrough + finish

**Files:** none.

- [ ] **Step 1: Full workspace gate**

Run: `cd "/Users/kamleshnagware/Tokenlayer XPI" && pnpm -s typecheck && pnpm -s --filter @tokenlayer/api test && pnpm --filter @tokenlayer/web build`
Expected: typecheck clean (all packages); api suite green; web builds. (Core unchanged; optionally `pnpm -s --filter @tokenlayer/core test`.)

- [ ] **Step 2: Boot live stack (fast, UI-focused)** — the domain shell needs no chain: use the fast recipe — a throwaway DB + `CHAIN_STRICT=0`, sourcing only `DID_MASTER_KEY`/`JWT_SECRET`/escrow from `.env`. Start the web preview. (Leave the user's `dev.db` untouched.)

- [ ] **Step 3: Live browser walkthrough (both domains)** — log in as `admin@tokenlayer.dev` (PlatformAdmin): the sidebar shows the **Tokenization ⇄ Identity** switcher. In **Tokenization**, confirm the nav shows Dashboard / Use Cases / Create / Networks (+ Approvals, My Profile). Switch to **Identity**: confirm the nav shows Identity / Organizations / Verification (+ Approvals, My Profile) and the panel jumps to Identity. Reload → the active domain persists. Repeat for an OrgAdmin (their operator console shows Asset Ledger under Tokenization vs Organizations/Verification/Organization Wallet under Identity). Screenshot both domains.

- [ ] **Step 4: Live single-domain deployment** — restart the API with `ENABLED_DOMAINS=identity` (same fast recipe). Log in and confirm **no switcher renders** and only Identity + shared nav is present. (Then optionally `ENABLED_DOMAINS=tokenization` to confirm the reverse.) Screenshot.

- [ ] **Step 5: Finish the branch** — use `superpowers:finishing-a-development-branch` (verify tests pass, then present the options; merge locally to `main` per this program's pattern unless the user chooses otherwise). This completes the 5-part Identity program (ID-A…ID-E).

---

## Self-review checklist (author)

- **Spec coverage:** ENABLED_DOMAINS + GET /config (T1) ✓; domain registry + AppShell switcher + client (T2) ✓; App.tsx nav split + config load + persistence + default-view-on-switch (T3) ✓; live both-domain + single-domain walkthrough (T4) ✓. localStorage persistence, Organizations-under-Identity, Approvals-shared, fail-open visibility all encoded in `NAV_DOMAIN`/`itemsForDomain`. PlatformHome correctly left untouched (dead tab bar; sidebar authoritative) — a justified deviation from the spec's mention of it.
- **Type consistency:** `DomainKey`/`DomainDef`/`NAV_DOMAIN`/`itemsForDomain` (T2 domains.ts) consumed by AppShell props (T2) + App.tsx (T3). `api.config()` → `{ domains: string[] }` (T2) narrowed to `DomainKey[]` in App's load (T3). `enabledDomains` flows env (T1) → AppDeps (T1, 7 sites) → route (T1) → web (T3).
- **No regression:** the Buyer branch is untouched; the panel if/else chains in both branches are unchanged (only `items`→`visible` + `activeId` reconcile + 3 props); AppShell's new props are optional so nothing else breaks; `itemsForDomain` fail-opens unknown ids to shared.
- **Placeholder scan:** none — every step has real code; the "confirm buildTestApp override" note is an explicit implementer check with a defined fallback.
