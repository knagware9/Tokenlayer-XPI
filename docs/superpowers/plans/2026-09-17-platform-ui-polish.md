# Platform UI/UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shared `apps/web` codebase behind all six persona apps (tokenization issuer/marketplace/admin, identity issuer/verifier/holder) read as a deliberately designed enterprise tool — background, motion, visual hierarchy, a cross-app command palette — by fixing the shared layer once rather than hand-touching every screen.

**Architecture:** Three phases, each independently shippable. Phase A upgrades `index.css` and `ui.tsx` (the files every screen already imports) so the fix cascades for free. Phase B adds one new shared component (`CommandPalette.tsx`) wired into `AppShell.tsx`, the one shell all six apps render through. Phase C applies Phase A's new primitives to the five highest-traffic screens, replacing markup that predates them — including consolidating a `animate-slide-up`/`stagger-N` pattern found duplicated verbatim in two files during this plan's own research.

**Tech Stack:** React + TypeScript, Tailwind CSS (utility classes + `@layer components` in `index.css`), Vite. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-platform-ui-polish-design.md`

## Global Constraints

- No new backend routes, no core/API changes — command-palette search reuses `api.useCases`/`api.credentialUseCases`/`api.assets`, which are already persona- and role-scoped server-side.
- No new dependencies (no fuzzy-match library) — `ui.tsx`'s own header states it is "zero-dependency beyond Tailwind + hand-drawn SVG."
- Every existing call site of a changed component (`StatCard`, `MetricBlock`) must keep rendering identically unless a screen explicitly opts into a new prop — all new props are optional and default to current behavior.
- Web tests have no DOM environment in this repo (confirmed by `apps/web/test/lib-boundaries.test.ts` and every existing web test file) — test pure logic only (`lib/*` modules, exported pure functions), verify anything presentational live via the Browser pane.
- Rebuild and redeploy via `docker compose -p xi-tokenization -f docker-compose.tokenization.yml up -d --build <service>-web` / `docker compose -p xi-identity -f docker-compose.identity.yml up -d --build <service>-web` — the pattern already used throughout this project for every prior web change.

---

## Task 1: Background fix

**Files:**
- Modify: `apps/web/src/index.css:20-28`

**Interfaces:**
- Consumes: nothing (pure CSS).
- Produces: nothing other files depend on — `body`'s background is not referenced by class name anywhere else in the codebase (confirmed: no component sets or reads a background-related class tied to this rule).

- [ ] **Step 1: Replace the dotted background**

Current (`apps/web/src/index.css:20-28`):
```css
/* ─── Base typography ─────────────────────────────────────────────────────── */
body {
  @apply antialiased text-slate-800;
  font-family: 'Manrope', 'Segoe UI', system-ui, sans-serif;
  background-color: #EFF8F4;
  background-image:
    radial-gradient(circle at 1px 1px, #c5ddd6 1px, transparent 0);
  background-size: 24px 24px;
}
```
Replace with:
```css
/* ─── Base typography ─────────────────────────────────────────────────────── */
body {
  @apply antialiased text-slate-800;
  font-family: 'Manrope', 'Segoe UI', system-ui, sans-serif;
  background-color: #F6F9F8;
}
```

- [ ] **Step 2: Rebuild the tokenization-admin web container and verify visually**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && \
set -a; . ./.env.personas; set +a; \
docker compose -p xi-tokenization -f docker-compose.tokenization.yml up -d --build tokenization-admin-web
```
Open `http://localhost:8102` in the Browser pane, log in as `admin@tokenlayer.dev` / `admin123`, screenshot the dashboard. Expected: solid off-white background, no dotted grid pattern, no console errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/index.css
git commit -m "fix(web): replace dotted background with solid off-white

The radial-gradient dot pattern is a look strongly associated with
templated/AI-generated SaaS dashboards specifically, and it undercuts
the real type/brand-token system already underneath it."
```

---

## Task 2: `staggerClass` helper

**Files:**
- Modify: `apps/web/src/components/shared/ui.tsx`
- Test: `apps/web/test/stagger-class.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `staggerClass(n?: number): string`, exported from `ui.tsx`. Later tasks (7, 8, 10) import this to replace duplicated inline className logic.

This consolidates a pattern found duplicated verbatim in two files during this plan's research: `apps/web/src/components/tokenization/Dashboard.tsx`'s local `Stat` component (`` `text-left w-full cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md rounded-2xl animate-slide-up ${stagger ? `stagger-${stagger}` : ""}` ``) and `apps/web/src/components/identity/IdentityDashboard.tsx`'s local `Tile` component (`` `text-left w-full bg-white rounded-2xl border p-4 animate-slide-up shadow-sm transition-shadow ${stagger ? `stagger-${stagger}` : ""} ...` ``). Both build the exact same `animate-slide-up`/`stagger-N` fragment independently. `index.css` already defines `stagger-1` through `stagger-7` (`apps/web/src/index.css:83-89`), so this is a pure string-building helper — no new CSS.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/stagger-class.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { staggerClass } from "../src/components/shared/ui.js";

describe("staggerClass", () => {
  it("returns just the animation class when n is undefined", () => {
    expect(staggerClass()).toBe("animate-slide-up");
  });

  it("appends the numbered stagger class when n is given", () => {
    expect(staggerClass(1)).toBe("animate-slide-up stagger-1");
    expect(staggerClass(7)).toBe("animate-slide-up stagger-7");
  });

  it("caps at stagger-7 — index.css defines no class beyond it", () => {
    expect(staggerClass(8)).toBe("animate-slide-up stagger-7");
    expect(staggerClass(20)).toBe("animate-slide-up stagger-7");
  });

  it("treats 0 and negative numbers as undefined (no numbered class)", () => {
    expect(staggerClass(0)).toBe("animate-slide-up");
    expect(staggerClass(-1)).toBe("animate-slide-up");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && npx vitest run apps/web/test/stagger-class.test.ts
```
Expected: FAIL — `staggerClass` is not exported from `ui.tsx` yet.

- [ ] **Step 3: Add `staggerClass` to `ui.tsx`**

Add near the top of `apps/web/src/components/shared/ui.tsx`, after the `import { useState } from "react";` line:
```ts
// ─── staggerClass ─────────────────────────────────────────────────────────────

/**
 * `animate-slide-up`, optionally with a numbered `stagger-N` delay class
 * (index.css defines stagger-1 through stagger-7 — anything outside that
 * range clamps to the nearest end rather than emitting a class that doesn't
 * exist). Extracted because the exact same string was being built
 * independently in Dashboard.tsx's Stat and IdentityDashboard.tsx's Tile.
 */
export function staggerClass(n?: number): string {
  if (!n || n <= 0) return "animate-slide-up";
  const clamped = Math.min(n, 7);
  return `animate-slide-up stagger-${clamped}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && npx vitest run apps/web/test/stagger-class.test.ts
```
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/shared/ui.tsx apps/web/test/stagger-class.test.ts
git commit -m "feat(web): add staggerClass helper, dedup'd from two screens

Dashboard.tsx's Stat and IdentityDashboard.tsx's Tile independently
built the same 'animate-slide-up stagger-N' string. One shared,
tested helper; call sites updated in tasks 7-8, 10."
```

---

## Task 3: `StatCard`/`MetricBlock` motion + `StatCard` emphasis

**Files:**
- Modify: `apps/web/src/components/shared/ui.tsx:399-460`

**Interfaces:**
- Consumes: nothing new.
- Produces: `StatCard` gains optional prop `emphasis?: "primary" | "default"` (defaults to `"default"`, fully back-compat — every existing call site is untouched by this task).

- [ ] **Step 1: Add motion + emphasis to `StatCard`**

Current (`apps/web/src/components/shared/ui.tsx:401-433`):
```tsx
export function StatCard(props: {
  label: string;
  value: string;
  sub?: string;
  icon?: IconName;
  trend?: { direction: "up" | "down" | "flat"; label: string };
}): JSX.Element {
  const { label, value, sub, icon, trend } = props;
  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 flex items-start gap-3 group">
      {icon && (
        <div className="shrink-0 w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center ring-1 ring-brand-100 group-hover:ring-brand-200 transition">
          <Icon name={icon} className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-0.5">{label}</div>
        <div className="text-xl font-bold text-slate-900 leading-7 truncate font-display font-data">{value}</div>
        <div className="flex items-center gap-2 mt-0.5">
          {sub && <div className="text-xs text-slate-400 truncate">{sub}</div>}
          {trend && (
            <span className={`text-[10px] font-semibold ${
              trend.direction === "up"   ? "text-emerald-600" :
              trend.direction === "down" ? "text-red-500" : "text-slate-400"
            }`}>
              {trend.direction === "up" ? "↑" : trend.direction === "down" ? "↓" : "→"} {trend.label}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
```
Replace with:
```tsx
export function StatCard(props: {
  label: string;
  value: string;
  sub?: string;
  icon?: IconName;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  /** "primary" marks this as the screen's headline number — larger value
   *  text, bordered treatment. Defaults to "default" (today's exact look). */
  emphasis?: "primary" | "default";
}): JSX.Element {
  const { label, value, sub, icon, trend, emphasis = "default" } = props;
  const isPrimary = emphasis === "primary";
  return (
    <div
      className={`rounded-2xl p-4 flex items-start gap-3 group ${
        isPrimary
          ? "bg-white border-2 border-brand-400/25 shadow-sm"
          : "bg-white border border-slate-200/80 shadow-sm"
      }`}
    >
      {icon && (
        <div className="shrink-0 w-9 h-9 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center ring-1 ring-brand-100 group-hover:ring-brand-200 transition">
          <Icon name={icon} className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-0.5">{label}</div>
        <div
          className={`font-bold text-slate-900 leading-7 truncate font-display font-data animate-count-in ${
            isPrimary ? "text-3xl" : "text-xl"
          }`}
        >
          {value}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {sub && <div className="text-xs text-slate-400 truncate">{sub}</div>}
          {trend && (
            <span className={`text-[10px] font-semibold ${
              trend.direction === "up"   ? "text-emerald-600" :
              trend.direction === "down" ? "text-red-500" : "text-slate-400"
            }`}>
              {trend.direction === "up" ? "↑" : trend.direction === "down" ? "↓" : "→"} {trend.label}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add motion to `MetricBlock`**

Current (`apps/web/src/components/shared/ui.tsx:452-459`):
```tsx
  return (
    <div className={`flex flex-col gap-0.5 ${props.className ?? ""}`}>
      <div className={`text-2xl font-bold tabular-nums leading-none font-display ${TONE_CLASSES[tone]}`}>
        {typeof props.value === "number" ? props.value.toLocaleString() : props.value}
      </div>
      <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">{props.label}</div>
    </div>
  );
```
Replace with:
```tsx
  return (
    <div className={`flex flex-col gap-0.5 ${props.className ?? ""}`}>
      <div className={`text-2xl font-bold tabular-nums leading-none font-display animate-count-in ${TONE_CLASSES[tone]}`}>
        {typeof props.value === "number" ? props.value.toLocaleString() : props.value}
      </div>
      <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">{props.label}</div>
    </div>
  );
```

- [ ] **Step 3: Typecheck**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/web" && npx tsc --noEmit
```
Expected: clean (no output).

- [ ] **Step 4: Visual verify**

Rebuild `tokenization-admin-web` (same command as Task 1 Step 2), open the dashboard, confirm the four stat tiles' numbers fade/scale in on load (the `count-in` keyframe: `opacity 0→1, scale 0.88→1`) and nothing else regressed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/shared/ui.tsx
git commit -m "feat(web): wire count-in motion into StatCard/MetricBlock

animate-count-in existed in index.css and was applied nowhere.
StatCard also gains an optional emphasis prop (default unchanged) so a
screen can mark one tile as its headline number."
```

---

## Task 4: `TableShell` primitive

**Files:**
- Modify: `apps/web/src/components/shared/ui.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `TableShell(props: { children: React.ReactNode; className?: string }): JSX.Element`, exported from `ui.tsx`. Wraps an existing `<table>...</table>` tree unchanged — it does not replace `<thead>`/`<tbody>`/`<tr>` markup, it wraps the scroll container and applies consistent styling via CSS that targets standard table elements.

- [ ] **Step 1: Add `TableShell` to `ui.tsx`**

Add after the `Pager` function at the end of `apps/web/src/components/shared/ui.tsx`:
```tsx
// ─── TableShell ───────────────────────────────────────────────────────────────

/**
 * Wraps an existing <table> (does not replace its markup) to apply
 * consistent header styling, tabular-nums on numeric cells, a sticky header,
 * and alternating-row hover — without every screen re-deriving the same
 * table CSS by hand. Adopted incrementally, screen by screen (tasks 7-9);
 * deliberately not a data-driven <Table rows columns> abstraction — that
 * would mean rewriting every table call site in one pass.
 */
export function TableShell(props: { children: React.ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`overflow-x-auto rounded-xl border border-slate-100 ${props.className ?? ""}`}>
      <table className="w-full text-xs [&_thead]:sticky [&_thead]:top-0 [&_thead]:bg-slate-50/95 [&_thead]:backdrop-blur-sm [&_thead]:text-[10px] [&_thead]:text-slate-400 [&_thead]:uppercase [&_thead]:tracking-widest [&_th]:text-left [&_th]:font-semibold [&_th]:px-3 [&_th]:py-2.5 [&_tbody_tr]:border-t [&_tbody_tr]:border-slate-100 [&_tbody_tr:hover]:bg-slate-50/70 [&_tbody_tr]:transition-colors [&_td]:px-3 [&_td]:py-2.5 [&_td.num]:text-right [&_td.num]:tabular-nums [&_td.num]:font-data">
        {props.children}
      </table>
    </div>
  );
}
```

Note for tasks 7-9: numeric `<td>` cells need a `num` class added (e.g. `className="num"` or `className="num text-slate-700"`) to pick up the `[&_td.num]` styling — this is documented here so later tasks apply it consistently rather than each screen inventing its own numeric-column convention.

- [ ] **Step 2: Typecheck**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/web" && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/shared/ui.tsx
git commit -m "feat(web): add TableShell primitive

A wrapper (not a rewrite) giving any existing <table> consistent
header/sticky/hover/tabular-nums styling. Adopted incrementally in
tasks 7-9, not applied everywhere in one pass."
```

---

## Task 5: `rankCommandResults` pure ranking function

**Files:**
- Create: `apps/web/src/lib/shared/command-search.ts`
- Test: `apps/web/test/command-search.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface CommandItem {
    id: string;
    label: string;
    sublabel?: string;
    kind: "nav" | "use-case" | "credential-use-case" | "asset";
    onSelect: () => void;
  }
  export function rankCommandResults(query: string, items: CommandItem[]): CommandItem[]
  ```
  Task 6 imports `CommandItem` and `rankCommandResults` from this file.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/command-search.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { rankCommandResults, type CommandItem } from "../src/lib/shared/command-search.js";

function item(id: string, label: string, sublabel?: string): CommandItem {
  return { id, label, sublabel, kind: "use-case", onSelect: () => undefined };
}

describe("rankCommandResults", () => {
  it("returns everything, unranked, for an empty query", () => {
    const items = [item("a", "Alpha"), item("b", "Beta")];
    expect(rankCommandResults("", items)).toEqual(items);
  });

  it("filters out items that match neither label nor sublabel", () => {
    const items = [item("a", "Bamboo Plot"), item("b", "Turmeric Plot")];
    expect(rankCommandResults("bamboo", items).map((i) => i.id)).toEqual(["a"]);
  });

  it("ranks a prefix match on label above a mid-string match", () => {
    const items = [item("a", "Bamboo Plot"), item("b", "Wayanad Bamboo Fund")];
    const ranked = rankCommandResults("bamboo", items);
    expect(ranked.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("is case-insensitive", () => {
    const items = [item("a", "REDD+ Forest Conservation")];
    expect(rankCommandResults("redd", items).map((i) => i.id)).toEqual(["a"]);
    expect(rankCommandResults("REDD", items).map((i) => i.id)).toEqual(["a"]);
  });

  it("matches on sublabel too, ranked below any label match", () => {
    const items = [item("a", "Dairy Cattle Digital Twin", "DCOW"), item("b", "DCOW Loan Program")];
    const ranked = rankCommandResults("dcow", items);
    expect(ranked.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("caps results at 20", () => {
    const items = Array.from({ length: 30 }, (_, i) => item(String(i), `Match ${i}`));
    expect(rankCommandResults("match", items)).toHaveLength(20);
  });

  it("returns an empty array, never throws, for a query matching nothing", () => {
    const items = [item("a", "Alpha")];
    expect(() => rankCommandResults("zzz-nonexistent", items)).not.toThrow();
    expect(rankCommandResults("zzz-nonexistent", items)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && npx vitest run apps/web/test/command-search.test.ts
```
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `command-search.ts`**

Create `apps/web/src/lib/shared/command-search.ts`:
```ts
/**
 * Pure ranking for the command palette (AppShell's CommandPalette). No
 * fuzzy-match library — ui.tsx's own header states this codebase is
 * "zero-dependency beyond Tailwind + hand-drawn SVG," so this is a simple,
 * fully-testable substring/prefix scorer instead.
 */
export interface CommandItem {
  id: string;
  label: string;
  sublabel?: string;
  kind: "nav" | "use-case" | "credential-use-case" | "asset";
  onSelect: () => void;
}

const RESULT_CAP = 20;

/** Higher is better; null means "does not match". */
function scoreField(haystack: string | undefined, needle: string): number | null {
  if (!haystack) return null;
  const h = haystack.toLowerCase();
  if (h === needle) return 100;
  if (h.startsWith(needle)) return 80;
  if (h.includes(needle)) return 40;
  return null;
}

export function rankCommandResults(query: string, items: readonly CommandItem[]): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];

  const scored: { item: CommandItem; score: number }[] = [];
  for (const item of items) {
    const labelScore = scoreField(item.label, q);
    // A sublabel match ranks below any label match at the same tier, so
    // sort by (labelScore ?? 0) first, then total score as the tiebreak.
    const subScore = scoreField(item.sublabel, q);
    if (labelScore === null && subScore === null) continue;
    const total = (labelScore ?? 0) * 2 + (subScore ?? 0);
    scored.push({ item, score: total });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, RESULT_CAP).map((s) => s.item);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && npx vitest run apps/web/test/command-search.test.ts
```
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/shared/command-search.ts apps/web/test/command-search.test.ts
git commit -m "feat(web): add rankCommandResults for the command palette

Pure substring/prefix scorer, no new dependency. Label matches always
outrank sublabel-only matches; prefix beats mid-string."
```

---

## Task 6: `CommandPalette` component + `AppShell` wiring

**Files:**
- Create: `apps/web/src/components/shared/CommandPalette.tsx`
- Modify: `apps/web/src/components/shared/AppShell.tsx`

**Interfaces:**
- Consumes: `CommandItem`, `rankCommandResults` from Task 5 (`apps/web/src/lib/shared/command-search.js`); `NavItem` type already exported from `AppShell.tsx`; `api.useCases`, `api.credentialUseCases`, `api.assets` from `apps/web/src/api.ts` (signatures confirmed: `useCases: (token: string) => Promise<UseCase[]>`, `credentialUseCases: (token: string) => Promise<CredentialUseCase[]>`, `assets: (token: string, useCaseKey?: string) => Promise<Asset[]>`); `activePersona` from `apps/web/src/lib/shared/persona.js`.
- Produces: `CommandPalette(props: { open: boolean; onClose: () => void; navItems: NavItem[]; onSelectNav: (id: string) => void }): JSX.Element`, rendered from `AppShell.tsx`.

- [ ] **Step 1: Create `CommandPalette.tsx`**

Create `apps/web/src/components/shared/CommandPalette.tsx`:
```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { activePersona } from "../../lib/shared/persona.js";
import { rankCommandResults, type CommandItem } from "../../lib/shared/command-search.js";
import { Icon, type IconName } from "./ui.js";
import type { NavItem } from "./AppShell.js";

const KIND_ICON: Record<CommandItem["kind"], IconName> = {
  nav: "layers",
  "use-case": "token",
  "credential-use-case": "shield",
  asset: "coins",
};

/**
 * Global Cmd+K / Ctrl+K search across nav items, use cases and assets.
 * Every data source it calls is an existing, already persona-/role-scoped
 * api method (api.useCases / api.credentialUseCases / api.assets) — this
 * component adds no new authorization surface. It also respects the exact
 * persona-gating this codebase already established for /use-cases: an
 * identity-only persona's edge never serves that route (see App.tsx's
 * useCasesSurfaced), so this palette must not call it there either or it
 * repeats the same doomed-CORS-fetch bug fixed in App.tsx/Organizations.tsx.
 */
export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  navItems: NavItem[];
  onSelectNav: (id: string) => void;
}): JSX.Element | null {
  const { open, onClose, navItems, onSelectNav } = props;
  const { token } = useAuth();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [extra, setExtra] = useState<CommandItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const persona = activePersona();
  const useCasesSurfaced = !persona || persona.surfaces.includes("use-cases");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    const loaders: Promise<CommandItem[]>[] = [];
    if (useCasesSurfaced) {
      loaders.push(
        api.useCases(token).then((rows) =>
          rows.map((u): CommandItem => ({
            id: `uc-${u.key}`, label: u.name, sublabel: u.symbol, kind: "use-case",
            onSelect: () => onSelectNav(u.key),
          })),
        ).catch(() => []),
      );
    }
    loaders.push(
      api.credentialUseCases(token).then((rows) =>
        rows.map((u): CommandItem => ({
          id: `cuc-${u.key}`, label: u.name, sublabel: u.key, kind: "credential-use-case",
          onSelect: () => onSelectNav("identity"),
        })),
      ).catch(() => []),
    );
    if (useCasesSurfaced) {
      loaders.push(
        api.assets(token).then((rows) =>
          rows.map((a): CommandItem => ({
            id: `asset-${a.id}`, label: a.name, sublabel: a.symbol, kind: "asset",
            onSelect: () => onSelectNav(a.useCaseKey),
          })),
        ).catch(() => []),
      );
    }
    void Promise.all(loaders).then((lists) => { if (!cancelled) setExtra(lists.flat()); });
    return () => { cancelled = true; };
  }, [open, token, useCasesSurfaced, onSelectNav]);

  const navAsItems: CommandItem[] = useMemo(
    () => navItems
      .filter((i) => i.id !== "logout")
      .map((i) => ({ id: `nav-${i.id}`, label: i.label, kind: "nav" as const, onSelect: () => onSelectNav(i.id) })),
    [navItems, onSelectNav],
  );

  const allItems = useMemo(() => [...navAsItems, ...extra], [navAsItems, extra]);
  const results = useMemo(() => rankCommandResults(query, allItems), [query, allItems]);
  const shown = query.trim() ? results : navAsItems.slice(0, 8);

  useEffect(() => { setSelected(0); }, [query]);

  function choose(item: CommandItem): void {
    item.onSelect();
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[selected]) choose(shown[selected]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/30 flex items-start justify-center pt-[15vh] p-4 z-50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden animate-fade-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-100">
          <Icon name="filter" className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a use case, asset, or page…"
            className="flex-1 text-sm outline-none placeholder:text-slate-400"
          />
          <kbd className="text-[10px] font-semibold text-slate-400 bg-slate-100 rounded px-1.5 py-0.5">Esc</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto py-1.5">
          {shown.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-slate-400">No matches for "{query}"</div>
          )}
          {shown.map((item, i) => (
            <button
              key={item.id}
              type="button"
              onClick={() => choose(item)}
              onMouseEnter={() => setSelected(i)}
              className={`w-full flex items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors ${
                i === selected ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-50"
              }`}
            >
              <Icon name={KIND_ICON[item.kind]} className={`w-4 h-4 shrink-0 ${i === selected ? "text-brand-500" : "text-slate-400"}`} />
              <span className="truncate">{item.label}</span>
              {item.sublabel && <span className="text-xs text-slate-400 shrink-0">{item.sublabel}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the trigger + keyboard shortcut into `AppShell.tsx`**

In `apps/web/src/components/shared/AppShell.tsx`, add the import (after the existing `Icon` import at line 8):
```ts
import { CommandPalette } from "./CommandPalette.js";
```

Add state and the global keydown listener inside the `AppShell` function, right after the existing `const orgLogo = useOrgLogo(...)` line (currently line 104):
```ts
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
```
`AppShell.tsx:1` already reads `import { useEffect, useRef, useState } from "react";` — `useState` is already imported, no change needed there.

Replace the top bar (`apps/web/src/components/shared/AppShell.tsx:205-213`):
```tsx
        <div className="h-14 border-b border-slate-200/80 bg-white/50 backdrop-blur-sm flex items-center justify-end px-6 gap-3">
          <div className="text-xs font-medium text-slate-500 truncate" style={{ fontFamily: "'Manrope', system-ui, sans-serif" }}>{user?.email}</div>
          {user?.role && (
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-semibold text-brand-600 bg-brand-50 border border-brand-200/60 rounded-full px-2.5 py-1 whitespace-nowrap" style={{ fontFamily: "'Manrope', system-ui, sans-serif" }}>
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" aria-hidden="true" />
              {user.role}
            </span>
          )}
        </div>
```
with:
```tsx
        <div className="h-14 border-b border-slate-200/80 bg-white/50 backdrop-blur-sm flex items-center justify-between px-6 gap-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-2 text-xs text-slate-400 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5 transition-colors"
          >
            <Icon name="filter" className="w-3.5 h-3.5" />
            <span>Search…</span>
            <kbd className="ml-2 text-[10px] font-semibold bg-white border border-slate-200 rounded px-1.5">⌘K</kbd>
          </button>
          <div className="flex items-center gap-3">
            <div className="text-xs font-medium text-slate-500 truncate" style={{ fontFamily: "'Manrope', system-ui, sans-serif" }}>{user?.email}</div>
            {user?.role && (
              <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-semibold text-brand-600 bg-brand-50 border border-brand-200/60 rounded-full px-2.5 py-1 whitespace-nowrap" style={{ fontFamily: "'Manrope', system-ui, sans-serif" }}>
                <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" aria-hidden="true" />
                {user.role}
              </span>
            )}
          </div>
        </div>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} navItems={shown} onSelectNav={(id) => { onSelect(id); setPaletteOpen(false); }} />
```

- [ ] **Step 3: Typecheck**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/web" && npx tsc --noEmit
```
Expected: clean. If `useState` was missing from `AppShell.tsx`'s React import, this step will surface it — add it to the existing import line.

- [ ] **Step 4: Build**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/web" && npx vite build
```
Expected: succeeds (the existing >500kB chunk-size warning is pre-existing and unrelated — not a failure).

- [ ] **Step 5: Rebuild and live-verify on one tokenization persona and one identity persona**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && \
set -a; . ./.env.personas; set +a; \
docker compose -p xi-tokenization -f docker-compose.tokenization.yml up -d --build tokenization-admin-web && \
docker compose -p xi-identity -f docker-compose.identity.yml up -d --build identity-issuer-web
```
On `http://localhost:8102` (tokenization-admin): press `Cmd+K`/`Ctrl+K`, confirm the palette opens, type a known use-case name (e.g. "bamboo"), confirm it appears and Enter navigates to it, confirm Escape closes it.
On `http://localhost:8090` (identity-issuer): repeat — press `Cmd+K`, confirm it opens, type "impact" (matches the Impact Investor Accreditation credential use case), confirm no CORS error appears in the console (this is the exact failure mode fixed in commit `dfe92df` for `App.tsx`/`Organizations.tsx` — this task's `useCasesSurfaced` gate exists specifically to not reintroduce it).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/shared/CommandPalette.tsx apps/web/src/components/shared/AppShell.tsx
git commit -m "feat(web): add Cmd+K command palette, shared across all six apps

Searches nav items + use cases + credential use cases + assets, all
via api methods the app already calls (already scoped server-side).
Gated the same way App.tsx/Organizations.tsx already gate /use-cases
for identity-only personas, so this doesn't reintroduce the doomed-
CORS-fetch bug fixed in dfe92df."
```

---

## Task 7: Apply `TableShell` + `staggerClass` to the Platform Admin dashboard

**Files:**
- Modify: `apps/web/src/components/tokenization/Dashboard.tsx`

**Interfaces:**
- Consumes: `staggerClass` (Task 2), `TableShell` (Task 4), `StatCard`'s `emphasis` prop (Task 3) — all from `ui.tsx`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Replace the local `Stat` wrapper's duplicated className with `staggerClass`**

Current (`apps/web/src/components/tokenization/Dashboard.tsx:486-494`):
```tsx
function Stat({ icon, label, value, sub, onClick, stagger }: { icon: IconName; label: string; value: string; sub?: string; onClick?: () => void; stagger?: number }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left w-full cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md rounded-2xl animate-slide-up ${stagger ? `stagger-${stagger}` : ""}`}
    >
      <StatCard icon={icon} label={label} value={value} sub={sub} />
    </button>
  );
}
```
Replace with:
```tsx
function Stat({ icon, label, value, sub, onClick, stagger, primary }: { icon: IconName; label: string; value: string; sub?: string; onClick?: () => void; stagger?: number; primary?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left w-full cursor-pointer transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md rounded-2xl ${staggerClass(stagger)}`}
    >
      <StatCard icon={icon} label={label} value={value} sub={sub} emphasis={primary ? "primary" : "default"} />
    </button>
  );
}
```

- [ ] **Step 2: Mark "Total supply" as the primary tile**

Current (`apps/web/src/components/tokenization/Dashboard.tsx:251-256`):
```tsx
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat icon="coins" label="Tokenized value" value={fmtMoney(t.valueByCurrency)} sub={`${t.assets} assets · ${t.useCases} use case${t.useCases === 1 ? "" : "s"}`} onClick={() => openAssets("all")} stagger={1} />
        <Stat icon="spark" label="Total supply" value={fmtInt(t.supply)} sub="minted − burned" onClick={() => openAssets("all")} stagger={2} />
        <Stat icon="users" label="Holders" value={String(t.holders)} sub="distinct accounts" onClick={openHolders} stagger={3} />
        <Stat icon="arrow" label={`Traded (${data.activity.length}d)`} value={fmtMoney(t.tradedByCurrency)} sub={`${t.trades} trade${t.trades === 1 ? "" : "s"}`} onClick={() => scrollTo("dash-recent")} stagger={4} />
      </div>
```
Replace with:
```tsx
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat icon="coins" label="Tokenized value" value={fmtMoney(t.valueByCurrency)} sub={`${t.assets} assets · ${t.useCases} use case${t.useCases === 1 ? "" : "s"}`} onClick={() => openAssets("all")} stagger={1} />
        <Stat icon="spark" label="Total supply" value={fmtInt(t.supply)} sub="minted − burned" onClick={() => openAssets("all")} stagger={2} primary />
        <Stat icon="users" label="Holders" value={String(t.holders)} sub="distinct accounts" onClick={openHolders} stagger={3} />
        <Stat icon="arrow" label={`Traded (${data.activity.length}d)`} value={fmtMoney(t.tradedByCurrency)} sub={`${t.trades} trade${t.trades === 1 ? "" : "s"}`} onClick={() => scrollTo("dash-recent")} stagger={4} />
      </div>
```

- [ ] **Step 3: Wrap the "By use case" table in `TableShell`, mark numeric columns**

Current (`apps/web/src/components/tokenization/Dashboard.tsx:403-436`):
```tsx
          <Card title="By use case">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[10px] text-slate-400 bg-slate-50/80 uppercase tracking-widest">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2.5">Use case</th>
                    <th className="text-left font-semibold px-3 py-2.5">Ledger</th>
                    <th className="text-right font-semibold px-3 py-2.5">Supply</th>
                    <th className="text-right font-semibold px-3 py-2.5">Holders</th>
                    <th className="text-right font-semibold px-3 py-2.5">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byUseCase.map((u) => (
                    <tr key={u.useCaseKey} onClick={() => navigate(`/${u.useCaseKey}`)} title={`Open ${u.name}`}
                      className="border-t border-slate-100 cursor-pointer hover:bg-slate-50/70 transition-colors">
                      <td className="px-3 py-2.5 font-medium text-slate-800">
                        {u.name} <span className="font-normal text-slate-400">{u.symbol}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorFor(u.chainId) }} />
                          <span className="text-slate-600">{u.chainId}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-data tabular-nums text-slate-700">{fmtInt(u.supply)}</td>
                      <td className="px-3 py-2.5 text-right font-data tabular-nums text-slate-700">{u.holders}</td>
                      <td className="px-3 py-2.5 text-right text-slate-600">{fmtMoney(u.valueByCurrency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
```
Replace with:
```tsx
          <Card title="By use case">
            <TableShell>
              <thead>
                <tr>
                  <th>Use case</th>
                  <th>Ledger</th>
                  <th>Supply</th>
                  <th>Holders</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {data.byUseCase.map((u) => (
                  <tr key={u.useCaseKey} onClick={() => navigate(`/${u.useCaseKey}`)} title={`Open ${u.name}`} className="cursor-pointer">
                    <td className="font-medium text-slate-800">
                      {u.name} <span className="font-normal text-slate-400">{u.symbol}</span>
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorFor(u.chainId) }} />
                        <span className="text-slate-600">{u.chainId}</span>
                      </span>
                    </td>
                    <td className="num text-slate-700">{fmtInt(u.supply)}</td>
                    <td className="num text-slate-700">{u.holders}</td>
                    <td className="num text-slate-600">{fmtMoney(u.valueByCurrency)}</td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </Card>
```
Note: the `<th>` elements no longer need explicit `text-left`/`text-right` classes — `TableShell`'s `[&_th]` rule already left-aligns every header; the numeric-column headers ("Supply", "Holders", "Value") stay visually left-aligned in the header row while their data cells right-align via `.num` — this is a deliberate, common table convention (Jira's own tables do this), not an oversight.

- [ ] **Step 4: Update the import line**

Current (`apps/web/src/components/tokenization/Dashboard.tsx:9`):
```ts
import { Card, EmptyState, Pager, Pill, Skeleton, StatCard, type IconName } from "../shared/ui.js";
```
Replace with:
```ts
import { Card, EmptyState, Pager, Pill, Skeleton, StatCard, TableShell, staggerClass, type IconName } from "../shared/ui.js";
```

- [ ] **Step 5: Typecheck and build**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/web" && npx tsc --noEmit && npx vite build
```
Expected: both clean.

- [ ] **Step 6: Rebuild and visually verify**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && \
set -a; . ./.env.personas; set +a; \
docker compose -p xi-tokenization -f docker-compose.tokenization.yml up -d --build tokenization-admin-web
```
Open `http://localhost:8102`, confirm: "Total supply" tile visibly larger/bordered than its three siblings; the four tiles stagger in on load; the "By use case" table has a sticky header, hover rows, right-aligned numeric columns; clicking a row still navigates (unchanged behavior).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/tokenization/Dashboard.tsx
git commit -m "refactor(web): adopt staggerClass/TableShell/emphasis on the Platform Admin dashboard

Total supply marked as the headline stat; By-use-case table gets
sticky header + consistent hover/numeric styling via TableShell."
```

---

## Task 8: Apply `staggerClass` + `TableShell` to the Identity Dashboard

**Files:**
- Modify: `apps/web/src/components/identity/IdentityDashboard.tsx`

**Interfaces:**
- Consumes: `staggerClass`, `TableShell` from Task 2/4.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Replace the local `Tile` component's duplicated className with `staggerClass`**

Current (`apps/web/src/components/identity/IdentityDashboard.tsx:36-46`):
```tsx
function Tile({ label, value, tone, stagger, active, onClick }: { label: string; value: number; tone?: string; stagger?: number; active?: boolean; onClick?: () => void }): JSX.Element {
  const shared = `text-left w-full bg-white rounded-2xl border p-4 animate-slide-up shadow-sm transition-shadow ${stagger ? `stagger-${stagger}` : ""} ${active ? "border-brand-400 ring-1 ring-brand-300" : "border-slate-200/80"}`;
  const body = (
    <>
      <div className={`text-2xl font-bold tabular-nums font-display ${tone ?? "text-slate-900"}`}>{value.toLocaleString()}</div>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mt-1">{label}</div>
    </>
  );
  if (!onClick) return <div className={shared}>{body}</div>;
  return <button type="button" onClick={onClick} className={`${shared} hover:shadow hover:border-slate-300 cursor-pointer`}>{body}</button>;
}
```
Replace with:
```tsx
function Tile({ label, value, tone, stagger, active, onClick }: { label: string; value: number; tone?: string; stagger?: number; active?: boolean; onClick?: () => void }): JSX.Element {
  const shared = `text-left w-full bg-white rounded-2xl border p-4 shadow-sm transition-shadow ${staggerClass(stagger)} ${active ? "border-brand-400 ring-1 ring-brand-300" : "border-slate-200/80"}`;
  const body = (
    <>
      <div className={`text-2xl font-bold tabular-nums font-display animate-count-in ${tone ?? "text-slate-900"}`}>{value.toLocaleString()}</div>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mt-1">{label}</div>
    </>
  );
  if (!onClick) return <div className={shared}>{body}</div>;
  return <button type="button" onClick={onClick} className={`${shared} hover:shadow hover:border-slate-300 cursor-pointer`}>{body}</button>;
}
```
(Also added `animate-count-in` to the value, matching Task 3's `StatCard`/`MetricBlock` treatment, since this file has its own local tile rather than using the shared one.)

- [ ] **Step 2: Wrap the credential status board table in `TableShell`**

Current (`apps/web/src/components/identity/IdentityDashboard.tsx:372-407`):
```tsx
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="text-[10px] text-slate-400 bg-slate-50/80 uppercase tracking-widest">
              <tr>
                <th className="text-left font-semibold px-3 py-2.5">Holder</th>
                <th className="text-left font-semibold px-3 py-2.5">Credential</th>
                <th className="text-left font-semibold px-3 py-2.5">Use case</th>
                <th className="text-left font-semibold px-3 py-2.5">Issued</th>
                <th className="text-left font-semibold px-3 py-2.5">Expires</th>
                <th className="text-left font-semibold px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((r) => (
                <tr key={r.credentialId} className="border-t border-slate-100 hover:bg-slate-50/70 transition-colors">
                  <td className="px-3 py-2 text-slate-700 font-medium text-xs">{r.holderLabel}</td>
                  <td className="px-3 py-2 text-slate-700 text-xs">{r.type}</td>
                  <td className="px-3 py-2 text-slate-400 text-xs">{r.useCaseName}</td>
                  <td className="px-3 py-2 text-slate-400 text-xs font-data">{new Date(r.issuedAt).toLocaleDateString()}</td>
                  <td className="px-3 py-2 text-slate-400 text-xs font-data">{r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : "—"}</td>
                  <td className="px-3 py-2">
                    <StatusPill status={r.status} />
                    {r.acceptanceNote && <div className="text-[11px] text-rose-500 mt-0.5">{r.acceptanceNote}</div>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px]" onClick={() => setBoardDetailId(r.credentialId)}>View</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400 text-xs">No credentials match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
```
Replace with:
```tsx
        <TableShell>
          <thead>
            <tr>
              <th>Holder</th>
              <th>Credential</th>
              <th>Use case</th>
              <th>Issued</th>
              <th>Expires</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pagedRows.map((r) => (
              <tr key={r.credentialId}>
                <td className="text-slate-700 font-medium">{r.holderLabel}</td>
                <td className="text-slate-700">{r.type}</td>
                <td className="text-slate-400">{r.useCaseName}</td>
                <td className="text-slate-400 font-data">{new Date(r.issuedAt).toLocaleDateString()}</td>
                <td className="text-slate-400 font-data">{r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : "—"}</td>
                <td>
                  <StatusPill status={r.status} />
                  {r.acceptanceNote && <div className="text-[11px] text-rose-500 mt-0.5">{r.acceptanceNote}</div>}
                </td>
                <td className="text-right">
                  <button className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px]" onClick={() => setBoardDetailId(r.credentialId)}>View</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No credentials match.</td></tr>
            )}
          </tbody>
        </TableShell>
```
Note: `text-xs` was on the old `<table>` itself; `TableShell` already sets `text-xs` on its own `<table>` element, so no size regression.

- [ ] **Step 3: Update the import line**

Current (`apps/web/src/components/identity/IdentityDashboard.tsx:5`):
```ts
import { Pager, SectionHeader } from "../shared/ui.js";
```
Replace with:
```ts
import { Pager, SectionHeader, TableShell, staggerClass } from "../shared/ui.js";
```

- [ ] **Step 4: Typecheck and build**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/web" && npx tsc --noEmit && npx vite build
```
Expected: both clean.

- [ ] **Step 5: Rebuild and visually verify**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && \
set -a; . ./.env.personas; set +a; \
docker compose -p xi-identity -f docker-compose.identity.yml up -d --build identity-issuer-web
```
Open `http://localhost:8090`, navigate to Identity Dashboard, confirm: the 7 lifecycle tiles stagger in and their numbers count in, the credential status board table has a sticky header and hover rows, clicking a tile still filters the board (unchanged behavior — verify by clicking "Accepted" and confirming the board filters).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/identity/IdentityDashboard.tsx
git commit -m "refactor(web): adopt staggerClass/TableShell on the Identity Dashboard

Same consolidation as the tokenization dashboard (Task 7) — this file
had its own independently-duplicated stagger className logic, now
using the shared helper."
```

---

## Task 9: Apply `TableShell` to the AssetDetail market table

**Files:**
- Modify: `apps/web/src/components/tokenization/AssetDetail.tsx`

**Interfaces:**
- Consumes: `TableShell` from Task 4.
- Produces: nothing other tasks depend on.

Note for context: this file has its own local `Pill` wrapper (`AssetDetail.tsx:1125-1132`, `tone: "red" | "green" | "gray"`) that maps to the shared `ui.tsx` `Pill`'s tones (`gray → "muted"`) — the `<Pill tone="gray">` call at line 787 is this file's own correctly-typed component, not the shared one, and is not a bug. (An earlier pass at this plan mistakenly flagged it as one before checking for a local wrapper — corrected here.)

- [ ] **Step 1: Wrap the "Open asks" table in `TableShell`**

Current (`apps/web/src/components/tokenization/AssetDetail.tsx:771-824`):
```tsx
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Open asks</div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-400 text-[11px] uppercase">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Seller</th>
                  <th className="text-right font-medium px-3 py-2">Remaining</th>
                  <th className="text-right font-medium px-3 py-2">Unit price</th>
                  {canBuy && <th className="text-right font-medium px-3 py-2">Take</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {listings.map((l) => {
                  const own = wallet !== null && l.seller.toLowerCase() === wallet;
                  return (
                    <tr key={l.id}>
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{short(l.seller)}{own && <Pill tone="gray">you</Pill>}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700">{l.quantity}</td>
                      <td className="px-3 py-2 text-right text-slate-700">{l.unitPrice} {l.currency}</td>
                      {canBuy && (
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1.5">
                            <input
                              className="input w-20 text-xs"
                              type="number"
                              min="1"
                              step="1"
                              placeholder="Qty"
                              disabled={own}
                              value={takeQty[l.id] ?? ""}
                              onChange={(e) => setTakeQty((s) => ({ ...s, [l.id]: e.target.value }))}
                            />
                            <button
                              disabled={busy || own || !posInt(takeQty[l.id] ?? "")}
                              title={own ? "your listing" : undefined}
                              onClick={() => void doTake(l)}
                              className="btn-sm border-slate-200 text-slate-600 hover:border-brand-500 disabled:opacity-40"
                            >
                              Take
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {listings.length === 0 && (
                  <tr>
                    <td colSpan={canBuy ? 4 : 3} className="px-3 py-3 text-center text-sm text-slate-400">No open asks.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
```
Replace with:
```tsx
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Open asks</div>
            <TableShell>
              <thead>
                <tr>
                  <th>Seller</th>
                  <th>Remaining</th>
                  <th>Unit price</th>
                  {canBuy && <th>Take</th>}
                </tr>
              </thead>
              <tbody>
                {listings.map((l) => {
                  const own = wallet !== null && l.seller.toLowerCase() === wallet;
                  return (
                    <tr key={l.id}>
                      <td className="font-mono text-[11px] text-slate-500">{short(l.seller)}{own && <Pill tone="gray">you</Pill>}</td>
                      <td className="num font-mono text-slate-700">{l.quantity}</td>
                      <td className="num text-slate-700">{l.unitPrice} {l.currency}</td>
                      {canBuy && (
                        <td>
                          <div className="flex justify-end gap-1.5">
                            <input
                              className="input w-20 text-xs"
                              type="number"
                              min="1"
                              step="1"
                              placeholder="Qty"
                              disabled={own}
                              value={takeQty[l.id] ?? ""}
                              onChange={(e) => setTakeQty((s) => ({ ...s, [l.id]: e.target.value }))}
                            />
                            <button
                              disabled={busy || own || !posInt(takeQty[l.id] ?? "")}
                              title={own ? "your listing" : undefined}
                              onClick={() => void doTake(l)}
                              className="btn-sm border-slate-200 text-slate-600 hover:border-brand-500 disabled:opacity-40"
                            >
                              Take
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {listings.length === 0 && (
                  <tr>
                    <td colSpan={canBuy ? 4 : 3} className="px-3 py-3 text-center text-sm text-slate-400">No open asks.</td>
                  </tr>
                )}
              </tbody>
            </TableShell>
          </div>
```

- [ ] **Step 2: Update the import line**

Current (`apps/web/src/components/tokenization/AssetDetail.tsx:7`):
```ts
import { DataBadge, EmptyState, Icon, Pill as UIPill, Skeleton, type IconName } from "../shared/ui.js";
```
Replace with:
```ts
import { DataBadge, EmptyState, Icon, Pill as UIPill, Skeleton, TableShell, type IconName } from "../shared/ui.js";
```

- [ ] **Step 3: Typecheck and build**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/web" && npx tsc --noEmit && npx vite build
```
Expected: both clean.

- [ ] **Step 4: Rebuild and visually verify**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && \
set -a; . ./.env.personas; set +a; \
docker compose -p xi-tokenization -f docker-compose.tokenization.yml up -d --build tokenization-marketplace-web
```
Open `http://localhost:8101`, navigate to an asset with open listings (e.g. the bamboo-plot listing already created earlier this session), confirm the "you" pill on your own listing still renders correctly, confirm the table now has sticky-header/hover styling and the numeric columns stay right-aligned.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tokenization/AssetDetail.tsx
git commit -m "refactor(web): adopt TableShell on the AssetDetail open-asks table"
```

---

## Task 10: Apply `staggerClass` to the two builder review steps

**Files:**
- Modify: `apps/web/src/components/tokenization/UseCaseBuilder.tsx:928-935` and `:672-694`
- Modify: `apps/web/src/components/identity/CredentialUseCaseBuilder.tsx:789-796` and `:660-685`

**Interfaces:**
- Consumes: `staggerClass` from Task 2.
- Produces: nothing other tasks depend on.

Confirmed during planning: `CredentialUseCaseBuilder.tsx` has its own local `SummaryTile`, byte-identical to `UseCaseBuilder.tsx`'s (the two builders are separate files with no cross-import, per this codebase's product-split convention) — both need the same change, independently.

- [ ] **Step 1: Add stagger to `SummaryTile` in `UseCaseBuilder.tsx`**

Current (`apps/web/src/components/tokenization/UseCaseBuilder.tsx:928-935`):
```tsx
function SummaryTile({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400 mb-1.5">{label}</div>
      {children}
    </div>
  );
}
```
Replace with:
```tsx
function SummaryTile({ label, children, stagger }: { label: string; children: React.ReactNode; stagger?: number }): JSX.Element {
  return (
    <div className={`rounded-xl border border-slate-200 p-3 ${staggerClass(stagger)}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400 mb-1.5">{label}</div>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Pass incrementing `stagger` values at `UseCaseBuilder.tsx`'s four call sites**

Current (`apps/web/src/components/tokenization/UseCaseBuilder.tsx:672-694`):
```tsx
                <SummaryTile label="Basics">
```
```tsx
                <SummaryTile label="Ledgers">
```
```tsx
                <SummaryTile label="Fields">
```
```tsx
                <SummaryTile label="Rules">
```
Replace each opening tag with, respectively:
```tsx
                <SummaryTile label="Basics" stagger={1}>
```
```tsx
                <SummaryTile label="Ledgers" stagger={2}>
```
```tsx
                <SummaryTile label="Fields" stagger={3}>
```
```tsx
                <SummaryTile label="Rules" stagger={4}>
```

- [ ] **Step 3: Add the import in `UseCaseBuilder.tsx`**

Find this file's existing `ui.js` import line and add `staggerClass` to it (same pattern as Task 7 Step 4).

- [ ] **Step 4: Add stagger to `SummaryTile` in `CredentialUseCaseBuilder.tsx`**

Current (`apps/web/src/components/identity/CredentialUseCaseBuilder.tsx:789-796`):
```tsx
function SummaryTile({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400 mb-1.5">{label}</div>
      {children}
    </div>
  );
}
```
Replace with:
```tsx
function SummaryTile({ label, children, stagger }: { label: string; children: React.ReactNode; stagger?: number }): JSX.Element {
  return (
    <div className={`rounded-xl border border-slate-200 p-3 ${staggerClass(stagger)}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400 mb-1.5">{label}</div>
      {children}
    </div>
  );
}
```

- [ ] **Step 5: Pass incrementing `stagger` values at `CredentialUseCaseBuilder.tsx`'s five call sites**

Current (`apps/web/src/components/identity/CredentialUseCaseBuilder.tsx:661-683`):
```tsx
                <SummaryTile label="Basics">
```
```tsx
                <SummaryTile label="Credential types">
```
```tsx
                <SummaryTile label="Issuer">
```
```tsx
                <SummaryTile label="Holders">
```
```tsx
                <SummaryTile label="Verifiers">
```
Replace each opening tag with, respectively:
```tsx
                <SummaryTile label="Basics" stagger={1}>
```
```tsx
                <SummaryTile label="Credential types" stagger={2}>
```
```tsx
                <SummaryTile label="Issuer" stagger={3}>
```
```tsx
                <SummaryTile label="Holders" stagger={4}>
```
```tsx
                <SummaryTile label="Verifiers" stagger={5}>
```

- [ ] **Step 6: Add the import in `CredentialUseCaseBuilder.tsx`**

Current (`apps/web/src/components/identity/CredentialUseCaseBuilder.tsx:8`):
```ts
import { Icon } from "../shared/ui.js";
```
Replace with:
```ts
import { Icon, staggerClass } from "../shared/ui.js";
```

- [ ] **Step 7: Typecheck and build**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/web" && npx tsc --noEmit && npx vite build
```
Expected: both clean.

- [ ] **Step 8: Rebuild and visually verify both builders' review steps**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && \
set -a; . ./.env.personas; set +a; \
docker compose -p xi-tokenization -f docker-compose.tokenization.yml up -d --build tokenization-issuer-web && \
docker compose -p xi-identity -f docker-compose.identity.yml up -d --build identity-issuer-web
```
Open `http://localhost:8100`, start creating a use case, reach the Review step, confirm the 4 summary tiles stagger in. Open `http://localhost:8090`, start creating a credential use case, reach its Review step, confirm the 5 summary tiles stagger in.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/tokenization/UseCaseBuilder.tsx apps/web/src/components/identity/CredentialUseCaseBuilder.tsx
git commit -m "feat(web): stagger the review-step summary tiles in both builders"
```

---

## Task 11: Full verification and final rebuild

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full web test suite**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && npx vitest run apps/web/test/ --exclude "**/.claude/worktrees/**"
```
Expected: every prior web test count (271 before this plan) plus the new tests from Tasks 2 and 5 (4 + 7 = 11 new), all passing — 282/282.

- [ ] **Step 2: Typecheck and build one final time**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/web" && npx tsc --noEmit && npx vite build
```
Expected: both clean.

- [ ] **Step 3: Rebuild all six persona-web containers**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI" && \
set -a; . ./.env.personas; set +a; \
docker compose -p xi-tokenization -f docker-compose.tokenization.yml up -d --build tokenization-issuer-web tokenization-marketplace-web tokenization-admin-web && \
docker compose -p xi-identity -f docker-compose.identity.yml up -d --build identity-issuer-web identity-verifier-web identity-holder-web
```

- [ ] **Step 4: Live-verify each of the six apps loads with no console errors**

For each of `http://localhost:8100` (tokenization-issuer), `8101` (tokenization-marketplace), `8102` (tokenization-admin), `8090` (identity-issuer), `8091` (identity-verifier), `8092` (identity-holder): open it in the Browser pane, log in, check `read_console_messages` for errors (use a freshly-created tab per app — a long-lived tab's console listener can retain stale entries across same-URL navigations, as discovered earlier this session), confirm the solid background, confirm `Cmd+K` opens the command palette.

- [ ] **Step 5: Commit any final fixups only if Step 4 found something; otherwise this task produces no commit — the plan is complete.**
