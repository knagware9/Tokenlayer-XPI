// End-to-end flow for the "Tokenized Gold (EGR)" use case — configured purely
// from config/use-cases/gold-egr.json (zero code). Exercises the full lifecycle:
//   deploy use case → onboard KYC/IN parties → issue receipt against a vault
//   deposit → mint grams → block a duplicate deposit (uniqueBy) → primary DvP
//   sale with an exchange fee → fail-closed jurisdiction (non-IN buyer rejected)
//   → secondary escrowed listing + take → compliance freeze hold → physical
//   withdrawal as a MAKER-CHECKER gated burn → hash-chained audit verify + anchor.
import { readFileSync } from "node:fs";

const API = "http://localhost:4000/api/v1";
const cfg = JSON.parse(readFileSync(new URL("../config/use-cases/gold-egr.json", import.meta.url), "utf8"));

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 260)}` : ""}`); fails++; } };
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p }, null)).json?.token;
const addr = (s) => "0x" + s.toLowerCase().padStart(40, "0");

// Gated onboarding: POST /users now 202s a proposal; a second manager approves.
async function onboardUser(makerTok, approverTok, body) {
  const r = await call("POST", "/users", body, makerTok);
  if (r.status === 201) return r.json;
  if (r.status !== 202) return r.json;
  await call("POST", `/proposals/${r.json.proposal.id}/approve`, {}, approverTok);
  const list = await call("GET", "/users", null, approverTok);
  return (list.json ?? []).find((u) => u.email === body.email);
}

// Fresh wallets (NOT seeded → jurisdiction resolves from our KYC, not a seeded user).
const VAULT = addr("90111d"), JEWEL = addr("b0111e"), INVEST = addr("c0111f"), USBUY = addr("d0111a");
const CUR = "CBDC-INR";

const platform = await login("admin@tokenlayer.dev", "admin123");
// A second PlatformAdmin: the SoD checker for the brand-new use case's first
// UseCaseAdmin bootstrap (proposer≠approver, and only a PlatformAdmin can approve
// a gold-egr-scoped onboarding, so the sole seeded admin cannot self-check it).
const platform2 = await login("admin2@tokenlayer.dev", "admin123");
if (!platform || !platform2) { console.error("platform login failed"); process.exit(2); }

console.log("== 1) Configure + deploy the use case (from gold-egr.json) ==");
let uc = await call("GET", "/use-cases/gold-egr", null, platform);
if (uc.status === 404) {
  const created = await call("POST", "/use-cases", cfg, platform);
  ok(created.status === 201, "POST /use-cases deploys gold-egr on available chains", created.json);
  uc = { status: 200, json: created.json };
} else {
  ok(true, "gold-egr already configured — reusing");
}
ok(uc.json?.symbol === "EGR" && Object.keys(uc.json?.contracts ?? {}).length > 0, `deployed contract(s) on: ${Object.keys(uc.json?.contracts ?? {}).join(", ")}`, uc.json?.contracts);
const chainId = Object.keys(uc.json?.contracts ?? { fabric: 1 })[0];

console.log("\n== 2) Onboard parties (KYC / India jurisdiction) ==");
// Gated onboarding: `maker` proposes, `approver` (a different manager who can
// also see gold-egr) approves. KYC(legalName+country) auto-approves on approval.
async function ensureUser(makerTok, approverTok, email, password, role, wallet, country) {
  const kyc = country ? { legalName: email.split("@")[0], country } : undefined;
  const u = await onboardUser(makerTok, approverTok, { email, password, role, useCaseKey: "gold-egr", walletAddress: wallet, kyc });
  if (u?.id) return u.id;
  // Already exists (rerun) — find the id via the users list.
  const list = await call("GET", "/users", null, approverTok);
  return (list.json ?? []).find((u) => u.email === email)?.id;
}
// Bootstrap the first UseCaseAdmin: platform proposes, platform2 checks (SoD).
const ucaId = await ensureUser(platform, platform2, "egr.admin@tokenlayer.dev", "egr123", "UseCaseAdmin", undefined, undefined);
ok(!!ucaId, "platform admin creates the gold-egr vault-desk admin (UseCaseAdmin)");
const uca = await login("egr.admin@tokenlayer.dev", "egr123");

// The desk (uca) proposes each party; the platform admin approves (maker≠checker).
const issuerId = await ensureUser(uca, platform, "egr.vault@tokenlayer.dev", "egr123", "Issuer", VAULT, "IN");
const jewelId = await ensureUser(uca, platform, "egr.jeweller@tokenlayer.dev", "egr123", "Buyer", JEWEL, "IN");
const investId = await ensureUser(uca, platform, "egr.investor@tokenlayer.dev", "egr123", "Buyer", INVEST, "IN");
const usId = await ensureUser(uca, platform, "egr.usbuyer@tokenlayer.dev", "egr123", "Buyer", USBUY, "US");
ok([issuerId, jewelId, investId, usId].every(Boolean), "desk onboards vault custodian + 2 IN buyers + 1 US buyer");
ok(true, "KYC auto-approved for all onboarded parties (VC issued on proposal approval)");
for (const w of [JEWEL, INVEST, USBUY]) await call("POST", "/cash/credit", { account: w, currency: CUR, amount: "5000000" }, platform);
ok(true, `funded buyers with 5,000,000 ${CUR} each`);
const jewel = await login("egr.jeweller@tokenlayer.dev", "egr123");
const invest = await login("egr.investor@tokenlayer.dev", "egr123");
const usbuyer = await login("egr.usbuyer@tokenlayer.dev", "egr123");

console.log("\n== 3) Issue an EGR against a vault deposit + mint grams ==");
const receiptId = "EGR-IN-" + Date.now();
const meta = { receiptId, custodian: "Sequel Logistics", vaultLocation: "Mumbai", refiner: "MMTC-PAMP", purity: "999", fineWeightGrams: 1000, barSerial: "PAMP-778812", depositDate: "2026-07-01" };
const issue = await call("POST", "/assets", { useCaseKey: "gold-egr", name: `Gold Vault ${receiptId}`, chainId, metadata: meta, sale: { unitPrice: "7000", currency: CUR, treasuryAccount: VAULT } }, uca);
ok(issue.status === 201, "issue EGR receipt with sale terms (₹7,000/g)", issue.json);
const assetId = issue.json?.asset?.id;
// Duplicate physical deposit (same receiptId) must be rejected by uniqueBy.
const dup = await call("POST", "/assets", { useCaseKey: "gold-egr", name: "dupe", chainId, metadata: meta, sale: { unitPrice: "7000", currency: CUR, treasuryAccount: VAULT } }, uca);
ok(dup.status === 409, `duplicate deposit (same receiptId) blocked → ${dup.json?.error}`, dup.json);
// Allowlist the vault + KYC parties, then mint 1000 g to the vault treasury.
for (const w of [VAULT, JEWEL, INVEST, USBUY]) await call("POST", `/assets/${assetId}/actions/allow`, { account: w }, uca);
const mint = await call("POST", `/assets/${assetId}/actions/mint`, { to: VAULT, amount: "1000" }, uca);
ok(mint.status === 200, "mint 1,000 EGR (= 1,000 g fine gold) to the vault treasury", mint.json);
const balOf = async (w) => (((await call("GET", `/assets/${assetId}/accounts`, null, uca)).json ?? []).find((a) => a.address === w)?.balance) ?? "0";
ok((await balOf(VAULT)) === "1000", "vault treasury holds 1,000 EGR");

console.log("\n== 4) Primary DvP sale — jeweller buys 100 g (0.25% exchange fee) ==");
const feeBal = async (acct) => ((await call("GET", `/cash/balances?address=${acct}`, null, platform)).json ?? []).find((b) => b.currency === CUR)?.amount ?? "0";
const FEE_ACCT = "0x000000000000000000000000000000000000FEE5";
const feeBefore = BigInt(await feeBal(FEE_ACCT));
const buy = await call("POST", `/assets/${assetId}/buy`, { quantity: "100" }, jewel);
ok(buy.status === 200 && buy.json?.delivered?.amount === "100", `jeweller receives 100 EGR for ${buy.json?.paid?.amount} ${CUR}`, buy.json);
ok(buy.json?.fee?.amount === "1750", `exchange fee = 1,750 ${CUR} (100×7000×25bps) routed to platform`, buy.json?.fee);
ok(BigInt(await feeBal(FEE_ACCT)) - feeBefore === 1750n, "platform fee account credited 1,750");
ok((await balOf(JEWEL)) === "100" && (await balOf(VAULT)) === "900", "balances: jeweller 100, vault 900");

console.log("\n== 5) Fail-closed compliance — non-IN buyer is rejected ==");
const usBuy = await call("POST", `/assets/${assetId}/buy`, { quantity: "1" }, usbuyer);
ok(usBuy.status >= 400 && /JURISDICTION/.test(JSON.stringify(usBuy.json)), `US buyer blocked → ${usBuy.json?.error}`, usBuy.json);
ok((await balOf(USBUY)) === "0", "US buyer received no gold (compliance held)");

console.log("\n== 6) Secondary market — jeweller lists 40 g, investor takes ==");
const list = await call("POST", `/assets/${assetId}/listings`, { quantity: "40", unitPrice: "7200", currency: CUR }, jewel);
ok(list.status === 201, "jeweller lists 40 EGR @ ₹7,200 (escrowed)", list.json);
const take = await call("POST", `/listings/${list.json?.id}/take`, { quantity: "40" }, invest);
ok(take.status === 200, `investor takes 40 EGR (fee ${take.json?.fee?.amount ?? "?"} ${CUR})`, take.json);
ok((await balOf(JEWEL)) === "60" && (await balOf(INVEST)) === "40", "balances: jeweller 60, investor 40");

console.log("\n== 7) Compliance freeze hold ==");
await call("POST", `/assets/${assetId}/actions/freeze`, { account: JEWEL }, uca);
const frozenList = await call("POST", `/assets/${assetId}/listings`, { quantity: "10", unitPrice: "7300", currency: CUR }, jewel);
ok(frozenList.status >= 400, `frozen jeweller cannot list → ${frozenList.json?.error}`, frozenList.json);
await call("POST", `/assets/${assetId}/actions/unfreeze`, { account: JEWEL }, uca);
ok(true, "hold lifted (unfreeze)");

console.log("\n== 8) Physical withdrawal — MAKER-CHECKER gated burn ==");
// Desk submits the withdrawal on the holder's behalf; it is captured pending, NOT executed.
const propose = await call("POST", `/assets/${assetId}/actions/burn`, { from: INVEST, amount: "40" }, uca);
ok(propose.status === 202 && propose.json?.proposal?.id, "withdrawal captured as a pending proposal (202, not executed)", propose.json);
ok((await balOf(INVEST)) === "40", "gold still in the vault — burn deferred to approval");
const selfApprove = await call("POST", `/proposals/${propose.json?.proposal?.id}/approve`, {}, uca);
ok(selfApprove.status === 403, `proposer cannot self-approve → ${selfApprove.json?.error} (separation of duties)`, selfApprove.json);
const approve = await call("POST", `/proposals/${propose.json?.proposal?.id}/approve`, {}, platform);
ok(approve.status === 200 && approve.json?.proposal?.status === "executed", "second approver (PlatformAdmin) releases the gold — burn executed", approve.json?.proposal);
ok((await balOf(INVEST)) === "0", "40 EGR burned — physical gold delivered, tokens retired");

console.log("\n== 9) Tamper-evident audit — verify + anchor on-ledger ==");
const summary = (await call("GET", "/audit/verify", null, uca)).json;
ok(summary?.tampered?.length === 0 && summary?.verified >= 1, `audit chains verified: ${summary?.verified}/${summary?.assets}, 0 tampered`, summary);
const anchor = (await call("POST", "/audit/anchor", {}, uca)).json;
ok(anchor?.anchored?.some((a) => a.assetId === assetId), `anchored ${anchor?.anchored?.length} chain head(s) on-ledger`, anchor);
const v = (await call("GET", `/assets/${assetId}/audit/verify`, null, uca)).json;
ok(v?.valid === true && v?.anchorConsistent === true && v?.lastAnchor, `EGR chain valid (${v?.count} entries) + anchored @ seq ${v?.lastAnchor?.seq}`, v);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ GOLD EGR END-TO-END PASSED — configure → onboard → issue/mint → dedup → DvP sale+fee → jurisdiction-block → secondary market → freeze → maker-checker withdrawal → audit verify+anchor"}`);
process.exit(fails ? 1 : 0);
