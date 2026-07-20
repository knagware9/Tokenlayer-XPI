// Live E2E for the investor portal: onboard an IN-KYC investor → subscribe to an
// offering (DvP buy) → desk settles the redemption (maker-checker) → the investor's
// /me/portfolio and /me/activity reflect exact units, values, and payments.
const API = "http://localhost:4000/api/v1";

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
  if (r.status === 201) return r.json;               // org-path callers still 201
  if (r.status !== 202) return r.json;               // let callers assert failures
  await call("POST", `/proposals/${r.json.proposal.id}/approve`, {}, approverTok);
  const list = await call("GET", "/users", null, approverTok);
  return (list.json ?? []).find((u) => u.email === body.email);
}

const runId = String(Date.now()).slice(-7);
const INVESTOR = addr("14e57" + runId), PAYER = addr("9a4e2" + runId);
const CUR = "CBDC-INR";

const admin = await login("m1.admin@tokenlayer.dev", "m1admin123");
const issuer = await login("m1.issuer@tokenlayer.dev", "m1issuer123");
const platform = await login("admin@tokenlayer.dev", "admin123");
if (!admin || !issuer || !platform) { console.error("login failed"); process.exit(2); }

console.log("== 1) Onboard the investor (IN KYC) + payer ==");
// admin (m1.admin) is the invoice-tokenization UCA → propose; platform (PlatformAdmin)
// approves (maker≠checker). Scope to invoice-tokenization so the offering below is
// buyable; KYC(legalName+country) makes approval auto-issue the VC + set approved.
async function mkUser(email, role, wallet) {
  return await onboardUser(admin, platform, { email, password: "invest123", role, useCaseKey: "invoice-tokenization", walletAddress: wallet, kyc: { legalName: email.split("@")[0], country: "IN" } });
}
const invId = await mkUser(`investor.${runId}@tokenlayer.dev`, "Buyer", INVESTOR);
const payId = await mkUser(`payer.${runId}@tokenlayer.dev`, "Auditor", PAYER);
ok(!!invId && !!payId, "investor (Buyer) + payer onboarded, KYC-approved, IN jurisdiction");
await call("POST", "/cash/credit", { account: INVESTOR, currency: CUR, amount: "900000" }, platform);
const investor = await login(`investor.${runId}@tokenlayer.dev`, "invest123");
ok(!!investor, "investor can sign in");

console.log("\n== 2) Desk issues an offering (1000 units @ ₹900) ==");
const meta = { invoiceNumber: `INV-PORTAL-${runId}`, invoiceDate: "2026-07-01", buyerName: "JSW Steel Limited", currency: "INR", amount: 1000000, dueDate: "2026-12-31" };
const issue = await call("POST", "/assets", { useCaseKey: "invoice-tokenization", name: `INV-PORTAL-${runId}`, chainId: "fabric", initialSupply: "1000", treasuryAccount: PAYER, metadata: meta, sale: { unitPrice: "900", currency: CUR, treasuryAccount: PAYER } }, admin);
ok(issue.status === 201, "offering issued with sale terms", issue.json);
const assetId = issue.json?.asset?.id;
await call("POST", `/assets/${assetId}/actions/allow`, { account: INVESTOR }, admin);

console.log("\n== 3) Investor subscribes — 400 units ==");
const buy = await call("POST", `/assets/${assetId}/buy`, { quantity: "400" }, investor);
ok(buy.status === 200 && buy.json?.paid?.amount === "360000", `subscribed 400 units for ${buy.json?.paid?.amount} ${CUR}`, buy.json);

console.log("\n== 4) /me/portfolio reflects the holding ==");
let pf = (await call("GET", "/me/portfolio", null, investor)).json;
const holding = pf?.holdings?.find((h) => h.assetId === assetId);
ok(holding?.units === "400", "holding: 400 units", pf?.holdings);
ok(holding?.value === "360000", "holding value = 360,000 (400 × 900)", holding);
ok(pf?.totalByCurrency?.[CUR] === "360000", "portfolio total = 360,000");
ok(pf?.cash?.find((c) => c.currency === CUR)?.amount === "540000", "cash = 540,000 after subscription");

console.log("\n== 5) Redemption at maturity (maker-checker) pays the investor ==");
await call("POST", "/cash/credit", { account: PAYER, currency: CUR, amount: "1000000" }, platform);
const cfs = (await call("GET", `/assets/${assetId}/cashflows`, null, admin)).json?.cashflows ?? [];
const redemption = cfs.find((c) => c.kind === "redemption");
const proposed = await call("POST", `/assets/${assetId}/cashflows/${redemption?.id}/execute`, {}, admin);
ok(proposed.status === 202, "settlement proposed (gated)", proposed.json);
const approved = await call("POST", `/proposals/${proposed.json?.proposal?.id}/approve`, {}, issuer);
ok(approved.json?.proposal?.status === "executed", "second approver executes the redemption", approved.json?.proposal);

console.log("\n== 6) /me/activity + /me/portfolio show the exact payment ==");
const act = (await call("GET", "/me/activity", null, investor)).json ?? [];
const sub = act.find((e) => e.kind === "subscribed");
const red = act.find((e) => e.kind === "redemption");
ok(sub?.units === "400" && sub?.amount === "360000", "activity: subscribed 400 units / 360,000", sub);
// splitProRata over pre-burn balances incl. payer (600/400) → investor floor share 400,000.
ok(red?.amount === "400000" && red?.units === "400", "activity: redemption paid 400,000 for 400 units (exact recorded payment)", red);
pf = (await call("GET", "/me/portfolio", null, investor)).json;
ok(pf?.cash?.find((c) => c.currency === CUR)?.amount === "940000", "cash = 940,000 (540,000 + 400,000 redemption)");
ok(!pf?.holdings?.some((h) => h.assetId === assetId), "holding retired after redemption (units burned)");

console.log("\n== 7) NO_WALLET guard ==");
const noWallet = await call("GET", "/me/portfolio", null, admin);
ok(noWallet.status === 400 && noWallet.json?.error === "NO_WALLET", "walletless desk admin → 400 NO_WALLET", noWallet.json);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ INVESTOR PORTAL E2E PASSED — onboard → subscribe → portfolio → gated redemption → exact activity payments"}`);
process.exit(fails ? 1 : 0);
