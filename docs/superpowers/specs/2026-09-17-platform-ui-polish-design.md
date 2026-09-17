# Platform UI/UX Polish — Design

**Version:** 1.0
**Date:** 2026-09-17
**Scope:** `apps/web` — the single shared codebase behind all six persona apps (tokenization issuer/marketplace/admin, identity issuer/verifier/holder)
**Status:** Design. Not yet approved for implementation.

---

## 1. Problem statement

The platform's UI is functionally complete and visually *consistent* across both products, but it reads as competent-default SaaS rather than a deliberately designed enterprise tool. This was diagnosed by actually opening the Platform Admin dashboard and the Identity issuer console side by side (screenshots taken 2026-09-17) rather than assumed from the code.

What's actually there is better than a first glance suggests: a real type pairing (Bricolage Grotesque for headings, Manrope for body, JetBrains Mono for data — `apps/web/src/index.css`), a CSS-variable brand-color system already built for per-org overriding (`--brand-50`…`--brand-700`), a 30-icon hand-drawn SVG set (`ui.tsx`'s `ICON_PATHS`, not a generic library), and five already-defined animation keyframes (`slide-up`, `fade-in`, `shimmer`, `pulse-ring`, `bar-grow`, `count-in`). The primitive library (`Card`, `StatCard`, `MetricBlock`, `Pill`, `EmptyState`, `Skeleton`, `DataBadge`, `Pager`) is more mature than a typical internal-tool component set.

Three concrete gaps make it read as generic anyway:

1. **The body background** (`index.css` — a dotted radial-gradient mint grid) is a pattern strongly associated with templated/AI-generated SaaS dashboards specifically. It's the first thing a viewer's eye registers, and it undercuts everything more considered sitting underneath it.
2. **The defined motion is unused.** `animate-count-in`, `animate-slide-up`, and the `metric-shimmer` gradient-text utility exist in CSS but are wired into zero of the shared primitives that would use them (`StatCard`, `MetricBlock`). The CSS cost of fixing this is already paid; only the wiring is missing.
3. **No visual hierarchy mechanism.** `StatCard` and `Card` render every instance at identical weight — there's no way for a screen to say "this number is the headline" versus "this is supporting detail," which is a big part of why dashboards read as flat.

A fourth, separate gap: there's no cross-app **navigation/search affordance**. Jira/Linear-tier tools let an operator jump to any object without hunting through nav; this platform has no equivalent at all today.

## 2. Goals and non-goals

**Goals**
- Fix the background and wire up existing motion — platform-wide, from one file each, essentially free.
- Give the primitive library a real hierarchy mechanism (primary vs. secondary emphasis) and a lightweight table-styling wrapper, adopted incrementally.
- Ship a `⌘K` command palette shared across all six apps, searching nav + use cases + assets, respecting existing persona/domain scoping automatically.
- Apply the upgraded primitives to the handful of highest-traffic screens so the improvement is visible immediately, not just theoretically available.

**Non-goals**
- No visual-identity reset. The type pairing and brand-token system are good; this sharpens what's there rather than replacing it.
- No new backend routes, no core/API changes. Command-palette search reuses existing `api.useCases`/`api.credentialUseCases`/`api.assets` calls, which are already persona- and role-scoped server-side.
- No attempt to hand-touch every screen in one pass. Screens not explicitly listed in §6 inherit the improvement only when someone next touches them and reaches for the (now-better) shared primitives — that's an acceptable, honest scope boundary, not an oversight.
- No drag-and-drop, no board view. "Jira-like" here means density/hierarchy/motion/search, not literally rebuilding Jira's board.

## 3. Architecture

Everything lives in `apps/web/src/`. No new top-level modules; the changes land in the three files the whole platform already shares, plus one new file for the command palette and one new pure module for its search logic (the only genuinely new surface).

```
apps/web/src/
  index.css                          — background fix (§4.1), no new keyframes needed
  components/shared/
    ui.tsx                           — StatCard/MetricBlock motion + emphasis (§4.2),
                                        new Stagger + TableShell primitives (§4.3)
    AppShell.tsx                     — command-palette trigger in the top bar (§5)
    CommandPalette.tsx               — NEW: the palette itself (§5)
  lib/shared/
    command-search.ts                — NEW: pure fuzzy-filter/rank fn (testable)
```

Sequenced in three phases, each independently shippable and each leaving the app in a fully working state:

- **Phase A (§4):** background + motion wiring + hierarchy/table primitives in the shared layer. Touches 2 files. Every screen using `StatCard`/`MetricBlock` gets the motion for free the moment this merges — no per-screen work required.
- **Phase B (§5):** command palette. One new component, one new pure module, a small addition to `AppShell.tsx`'s top bar. Appears identically in all six apps because `AppShell` is the one shell they all render through.
- **Phase C (§6):** apply Phase A's new primitive props to the 5 highest-traffic screens, replacing ad-hoc markup that predates the hierarchy/table primitives.

## 4. Phase A — shared-layer fixes

### 4.1 Background (`index.css`)

Replace:
```css
background-color: #EFF8F4;
background-image:
  radial-gradient(circle at 1px 1px, #c5ddd6 1px, transparent 0);
background-size: 24px 24px;
```
with a solid, slightly warm off-white that still carries the brand's hue without the dotted texture:
```css
background-color: #F6F9F8;
```
One line removed, one value changed. No component references the dot pattern directly, so nothing else in the codebase depends on this.

### 4.2 Wiring existing motion into `StatCard` / `MetricBlock`

`StatCard`'s value (`ui.tsx:418`) and `MetricBlock`'s value (`ui.tsx:454`) gain `animate-count-in` on mount. Both components are pure-presentational already (no fetch, no state beyond props), so this is a className addition, not a logic change.

`StatCard` gains an optional emphasis prop:
```ts
export function StatCard(props: {
  label: string;
  value: string;
  sub?: string;
  icon?: IconName;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  emphasis?: "primary" | "default";   // NEW, defaults to "default" — fully back-compat
}): JSX.Element
```
`emphasis: "primary"` renders the value at `text-3xl` instead of `text-xl` and uses the `bordered` card treatment (`border-2 border-brand-400/25`, already defined in `CARD_SURFACE`) instead of `default`. A screen with six stat tiles marks its one headline number `emphasis="primary"`; the other five stay `default`. This is additive — every existing `<StatCard>` call site keeps rendering exactly as it does today until a screen opts in.

### 4.3 New primitives: `Stagger` and `TableShell`

**`Stagger`** — a thin wrapper that assigns the existing `stagger-1`…`stagger-7` CSS classes (already defined in `index.css`, currently unused) to its children by index, capped at 7 (the 8th+ child gets no stagger delay rather than an out-of-range class):
```ts
export function Stagger(props: { children: React.ReactNode; className?: string }): JSX.Element
```
Wraps a row of `<StatCard>`s or cards in a page to get a cascading `animate-slide-up` entrance instead of everything appearing at once. Pure layout — no state, no fetch.

**`TableShell`** — wraps existing `<table>` markup (doesn't replace it) to apply consistent header styling, `tabular-nums` on numeric columns, sticky header, and alternating-row hover background:
```ts
export function TableShell(props: { children: React.ReactNode; className?: string }): JSX.Element
```
This is deliberately *not* a data-driven `<Table rows={...} columns={...}>` abstraction — that would mean rewriting every table call site in one pass, which is exactly the kind of big-bang change this design is trying to avoid (per §2's non-goals). `TableShell` wraps the existing `<table>` a screen already renders; adoption is incremental, one screen at a time, starting with §6's list.

### 4.4 Testing (Phase A)

- `Stagger`'s index→class mapping is the one piece of new logic; it's a pure function and gets a unit test (`apps/web/test/stagger.test.ts`, following the existing `lib/*` pure-module test pattern — per the repo's own constraint, web tests have no DOM environment, so this tests the class-list logic directly, not a render).
- Everything else in Phase A is presentational CSS/JSX with no new logic — verified visually via the Browser pane (both dashboards, before/after screenshots), not unit tests.

## 5. Phase B — command palette

### 5.1 Trigger

`AppShell.tsx`'s top bar (currently just the user's email + role pill, `AppShell.tsx:205-212`) gains a "Search… ⌘K" button on its left side. A global `keydown` listener (added in `AppShell`, removed on unmount) opens the palette on `Cmd+K`/`Ctrl+K` from anywhere in the app, matching the convention this platform's users will already know from every other tool that has one.

### 5.2 What it searches

On open, the palette loads (client-side, once per session, cached) three lists via calls the app already makes elsewhere — no new API surface:
- **Nav items** — the current persona's own `items` (already in scope wherever `AppShell` renders), zero-cost.
- **Use cases** — `api.useCases(token)` for a tokenization persona, `api.credentialUseCases(token)` for an identity persona (mirroring the exact `useCasesSurfaced`-style persona gating already fixed in `App.tsx`/`Organizations.tsx` — the palette must not fire the tokenization-only call from an identity persona for the same CORS-shaped-failure reason documented there).
- **Assets** — `api.assets(token)`, only when the active persona's surfaces include an assets-bearing view (same gating principle).

Because every one of these calls already carries the caller's real auth token, results are automatically scoped to whatever that user/persona is already allowed to see — there is no separate authorization concern to design here.

### 5.3 Ranking (`lib/shared/command-search.ts`)

A pure function:
```ts
export function rankCommandResults(query: string, items: CommandItem[]): CommandItem[]
```
Simple substring + prefix scoring (prefix match on name ranks above mid-string match; case-insensitive) — no fuzzy-matching library dependency, consistent with the rest of `ui.tsx` being "zero-dependency beyond Tailwind + hand-drawn SVG." This is the one piece of genuinely new logic in the whole design and gets full unit test coverage (`apps/web/test/command-search.test.ts`): empty query, no matches, prefix-beats-substring ordering, case-insensitivity, result cap.

### 5.4 `CommandPalette.tsx`

A modal overlay (renders via the same pattern `QrSign`/other full-screen overlays already use in this codebase — no new portal/modal infrastructure needed), keyboard-navigable (arrow keys + Enter, Escape to close), selecting a result calls the existing `onSelect`/`navigate` the screen already has. Empty-query state shows recent/pinned nav items (using the already-existing `EmptyState` primitive is the wrong fit here since this isn't an empty *state* — it's an empty *query* — so this renders a short "Jump to" list instead, no new primitive required).

### 5.5 Testing (Phase B)

- `rankCommandResults` — full unit coverage, pure function (§5.3).
- The palette component itself (open/close, keyboard nav, result selection) is verified live via the Browser pane across at least one tokenization persona and one identity persona, matching how every other UI change this session has been verified — no DOM test environment exists in this repo for component-level tests.

## 6. Phase C — apply to the highest-traffic screens

Five screens get a pass to replace ad-hoc markup with Phase A's primitives (`emphasis`, `Stagger`, `TableShell`) — chosen because they're what a PlatformAdmin/UseCaseAdmin/Issuer actually looks at most:

1. Platform Admin dashboard (tokenization) — the "By use case" table → `TableShell`; the four top stat tiles → `Stagger` + one marked `emphasis="primary"` (Total Supply, the number that actually drives every other tile).
2. Identity Dashboard — same treatment: the 7-tile lifecycle row → `Stagger`, "Issued" as the primary tile; the credential status board table → `TableShell`.
3. `AssetDetail.tsx` — the audit/activity table → `TableShell`.
4. `IssuePanel.tsx` / `IssueUsecaseCredential.tsx` — no table work, but adopt `Stagger` on their summary tiles if present.
5. `UseCaseBuilder.tsx` / `CredentialUseCaseBuilder.tsx` review steps — the summary tile row → `Stagger`.

Each of these is a markup-only change (swap raw `<table>`/`<div className="grid">` for the shared wrapper + props); no data-fetching or state logic changes. Verified visually per screen via the Browser pane, same practice as every other UI change made this session.

## 7. Error handling

There is no new failure surface introduced by Phase A (pure CSS/presentational) or Phase C (markup-only). Phase B's palette fetches are the only place new failure modes exist:
- A scoped fetch failing (403/network) degrades to "no results for that category" rather than blocking the palette or the rest of the app — mirrors the existing `.catch(() => setX([]))` pattern already used everywhere else in `App.tsx`/`Organizations.tsx` for exactly this reason.
- The palette itself never throws on a malformed query — `rankCommandResults` returns an empty array rather than throwing, so a palette bug can never crash the shell it lives in.

## 8. Rollout

No feature flag, no staged rollout mechanism needed — this is a single shared web bundle rebuilt and redeployed across all six persona containers together (the existing `docker compose ... up -d --build <service>-web` pattern already used throughout this session). Phases A, B, and C can each be its own commit/verification cycle, but all three ship to the same six containers at once since there's no per-persona toggle for shell-level UI.

## 9. Open questions

None blocking. One judgment call worth flagging: `TableShell` in §4.3 is deliberately conservative (a wrapper, not a data-driven table abstraction) to avoid a big-bang rewrite — if a full `<Table rows columns>` component is wanted later, that's a bigger, separate design decision (sorting, column config, virtualization for large lists), not something to fold into this pass.
