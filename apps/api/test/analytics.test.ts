import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { computeAnalytics, type AnalyticsInput } from "../src/analytics.js";
import type { AssetRecord, AuditEntryRecord } from "../src/persistence/types.js";
import { buildTestApp, loginAs, auth, ACCOUNTS, V1 } from "./helpers.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
const ALICE = ACCOUNTS.ALICE;
const BOB = ACCOUNTS.BOB;
const CAROL = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

function asset(over: Partial<AssetRecord> & { id: string }): AssetRecord {
  return {
    useCaseKey: "carbon-credit",
    name: over.id.toUpperCase(),
    symbol: "VCU",
    chainId: "fabric",
    contractRef: "c",
    tokenType: "fungible",
    tokenStandard: "ERC-20",
    metadata: {},
    status: "active",
    createdBy: "u",
    createdAt: "2026-01-01T00:00:00.000Z",
    unitPrice: null,
    currency: null,
    treasuryAccount: null,
    ...over,
  };
}

let seq = 0;
function entry(assetId: string, action: AuditEntryRecord["action"], payload: Record<string, unknown>, createdAt: string, chainId = "fabric"): AuditEntryRecord {
  return { id: `e_${++seq}`, assetId, actorId: "u", action, payload, chainId, createdAt };
}

describe("computeAnalytics (pure)", () => {
  // Two assets on fabric (A1 priced, A2 unpriced), one on canton (A3 priced).
  const assets: AssetRecord[] = [
    asset({ id: "a1", chainId: "fabric", useCaseKey: "carbon-credit", unitPrice: "5", currency: "USD" }),
    asset({ id: "a2", chainId: "fabric", useCaseKey: "carbon-credit", unitPrice: null, currency: null }),
    asset({ id: "a3", chainId: "canton", useCaseKey: "gold-loan", symbol: "GLD", unitPrice: "10", currency: "EUR" }),
  ];

  // Audit history:
  // a1: mint 1000→ALICE, transfer 300 ALICE→BOB, burn 100 from ALICE, buy 200 ALICE→CAROL @5 USD cost 1000
  //   → ALICE net = 1000-300-100-200 = 400, BOB = 300, CAROL = 200 (3 holders); supply = 1000-100 = 900
  // a2: mint 500→BOB → BOB net 500 (holder); supply 500
  // a3: mint 50→ALICE, buy 20 ALICE→BOB @10 EUR cost 200 → ALICE 30, BOB 20 (2 holders); supply 50
  const audit: AuditEntryRecord[] = [
    entry("a1", "issue", {}, "2026-06-01T00:00:00.000Z"),
    entry("a1", "mint", { to: ALICE, amount: "1000" }, "2026-06-01T01:00:00.000Z"),
    entry("a1", "transfer", { from: ALICE, to: BOB, amount: "300" }, "2026-06-02T00:00:00.000Z"),
    entry("a1", "burn", { from: ALICE, amount: "100" }, "2026-06-03T00:00:00.000Z"),
    entry("a1", "buy", { from: ALICE, to: CAROL, amount: "200", unitPrice: "5", currency: "USD", cost: "1000" }, "2026-06-03T05:00:00.000Z"),
    entry("a2", "mint", { to: BOB, amount: "500" }, "2026-06-02T00:00:00.000Z"),
    entry("a3", "mint", { to: ALICE, amount: "50" }, "2026-06-02T00:00:00.000Z", "canton"),
    entry("a3", "buy", { from: ALICE, to: BOB, amount: "20", unitPrice: "10", currency: "EUR", cost: "200" }, "2026-06-04T00:00:00.000Z", "canton"),
  ];

  const base: AnalyticsInput = {
    scope: "platform",
    useCaseKey: null,
    assets,
    audit,
    useCases: [
      { key: "carbon-credit", name: "Carbon Credit", symbol: "VCU" },
      { key: "gold-loan", name: "Gold Loan", symbol: "GLD" },
    ],
    chains: [
      { id: "fabric", mode: "simulated" },
      { id: "canton", mode: "simulated" },
    ],
    now: "2026-06-10T12:00:00.000Z",
    days: 30,
  };

  it("computes supply totals (mint − burn)", () => {
    const r = computeAnalytics(base);
    expect(r.totals.supply).toBe("1450"); // 900 + 500 + 50
    expect(r.totals.assets).toBe(3);
    expect(r.totals.useCases).toBe(2);
  });

  it("computes valueByCurrency = supply × unitPrice for priced assets only", () => {
    const r = computeAnalytics(base);
    // a1: 900 × 5 = 4500 USD; a3: 50 × 10 = 500 EUR; a2 unpriced → excluded
    expect(r.totals.valueByCurrency).toEqual({ USD: "4500", EUR: "500" });
  });

  it("computes tradedByCurrency and trades from buy events in window", () => {
    const r = computeAnalytics(base);
    expect(r.totals.trades).toBe(2);
    expect(r.totals.tradedByCurrency).toEqual({ USD: "1000", EUR: "200" });
  });

  it("counts distinct positive-balance holders across assets", () => {
    const r = computeAnalytics(base);
    // ALICE (net positive in a1+a3), BOB (a1+a2+a3), CAROL (a1) = 3
    expect(r.totals.holders).toBe(3);
  });

  it("byLedger rows carry mode, per-ledger supply and holders", () => {
    const r = computeAnalytics(base);
    const fabric = r.byLedger.find((l) => l.chainId === "fabric")!;
    const canton = r.byLedger.find((l) => l.chainId === "canton")!;
    expect(fabric.mode).toBe("simulated");
    expect(fabric.assets).toBe(2);
    expect(fabric.supply).toBe("1400"); // 900 + 500
    // fabric holders: ALICE(400), BOB(300+500), CAROL(200) = 3
    expect(fabric.holders).toBe(3);
    expect(canton.assets).toBe(1);
    expect(canton.supply).toBe("50");
    expect(canton.holders).toBe(2); // ALICE 30, BOB 20
  });

  it("byUseCase populated in platform scope with names/symbols and value", () => {
    const r = computeAnalytics(base);
    expect(r.byUseCase).toHaveLength(2);
    const carbon = r.byUseCase.find((u) => u.useCaseKey === "carbon-credit")!;
    expect(carbon.name).toBe("Carbon Credit");
    expect(carbon.symbol).toBe("VCU");
    expect(carbon.supply).toBe("1400");
    expect(carbon.valueByCurrency).toEqual({ USD: "4500" });
    const gold = r.byUseCase.find((u) => u.useCaseKey === "gold-loan")!;
    expect(gold.chainId).toBe("canton");
    expect(gold.valueByCurrency).toEqual({ EUR: "500" });
  });

  it("byUseCase is empty in use-case scope", () => {
    const r = computeAnalytics({ ...base, scope: "use-case", useCaseKey: "carbon-credit" });
    expect(r.byUseCase).toEqual([]);
  });

  it("activity has one bucket per day incl. empty days, oldest→newest", () => {
    const r = computeAnalytics(base);
    expect(r.activity).toHaveLength(30);
    expect(r.activity[0]!.date).toBe("2026-05-12"); // 30 days ending 2026-06-10
    expect(r.activity[29]!.date).toBe("2026-06-10");
    // counts: 06-01 → 2 (issue+mint), 06-02 → 3 (a1 transfer, a2 mint, a3 mint),
    // 06-03 → 2 (burn + buy), 06-04 → 1 (buy)
    const byDate = Object.fromEntries(r.activity.map((d) => [d.date, d.count]));
    expect(byDate["2026-06-01"]).toBe(2);
    expect(byDate["2026-06-02"]).toBe(3);
    expect(byDate["2026-06-03"]).toBe(2);
    expect(byDate["2026-06-04"]).toBe(1);
    expect(byDate["2026-06-05"]).toBe(0); // empty day present
    // tradedByCurrency per day
    const jun3 = r.activity.find((d) => d.date === "2026-06-03")!;
    expect(jun3.tradedByCurrency).toEqual({ USD: "1000" });
    const jun4 = r.activity.find((d) => d.date === "2026-06-04")!;
    expect(jun4.tradedByCurrency).toEqual({ EUR: "200" });
  });

  it("recent returns last 20 events newest first with summaries + asset names", () => {
    const r = computeAnalytics(base);
    expect(r.recent.length).toBe(8);
    expect(r.recent[0]!.action).toBe("buy"); // a3 buy is the newest (06-04)
    expect(r.recent[0]!.assetName).toBe("A3");
    expect(r.recent[0]!.summary).toContain("@ 10 EUR");
    // mint summary form
    const mint = r.recent.find((e) => e.action === "mint" && e.summary.startsWith("1000"));
    expect(mint?.summary).toContain("→");
  });

  it("empty inputs → zeros and days empty buckets", () => {
    const r = computeAnalytics({ ...base, assets: [], audit: [], days: 7 });
    expect(r.totals.supply).toBe("0");
    expect(r.totals.assets).toBe(0);
    expect(r.totals.holders).toBe(0);
    expect(r.totals.trades).toBe(0);
    expect(r.totals.valueByCurrency).toEqual({});
    expect(r.byLedger).toEqual([]);
    expect(r.byUseCase).toEqual([]);
    expect(r.recent).toEqual([]);
    expect(r.activity).toHaveLength(7);
    expect(r.activity.every((d) => d.count === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------
describe("GET /analytics (route)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
  });

  async function issue(token: string, useCaseKey: string, chainId: string): Promise<string> {
    const meta: Record<string, Record<string, unknown>> = {
      "carbon-credit": { projectName: "P", registry: "Verra", vintage: 2024 },
      "gold-loan": { borrower: "R", goldWeightGrams: 1, loanAmountInr: 1 },
    };
    const res = await app.inject({
      method: "POST",
      url: `${V1}/assets`,
      headers: { authorization: `Bearer ${token}` },
      payload: { useCaseKey, name: "T", chainId, metadata: meta[useCaseKey] ?? {} },
    });
    if (res.statusCode !== 201) throw new Error(`issue failed: ${res.statusCode} ${res.body}`);
    return res.json().asset.id as string;
  }

  async function mint(token: string, id: string, to: string, amount: string): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: `${V1}/assets/${id}/actions/mint`,
      headers: { authorization: `Bearer ${token}` },
      payload: { to, amount },
    });
    if (res.statusCode !== 200) throw new Error(`mint failed: ${res.statusCode} ${res.body}`);
  }

  it("PlatformAdmin gets platform scope aggregating all use cases", async () => {
    app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // Allowlist + mint into carbon and gold assets on the seeded (fabric/canton) chains.
    const carbonId = await issue(admin, "carbon-credit", "fabric");
    await app.inject({ method: "POST", url: `${V1}/assets/${carbonId}/actions/allow`, headers: auth(admin), payload: { account: ACCOUNTS.ALICE } });
    await mint(admin, carbonId, ACCOUNTS.ALICE, "1000");
    const goldId = await issue(admin, "gold-loan", "canton");
    await app.inject({ method: "POST", url: `${V1}/assets/${goldId}/actions/allow`, headers: auth(admin), payload: { account: ACCOUNTS.BOB } });
    await mint(admin, goldId, ACCOUNTS.BOB, "500");

    const res = await app.inject({ method: "GET", url: `${V1}/analytics`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe("platform");
    expect(body.useCaseKey).toBeNull();
    expect(body.totals.assets).toBe(2);
    expect(body.totals.supply).toBe("1500");
    expect(body.byUseCase.length).toBe(2);
    expect(body.byLedger.length).toBe(2);
    expect(body.totals.holders).toBe(2);
  });

  it("scoped user sees only their use case; foreign useCaseKey query does not leak", async () => {
    app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // Seed audit data in BOTH use cases as admin.
    const carbonId = await issue(admin, "carbon-credit", "fabric");
    await app.inject({ method: "POST", url: `${V1}/assets/${carbonId}/actions/allow`, headers: auth(admin), payload: { account: ACCOUNTS.ALICE } });
    await mint(admin, carbonId, ACCOUNTS.ALICE, "1000");
    const goldId = await issue(admin, "gold-loan", "canton");
    await app.inject({ method: "POST", url: `${V1}/assets/${goldId}/actions/allow`, headers: auth(admin), payload: { account: ACCOUNTS.BOB } });
    await mint(admin, goldId, ACCOUNTS.BOB, "777");

    // Carbon issuer: use-case scoped.
    const carbonIssuer = await loginAs(app, "carbon.issuer@tokenlayer.dev", "carbon123");
    const res = await app.inject({ method: "GET", url: `${V1}/analytics`, headers: auth(carbonIssuer) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe("use-case");
    expect(body.useCaseKey).toBe("carbon-credit");
    expect(body.totals.assets).toBe(1); // only carbon
    expect(body.totals.supply).toBe("1000");
    expect(body.byUseCase).toEqual([]);

    // Attempt to leak gold-loan via query param — must be ignored.
    const leak = await app.inject({ method: "GET", url: `${V1}/analytics?useCaseKey=gold-loan`, headers: auth(carbonIssuer) });
    const leakBody = leak.json();
    expect(leakBody.useCaseKey).toBe("carbon-credit");
    expect(leakBody.totals.assets).toBe(1);
    expect(leakBody.totals.supply).toBe("1000"); // NOT 777
  });

  it("PlatformAdmin can scope to a single use case via query", async () => {
    app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const carbonId = await issue(admin, "carbon-credit", "fabric");
    await app.inject({ method: "POST", url: `${V1}/assets/${carbonId}/actions/allow`, headers: auth(admin), payload: { account: ACCOUNTS.ALICE } });
    await mint(admin, carbonId, ACCOUNTS.ALICE, "42");
    await issue(admin, "gold-loan", "canton");

    const res = await app.inject({ method: "GET", url: `${V1}/analytics?useCaseKey=carbon-credit`, headers: auth(admin) });
    const body = res.json();
    expect(body.scope).toBe("use-case");
    expect(body.useCaseKey).toBe("carbon-credit");
    expect(body.totals.assets).toBe(1);
    expect(body.totals.supply).toBe("42");
    expect(body.byUseCase).toEqual([]);
  });
});
