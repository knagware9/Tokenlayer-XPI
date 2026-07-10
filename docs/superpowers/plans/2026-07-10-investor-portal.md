# Investor Portal v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Investor-mode experience (Offerings · Portfolio · Activity) for role `Buyer`, backed by two new read-only aggregation endpoints `/me/portfolio` and `/me/activity`.

**Architecture:** A new pure-aggregation module `apps/api/src/investor.ts` folds the per-asset audit stream (shared `holders.ts` fold, refactored to expose an incremental step) into the caller's holdings and personal activity; coupon/redemption amounts are recomputed with core `splitProRata` exactly as settlement paid them. Two thin routes expose it. The web app renders `<InvestorPortal>` instead of the operator console when `user.role === "Buyer"`.

**Tech Stack:** Fastify + Vitest (apps/api), React + Vite + Tailwind (apps/web), BigInt integer-string math throughout.

**Spec:** `docs/superpowers/specs/2026-07-10-investor-portal-design.md`

---

## File map

| File | Change |
|---|---|
| `apps/api/src/holders.ts` | Refactor: expose `createFold()` incremental step; `foldAsset` delegates (zero behavior change) |
| `apps/api/src/investor.ts` | **Create**: `computePortfolio(deps, wallet, useCaseKey?)`, `computeActivity(deps, wallet, useCaseKey?)` |
| `apps/api/src/http/routes.ts` | Add `GET /me/portfolio`, `GET /me/activity` (near the existing `walletOf` helper, routes.ts:700) |
| `apps/api/src/http/schemas.ts` | Add `mePortfolio`, `meActivity` schemas (tag `["Investor"]`, permissive like the Audit schemas) |
| `apps/api/test/investor-portal.test.ts` | **Create**: endpoint tests |
| `apps/web/src/types.ts` | Add `Portfolio`, `ActivityEvent` types |
| `apps/web/src/api.ts` | Add `mePortfolio`, `meActivity` client methods |
| `apps/web/src/components/InvestorPortal.tsx` | **Create**: shell (tabs) + `InvestorOfferings` + `InvestorPortfolio` + `InvestorActivity` |
| `apps/web/src/App.tsx` | Render `<InvestorPortal>` when `user.role === "Buyer"` |
| `scripts/investor-portal-e2e.mjs` | **Create**: live E2E |

---

### Task 1: holders.ts incremental fold (refactor, zero behavior change)

**Files:** Modify `apps/api/src/holders.ts` · Test: existing suites must stay green.

- [ ] **Step 1: Refactor** — extract the loop body of `foldAsset` into an incremental fold so `investor.ts` can classify each entry *before* applying it:

```ts
/** Incremental fold: feed entries oldest→newest via step(); read state anytime. */
export interface Fold {
  state: AssetState;
  step(e: AuditEntryRecord): void;
}

export function createFold(): Fold {
  const balances = new Map<string, bigint>();
  const owners = new Map<string, string>(); // tokenId → current owner (NFT only)
  const state: AssetState = { supply: 0n, balances };
  const bump = (addr: unknown, delta: bigint): void => {
    if (typeof addr !== "string" || addr === "") return;
    balances.set(addr, (balances.get(addr) ?? 0n) + delta);
  };
  return {
    state,
    step(e: AuditEntryRecord): void {
      // <move the existing foldAsset switch body here verbatim, replacing
      //  `supply +=`/`supply -=` with `state.supply +=`/`state.supply -=`>
    },
  };
}

export function foldAsset(entries: AuditEntryRecord[]): AssetState {
  const f = createFold();
  for (const e of entries) f.step(e);
  return f.state;
}
```

The switch body moves verbatim — mint/transfer/burn/buy, fungible `amount` + NFT `tokenId` branches unchanged.

- [ ] **Step 2: Verify zero behavior change** — Run: `pnpm --filter @tokenlayer/api test` → Expected: 123 passed.
- [ ] **Step 3: Commit** — `git add apps/api/src/holders.ts && git commit -m "refactor(api): expose incremental audit fold (createFold) — foldAsset delegates"`

### Task 2: investor read-model (`apps/api/src/investor.ts`)

**Files:** Create `apps/api/src/investor.ts` · Test: `apps/api/test/investor-portal.test.ts` (Task 3 exercises via HTTP; this module stays deps-injected for that).

- [ ] **Step 1: Implement** the aggregation module:

```ts
import { splitProRata } from "@tokenlayer/core";
import type { AppDeps } from "../context.js"; // adjust: `../` → `./` per actual layout
import { createFold, amountOf } from "./holders.js";
import { dropPayerShare } from "./executors.js";
import type { AssetRecord, AuditEntryRecord } from "./persistence/types.js";

export interface Holding {
  assetId: string; name: string; symbol: string; useCaseKey: string; chainId: string;
  units: string; unitPrice: string | null; currency: string | null; value: string | null;
}
export interface Portfolio {
  wallet: string;
  cash: { currency: string; amount: string }[];
  holdings: Holding[];
  totalByCurrency: Record<string, string>;
}
export interface ActivityEvent {
  at: string; kind: "subscribed" | "received" | "sent" | "coupon" | "redemption";
  assetId: string; assetName: string; units: string | null;
  amount: string | null; currency: string | null; txHash: string | null;
}

const eq = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** Balance of `wallet` in a fold's balances map, case-insensitive. */
function balanceOf(balances: Map<string, bigint>, wallet: string): bigint {
  for (const [addr, bal] of balances) if (eq(addr, wallet)) return bal;
  return 0n;
}

/** The use case's assets + their chronological audit entries, grouped. */
async function assetStreams(deps: AppDeps, useCaseKey?: string): Promise<{ assets: AssetRecord[]; byAsset: Map<string, AuditEntryRecord[]> }> {
  const { items: assets } = await deps.assets.list(useCaseKey ? { useCaseKey } : {}, { limit: 1000 });
  const { items } = await deps.audit.listByAssetIds(assets.map((a) => a.id), { limit: 100000 });
  const byAsset = new Map<string, AuditEntryRecord[]>();
  for (const e of items) {
    if (!e.assetId) continue;
    const list = byAsset.get(e.assetId) ?? [];
    list.push(e);
    byAsset.set(e.assetId, list);
  }
  // listByAssetIds returns createdAt ASC already; keep a defensive per-asset sort.
  for (const list of byAsset.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { assets, byAsset };
}

/** Value of `units` of an asset: unitPrice × units, else pro-rata of the use case's valuation field. */
function holdingValue(a: AssetRecord, units: bigint, supply: bigint, valuation?: { metadataField: string; currency: string }): { currency: string; amount: bigint } | null {
  if (a.unitPrice && a.currency && /^\d+$/.test(a.unitPrice)) return { currency: a.currency, amount: units * BigInt(a.unitPrice) };
  if (valuation && supply > 0n) {
    const raw = a.metadata?.[valuation.metadataField];
    const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 0) return { currency: valuation.currency, amount: (units * BigInt(Math.round(n))) / supply };
  }
  return null;
}

export async function computePortfolio(deps: AppDeps, wallet: string, useCaseKey?: string): Promise<Portfolio> {
  const { assets, byAsset } = await assetStreams(deps, useCaseKey);
  const valuations = new Map((await deps.useCases.list()).map((u) => [u.key, u.valuation] as const));
  const holdings: Holding[] = [];
  const totals = new Map<string, bigint>();
  for (const a of assets) {
    const fold = createFold();
    for (const e of byAsset.get(a.id) ?? []) fold.step(e);
    const units = balanceOf(fold.state.balances, wallet);
    if (units <= 0n) continue;
    const v = holdingValue(a, units, fold.state.supply, valuations.get(a.useCaseKey));
    if (v) totals.set(v.currency, (totals.get(v.currency) ?? 0n) + v.amount);
    holdings.push({
      assetId: a.id, name: a.name, symbol: a.symbol, useCaseKey: a.useCaseKey, chainId: a.chainId,
      units: units.toString(), unitPrice: a.unitPrice ?? null, currency: v?.currency ?? a.currency ?? null,
      value: v ? v.amount.toString() : null,
    });
  }
  const cash = (await deps.cash.balancesOf(wallet)).map((b) => ({ currency: b.currency, amount: b.amount }));
  return { wallet, cash, holdings, totalByCurrency: Object.fromEntries([...totals].map(([c, v]) => [c, v.toString()])) };
}

export async function computeActivity(deps: AppDeps, wallet: string, useCaseKey?: string): Promise<ActivityEvent[]> {
  const { assets, byAsset } = await assetStreams(deps, useCaseKey);
  const nameOf = new Map(assets.map((a) => [a.id, a] as const));
  const events: ActivityEvent[] = [];
  for (const a of assets) {
    const fold = createFold();
    for (const e of byAsset.get(a.id) ?? []) {
      const p = e.payload ?? {};
      const base = { at: e.createdAt, assetId: a.id, assetName: nameOf.get(a.id)?.name ?? "", txHash: e.txHash ?? null };
      if (e.action === "buy" && eq(p.to, wallet)) {
        events.push({ ...base, kind: "subscribed", units: String(p.amount ?? ""), amount: typeof p.cost === "string" ? p.cost : null, currency: typeof p.currency === "string" ? p.currency : null });
      } else if ((e.action === "mint" || e.action === "transfer") && eq(p.to, wallet)) {
        events.push({ ...base, kind: "received", units: String(p.amount ?? p.tokenId ?? ""), amount: null, currency: null });
      } else if (e.action === "transfer" && eq(p.from, wallet)) {
        events.push({ ...base, kind: "sent", units: String(p.amount ?? p.tokenId ?? ""), amount: null, currency: null });
      } else if (e.action === "distribute" || e.action === "redeem") {
        // Recompute this wallet's share exactly as settlement paid it: balances at
        // this point in the stream → drop the payer → splitProRata → my slice.
        const held = balanceOf(fold.state.balances, wallet);
        const split = new Map(fold.state.balances);
        if (typeof p.from === "string") dropPayerShare(split, p.from);
        const mine = splitProRata(amountOf(p, "paid") || amountOf(p, "amount"), split);
        let share = 0n;
        for (const [addr, amt] of mine) if (eq(addr, wallet)) share = amt;
        if (share > 0n) {
          events.push({ ...base, kind: e.action === "redeem" ? "redemption" : "coupon", units: e.action === "redeem" ? held.toString() : null, amount: share.toString(), currency: typeof p.currency === "string" ? p.currency : null });
        }
      }
      fold.step(e); // apply AFTER classification so distribute sees pre-event balances
    }
  }
  return events.sort((x, y) => y.at.localeCompare(x.at)).slice(0, 100);
}
```

Import-path note: `investor.ts` lives in `apps/api/src/`, so imports are `./holders.js`, `./executors.js`, `./context.js`, `./persistence/types.js`.

- [ ] **Step 2: Typecheck** — Run: `pnpm --filter @tokenlayer/api exec tsc --noEmit` → Expected: clean.
- [ ] **Step 3: Commit** — `git commit -m "feat(api): investor read-model — portfolio + activity aggregation over the audit fold"`

### Task 3: routes + schemas + tests

**Files:** Modify `apps/api/src/http/routes.ts` (after the audit-integrity block, near `walletOf`), `apps/api/src/http/schemas.ts` · Create `apps/api/test/investor-portal.test.ts`.

- [ ] **Step 1: Write the failing tests** (follows the house style of `apps/api/test/cashflows.test.ts` — `buildTestApp`, `loginAs`, `auth`):

```ts
import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

const INVESTOR_WALLET = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Carol — seeded, unlinked
const PAYER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const inv = (n: string) => ({ invoiceNumber: n, invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2026-12-31" });

async function investorSetup(app: FastifyInstance): Promise<{ admin: string; investor: string }> {
  const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
  await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: "inv.portal@x.dev", password: "secret1", role: "Buyer", walletAddress: INVESTOR_WALLET, kyc: { country: "IN" } } });
  const investor = await loginAs(app, "inv.portal@x.dev", "secret1");
  return { admin, investor };
}

describe("investor portal endpoints", () => {
  it("400 NO_WALLET when the caller has no linked wallet", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123"); // desk admin: no wallet
    const r = await app.inject({ method: "GET", url: `${V1}/me/portfolio`, headers: auth(admin) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("NO_WALLET");
  });

  it("portfolio: holdings + value from a subscription; activity records it", async () => {
    const app = await buildTestApp();
    const { admin, investor } = await investorSetup(app);
    // Issue an invoice: 1000 units @ face 1,000,000 minted to PAYER (the desk sells them)
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { useCaseKey: "invoice-tokenization", name: "INV-PORT-1", chainId: "fabric", initialSupply: "1000", treasuryAccount: PAYER, metadata: inv("INV-PORT-1"), sale: { unitPrice: "920", currency: "CBDC-INR", treasuryAccount: PAYER } } });
    expect(issued.statusCode).toBe(201);
    const assetId = issued.json().asset.id;
    // The desk must own a scoped user for the treasury so it's in-scope; link PAYER
    await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: "inv.payer@x.dev", password: "secret1", role: "Auditor", walletAddress: PAYER, kyc: { country: "IN" } } });
    // Allow + fund the investor, then subscribe to 200 units (cost 184,000)
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(admin), payload: { account: INVESTOR_WALLET } });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: INVESTOR_WALLET, currency: "CBDC-INR", amount: "500000" } });
    const buy = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(investor), payload: { quantity: "200" } });
    expect(buy.statusCode).toBe(200);

    const pf = (await app.inject({ method: "GET", url: `${V1}/me/portfolio`, headers: auth(investor) })).json();
    const holding = pf.holdings.find((h: { assetId: string }) => h.assetId === assetId);
    expect(holding.units).toBe("200");
    expect(holding.value).toBe("184000"); // 200 × 920 (unitPrice wins over face valuation)
    expect(pf.totalByCurrency["CBDC-INR"]).toBe("184000");
    expect(pf.cash.find((c: { currency: string }) => c.currency === "CBDC-INR").amount).toBe("316000");

    const act = (await app.inject({ method: "GET", url: `${V1}/me/activity`, headers: auth(investor) })).json();
    const sub = act.find((e: { kind: string }) => e.kind === "subscribed");
    expect(sub.units).toBe("200");
    expect(sub.amount).toBe("184000");
  });

  it("activity: coupon share matches what settlement actually paid", async () => {
    const app = await buildTestApp();
    const { admin, investor } = await investorSetup(app);
    const issued = await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(admin), payload: { useCaseKey: "invoice-tokenization", name: "INV-PORT-2", chainId: "fabric", initialSupply: "1000", treasuryAccount: PAYER, metadata: inv("INV-PORT-2"), sale: { unitPrice: "900", currency: "CBDC-INR", treasuryAccount: PAYER } } });
    const assetId = issued.json().asset.id;
    await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: "inv.payer2@x.dev", password: "secret1", role: "Auditor", walletAddress: PAYER, kyc: { country: "IN" } } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(admin), payload: { account: INVESTOR_WALLET } });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: INVESTOR_WALLET, currency: "CBDC-INR", amount: "900000" } });
    await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/buy`, headers: auth(investor), payload: { quantity: "400" } }); // investor holds 400/1000
    // Fund the payer (face repayment) and settle the redemption via maker-checker
    await app.inject({ method: "POST", url: `${V1}/cash/credit`, headers: auth(platform), payload: { account: PAYER, currency: "CBDC-INR", amount: "1000000" } });
    const cfs = (await app.inject({ method: "GET", url: `${V1}/assets/${assetId}/cashflows`, headers: auth(admin) })).json().cashflows;
    const redemption = cfs.find((c: { kind: string }) => c.kind === "redemption");
    const proposed = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/cashflows/${redemption.id}/execute`, headers: auth(admin), payload: {} });
    expect(proposed.statusCode).toBe(202);
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const approved = await app.inject({ method: "POST", url: `${V1}/proposals/${proposed.json().proposal.id}/approve`, headers: auth(issuer), payload: {} });
    expect(approved.json().proposal.status).toBe("executed");

    const act = (await app.inject({ method: "GET", url: `${V1}/me/activity`, headers: auth(investor) })).json();
    const red = act.find((e: { kind: string }) => e.kind === "redemption");
    // payer holds 600 → dropped; investor holds ALL remaining units → full 1,000,000
    expect(red.amount).toBe("1000000");
    expect(red.units).toBe("400");
  });

  it("tenancy: another use case's assets never appear", async () => {
    const app = await buildTestApp();
    const { investor } = await investorSetup(app);
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    await app.inject({ method: "POST", url: `${V1}/assets`, headers: auth(carbon), payload: { useCaseKey: "carbon-credit", name: "VCU-X", chainId: "fabric", initialSupply: "10", treasuryAccount: INVESTOR_WALLET, metadata: { projectName: "P", registry: "Verra", vintage: 2024 } } });
    const pf = (await app.inject({ method: "GET", url: `${V1}/me/portfolio`, headers: auth(investor) })).json();
    expect(pf.holdings.every((h: { useCaseKey: string }) => h.useCaseKey === "invoice-tokenization")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @tokenlayer/api test investor-portal` → Expected: 404s (routes missing).
- [ ] **Step 3: Implement routes** in `routes.ts` (imports: `computePortfolio, computeActivity` from `../investor.js`) — place after the audit-integrity block:

```ts
// --- investor portal (read-only, describes the CALLER) ---------------------
async function investorScope(request: FastifyRequest, reply: FastifyReply): Promise<{ wallet: string; useCaseKey?: string } | null> {
  const claims = request.user as TokenClaims;
  const wallet = await walletOf(claims);
  if (!wallet) {
    reply.code(400).send({ error: "NO_WALLET", message: "your account has no linked wallet" });
    return null;
  }
  return { wallet, useCaseKey: claims.role === "PlatformAdmin" ? undefined : claims.useCaseKey ?? NO_USE_CASE };
}

app.get("/me/portfolio", { schema: S.mePortfolio, ...auth }, async (request, reply) => {
  const scope = await investorScope(request, reply);
  if (!scope) return reply;
  return computePortfolio(deps, scope.wallet, scope.useCaseKey);
});

app.get("/me/activity", { schema: S.meActivity, ...auth }, async (request, reply) => {
  const scope = await investorScope(request, reply);
  if (!scope) return reply;
  return computeActivity(deps, scope.wallet, scope.useCaseKey);
});
```

`walletOf` is currently declared at routes.ts:700 (inside the marketplace section) — it is function-scoped to `registerRoutes`, so the new routes may simply be placed after it (or move `walletOf` up beside the other shared helpers; either is fine, do not duplicate it).

Schemas in `schemas.ts` (mirror the Audit block's permissive style):

```ts
export const mePortfolio = { tags: ["Investor"], summary: "The caller's holdings, cash, and totals", response: { 200: { type: "object", additionalProperties: true } } } as const;
export const meActivity = { tags: ["Investor"], summary: "The caller's personal activity feed", response: { 200: { type: "array", items: { type: "object", additionalProperties: true } } } } as const;
```

- [ ] **Step 4: Run tests** — `pnpm --filter @tokenlayer/api test` → Expected: all pass (123 + 4 new).
- [ ] **Step 5: Commit** — `git commit -m "feat(api): GET /me/portfolio + GET /me/activity — investor aggregation endpoints"`

### Task 4: web client (types + api)

**Files:** Modify `apps/web/src/types.ts`, `apps/web/src/api.ts`.

- [ ] **Step 1: Types** (append to `types.ts`):

```ts
export interface Holding {
  assetId: string; name: string; symbol: string; useCaseKey: string; chainId: string;
  units: string; unitPrice: string | null; currency: string | null; value: string | null;
}
export interface Portfolio {
  wallet: string;
  cash: { currency: string; amount: string }[];
  holdings: Holding[];
  totalByCurrency: Record<string, string>;
}
export interface ActivityEvent {
  at: string; kind: "subscribed" | "received" | "sent" | "coupon" | "redemption";
  assetId: string; assetName: string; units: string | null; amount: string | null;
  currency: string | null; txHash: string | null;
}
```

- [ ] **Step 2: Client methods** (append inside the `api` object in `api.ts`; add `Portfolio, ActivityEvent` to the type import):

```ts
mePortfolio: (token: string) => request<Portfolio>("/me/portfolio", token),
meActivity: (token: string) => request<ActivityEvent[]>("/me/activity", token),
```

- [ ] **Step 3: Typecheck** — `pnpm --filter @tokenlayer/web exec tsc --noEmit` → clean.
- [ ] **Step 4: Commit** — `git commit -m "feat(web): portfolio/activity client + types"`

### Task 5: InvestorPortal UI + App wiring

**Files:** Create `apps/web/src/components/InvestorPortal.tsx` · Modify `apps/web/src/App.tsx`.

- [ ] **Step 1: Component.** One file, four exports-worth of UI (shell + three sections), following the house style (pill tabs, `bg-white rounded-xl border border-slate-200` cards, `ago()` pattern from IntegrityPanel):

```tsx
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import type { ActivityEvent, Asset, Listing, Portfolio, UseCase } from "../types.js";

type Tab = "offerings" | "portfolio" | "activity";

const fmt = (s: string | null): string => { try { return BigInt(String(s)).toLocaleString("en-IN"); } catch { return s ?? "—"; } };
const money = (by: Record<string, string>): string => Object.entries(by).filter(([, v]) => v !== "0").map(([c, v]) => `${fmt(v)} ${c}`).join(" · ") || "—";
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Investor experience for role Buyer: Offerings · Portfolio · Activity. */
export function InvestorPortal({ useCases }: { useCases: UseCase[] }): JSX.Element {
  const [tab, setTab] = useState<Tab>("offerings");
  const tabs: { id: Tab; label: string }[] = [
    { id: "offerings", label: "Offerings" },
    { id: "portfolio", label: "Portfolio" },
    { id: "activity", label: "Activity" },
  ];
  return (
    <div>
      <div className="flex gap-1 mb-5">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === t.id ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}>{t.label}</button>
        ))}
      </div>
      {tab === "offerings" && <InvestorOfferings useCases={useCases} onSubscribed={() => setTab("portfolio")} />}
      {tab === "portfolio" && <InvestorPortfolio />}
      {tab === "activity" && <InvestorActivity />}
    </div>
  );
}

function InvestorOfferings({ useCases, onSubscribed }: { useCases: UseCase[]; onSubscribed: () => void }): JSX.Element {
  const { token } = useAuth();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [listings, setListings] = useState<(Listing & { assetId: string; assetName: string })[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    const all = await api.assets(token);
    const onSale = all.filter((a) => a.status === "active" && a.unitPrice && BigInt(a.unitPrice) > 0n);
    setAssets(onSale);
    const ls = await Promise.all(all.filter((a) => a.status === "active").map(async (a) =>
      (await api.listings(token, a.id).catch(() => [])).filter((l) => (l.status ?? "open") === "open").map((l) => ({ ...l, assetId: a.id, assetName: a.name }))));
    setListings(ls.flat());
  }, [token]);
  useEffect(() => { void reload(); }, [reload]);

  async function subscribe(): Promise<void> {
    if (!token || !selected || !qty) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.buy(token, selected.id, qty);
      setNotice(`Subscribed: ${qty} units for ${fmt(r.paid.amount)} ${r.paid.currency}.`);
      setSelected(null); setQty("");
      await reload();
      onSubscribed();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Subscription failed");
    } finally { setBusy(false); }
  }

  async function take(listingId: string, quantity: string): Promise<void> {
    if (!token) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.takeListing(token, listingId, quantity);
      setNotice(`Bought ${quantity} units from the secondary market.`);
      await reload();
      onSubscribed();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code ?? "Error"}: ${err.message}` : "Purchase failed");
    } finally { setBusy(false); }
  }

  const uc = (key: string) => useCases.find((u) => u.key === key);
  const feeBps = selected ? uc(selected.useCaseKey)?.fees?.marketplaceBps ?? 0 : 0;
  const cost = selected && /^\d+$/.test(qty) ? BigInt(qty) * BigInt(selected.unitPrice ?? "0") : null;

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}
      {notice && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-2">{notice}</div>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {assets.map((a) => (
          <button key={a.id} onClick={() => { setSelected(a); setQty(""); }} className={`text-left bg-white rounded-xl border p-4 transition ${selected?.id === a.id ? "border-brand-500 shadow-sm" : "border-slate-200 hover:border-brand-500"}`}>
            <div className="font-medium text-slate-800">{a.name}</div>
            <div className="text-xs text-slate-400">{a.symbol} · {a.chainId}</div>
            <div className="mt-2 text-sm font-semibold text-slate-900">{fmt(a.unitPrice)} {a.currency}<span className="text-xs font-normal text-slate-400"> / unit</span></div>
            {a.availableSupply && <div className="text-[11px] text-slate-400">{fmt(a.availableSupply)} available</div>}
          </button>
        ))}
        {assets.length === 0 && <p className="text-sm text-slate-400 col-span-full">No open offerings right now.</p>}
      </div>

      {selected && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 max-w-xl space-y-3">
          <h3 className="font-semibold text-slate-900">Subscribe — {selected.name}</h3>
          <div className="text-xs text-slate-500 space-y-0.5">
            {Object.entries(selected.metadata).slice(0, 5).map(([k, v]) => (
              <div key={k}><span className="text-slate-400">{k}:</span> {typeof v === "string" && v.startsWith("http") ? <a className="text-brand-600 hover:underline" href={v} target="_blank" rel="noreferrer">document</a> : String(v)}</div>
            ))}
          </div>
          <div className="flex items-end gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-slate-600 mb-1">Quantity</span>
              <input className="input w-32" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
            <div className="text-sm text-slate-600 pb-2">
              {cost !== null && <>Total <span className="font-semibold text-slate-900">{cost.toLocaleString("en-IN")} {selected.currency}</span>{feeBps > 0 && <span className="text-[11px] text-slate-400"> (incl. {feeBps / 100}% exchange fee)</span>}</>}
            </div>
            <button onClick={() => void subscribe()} disabled={busy || !qty} className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50">{busy ? "Subscribing…" : "Subscribe"}</button>
          </div>
        </div>
      )}

      {listings.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-800 text-sm">Secondary market</div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {listings.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-2.5 text-slate-800">{l.assetName}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{fmt(l.quantity)} units @ {fmt(l.unitPrice)} {l.currency}</td>
                  <td className="px-4 py-2.5 text-right"><button onClick={() => void take(l.id, l.quantity)} disabled={busy} className="rounded-lg border border-brand-600 text-brand-700 px-3 py-1 text-xs font-medium hover:bg-brand-50 disabled:opacity-50">Buy all</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function InvestorPortfolio(): JSX.Element {
  const { token } = useAuth();
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    api.mePortfolio(token).then(setPf).catch((e) => setError(e instanceof ApiError && e.code === "NO_WALLET" ? "NO_WALLET" : "Could not load portfolio"));
  }, [token]);
  if (error === "NO_WALLET") return <NoWallet />;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!pf) return <p className="text-sm text-slate-400">Loading portfolio…</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Portfolio value" value={money(pf.totalByCurrency)} />
        {pf.cash.map((c) => <Stat key={c.currency} label={`Cash · ${c.currency}`} value={fmt(c.amount)} />)}
      </div>
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
            <tr><th className="text-left font-medium px-4 py-2.5">Asset</th><th className="text-right font-medium px-4 py-2.5">Units</th><th className="text-right font-medium px-4 py-2.5">Value</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pf.holdings.map((h) => (
              <tr key={h.assetId}>
                <td className="px-4 py-2.5 font-medium text-slate-800">{h.name} <span className="text-slate-400 font-normal">{h.symbol}</span></td>
                <td className="px-4 py-2.5 text-right font-mono">{fmt(h.units)}</td>
                <td className="px-4 py-2.5 text-right font-mono">{h.value ? `${fmt(h.value)} ${h.currency}` : "—"}</td>
              </tr>
            ))}
            {pf.holdings.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-sm text-slate-400">No holdings yet — subscribe to an offering.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvestorActivity(): JSX.Element {
  const { token } = useAuth();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    api.meActivity(token).then(setEvents).catch((e) => setError(e instanceof ApiError && e.code === "NO_WALLET" ? "NO_WALLET" : "Could not load activity"));
  }, [token]);
  if (error === "NO_WALLET") return <NoWallet />;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!events) return <p className="text-sm text-slate-400">Loading activity…</p>;
  const tone: Record<ActivityEvent["kind"], string> = { subscribed: "bg-brand-50 text-brand-700", received: "bg-emerald-100 text-emerald-700", sent: "bg-slate-100 text-slate-600", coupon: "bg-amber-100 text-amber-700", redemption: "bg-violet-100 text-violet-700" };
  return (
    <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
      {events.map((e, i) => (
        <div key={`${e.at}-${i}`} className="flex items-center gap-3 px-4 py-3 text-sm">
          <span className={`text-xs px-2 py-0.5 rounded-full ${tone[e.kind]}`}>{e.kind}</span>
          <span className="flex-1 text-slate-700"><span className="font-medium text-slate-900">{e.assetName}</span>{e.units && <> · {fmt(e.units)} units</>}{e.amount && <> · {fmt(e.amount)} {e.currency}</>}</span>
          <span className="text-xs text-slate-400">{ago(e.at)}</span>
        </div>
      ))}
      {events.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-400">No activity yet.</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-lg font-bold text-slate-900 mt-0.5 break-words">{value}</div>
    </div>
  );
}

function NoWallet(): JSX.Element {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">
      Your account has no linked wallet yet — contact your desk administrator to link one.
    </div>
  );
}
```

- [ ] **Step 2: App wiring** (`App.tsx`). After the `isPlatform`/`activeUseCase` block and BEFORE the platform-home early return, add the Buyer branch (Buyers always have a `useCaseKey`, so the platform-home branch never applies to them):

```tsx
// Investors get the dedicated portal experience instead of the operator console.
if (user.role === "Buyer") {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-6xl mx-auto px-6 py-6">
        <InvestorPortal useCases={useCases} />
      </main>
    </div>
  );
}
```

Plus `import { InvestorPortal } from "./components/InvestorPortal.js";`.

- [ ] **Step 3: Typecheck + build** — `pnpm --filter @tokenlayer/web exec tsc --noEmit && pnpm --filter @tokenlayer/web build` → clean.
- [ ] **Step 4: Commit** — `git commit -m "feat(web): investor portal — Offerings / Portfolio / Activity for role Buyer"`

### Task 6: verify + live E2E + merge

**Files:** Create `scripts/investor-portal-e2e.mjs`.

- [ ] **Step 1: Full suites** — `pnpm --filter @tokenlayer/core test && pnpm --filter @tokenlayer/api test && pnpm --filter @tokenlayer/web build` → all green.
- [ ] **Step 2: E2E script** — same house pattern as `scripts/gold-egr-e2e.mjs` (`call`/`ok`/`login` helpers): login `m1.admin`; onboard IN-KYC investor (fresh wallet) + payer-linked user; issue an invoice with sale terms; allow + fund investor; **subscribe via `POST /assets/:id/buy` as the investor**; `GET /me/portfolio` → assert units/value/cash; fund payer + settle redemption via propose→approve; `GET /me/activity` → assert `subscribed` and `redemption` events with exact amounts; assert a walletless desk admin gets `NO_WALLET`.
- [ ] **Step 3: Run E2E against the running stack** — `node scripts/investor-portal-e2e.mjs` → all ✓. (If the api container was recreated since the last fresh-volume boot, `docker compose -f docker-compose.yml -f docker-compose.besu.yml down -v && up -d` first — sim-fabric contract state is in-memory.)
- [ ] **Step 4: Browser verification** — `preview_start "web"`; sign in via the Login form as the E2E's investor; confirm the three tabs render, subscribe to an offering, portfolio updates, activity shows the coupon; screenshot.
- [ ] **Step 5: Rebuild images** — `docker compose -f docker-compose.yml -f docker-compose.besu.yml build api web && ... up -d` and confirm the routes exist in the container (`docker compose exec api grep -r "me/portfolio" /app/apps/api/src`).
- [ ] **Step 6: Merge** — commit the E2E script, then `git checkout main && git merge --no-ff <branch>`; update memory (product-feature-roadmap.md).

## Self-review

- **Spec coverage:** endpoints (T2/T3), NO_WALLET (T3/T5 UI), fold-not-ledger holdings (T2 via createFold), coupon recompute (T2 + T3 test), tenancy clamp (T3 route + test), offerings/subscribe/secondary (T5), portfolio/activity UI (T5), Buyers-without-wallet empty state (T5), live E2E + browser check (T6). Out-of-scope items untouched. ✅
- **Placeholders:** the one intentional elision is Task 1 Step 1's "move the existing switch body verbatim" — the body already exists in holders.ts and moving it verbatim IS the instruction; copying it into the plan would invite drift. ✅
- **Type consistency:** `Holding`/`Portfolio`/`ActivityEvent` identical across investor.ts (T2) and types.ts (T4); `createFold` (T1) matches T2's usage; `investorScope` return matches route usage. ✅
