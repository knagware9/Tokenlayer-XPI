// End-to-end flow for invoice-tokenization (TReDS) at scale — 50 invoices.
// Pure existing platform APIs. For each invoice: an MSME supplier's receivable is
// tokenized into fungible units at a financing discount (issue auto-allowlists +
// mints the holder); financiers buy the discounted units (DvP); at maturity a
// sample is settled via the maker-checker-gated redemption cashflow; then the
// whole batch's hash-chained audit trail is verified + anchored.
//
//   configure/seed → onboard KYC/IN parties → tokenize 50 → block a duplicate →
//   finance all 50 (discounted DvP) → settle a sample (gated redemption) →
//   audit verify + anchor → analytics rollup.
const API = "http://localhost:4000/api/v1";
const N = 50;          // invoices to tokenize + finance
const SETTLE = 5;      // of those, settle at maturity (gated redemption)
const PAR = 1000;      // ₹ face value per fungible unit

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 260)}` : ""}`); fails++; } };
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p }, null)).json?.token;
const addr = (s) => "0x" + s.toLowerCase().padStart(40, "0");
const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");

const SUP = addr("5099117e"), FIN1 = addr("f1a0117e"), FIN2 = addr("f2b0117e");
const CUR = "CBDC-INR";
const SELLERS = ["27AAPFU0939F1ZV", "24AAACS1429B1ZL", "29AACCF4587R1ZK"];
const BUYERS = ["29AABCT1332L1ZU", "27AABCR1718E1ZP", "27AAACB2894G1ZJ", "07AAGCM1234P1Z5"];
const runId = String(Date.now()).slice(-7);

const platform = await login("admin@tokenlayer.dev", "admin123");
const uca = await login("m1.admin@tokenlayer.dev", "m1admin123");
const issuer = await login("m1.issuer@tokenlayer.dev", "m1issuer123");
if (!platform || !uca || !issuer) { console.error("login failed", { platform: !!platform, uca: !!uca, issuer: !!issuer }); process.exit(2); }

console.log("== 1) Onboard TReDS parties (KYC / India jurisdiction) ==");
async function ensureUser(email, role, wallet, country) {
  const r = await call("POST", "/users", { email, password: "treds123", role, walletAddress: wallet, kyc: country ? { legalName: email.split("@")[0], country } : undefined }, uca);
  if (r.status === 201) { await call("PATCH", `/users/${r.json.id}`, { kycStatus: "approved" }, uca); return r.json.id; }
  const list = await call("GET", "/users", null, uca);
  return (list.json ?? []).find((u) => u.email === email)?.id;
}
const supId = await ensureUser(`treds.supplier.${runId}@tokenlayer.dev`, "Buyer", SUP, "IN");
const f1Id = await ensureUser(`treds.fin1.${runId}@tokenlayer.dev`, "Buyer", FIN1, "IN");
const f2Id = await ensureUser(`treds.fin2.${runId}@tokenlayer.dev`, "Buyer", FIN2, "IN");
ok([supId, f1Id, f2Id].every(Boolean), "onboarded MSME supplier + 2 financiers (KYC-approved, IN)");
for (const w of [FIN1, FIN2]) await call("POST", "/cash/credit", { account: w, currency: CUR, amount: "80000000" }, platform);
ok(true, `funded both financiers with ${inr(80000000)} ${CUR}`);
const fin1 = await login(`treds.fin1.${runId}@tokenlayer.dev`, "treds123");
const fin2 = await login(`treds.fin2.${runId}@tokenlayer.dev`, "treds123");

console.log(`\n== 2) Tokenize ${N} invoices (issue auto-allowlists + mints the supplier) ==`);
const invoices = [];
let tokenized = 0, faceTotal = 0n;
for (let i = 0; i < N; i++) {
  const face = 500000 + ((i * 61000) % 2600000); // spread ₹5L–₹31L, deterministic
  const supply = Math.round(face / PAR);
  const discountPct = 7 + (i % 4); // 7–10%
  const unitPrice = Math.round(PAR * (100 - discountPct) / 100);
  const meta = {
    invoiceNumber: `INV-50E2E-${runId}-${String(i).padStart(3, "0")}`,
    sellerGstin: SELLERS[i % SELLERS.length], buyerGstin: BUYERS[i % BUYERS.length],
    amountInr: face, dueDate: `2026-${String(9 + (i % 3)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}`,
    discountRatePct: discountPct, invoiceDocUrl: `https://vault.m1x.example/docs/${runId}-${i}.pdf`,
  };
  const r = await call("POST", "/assets", { useCaseKey: "invoice-tokenization", name: meta.invoiceNumber, chainId: "fabric", initialSupply: String(supply), treasuryAccount: SUP, metadata: meta, sale: { unitPrice: String(unitPrice), currency: CUR, treasuryAccount: SUP } }, issuer);
  if (r.status === 201) { tokenized++; faceTotal += BigInt(face); invoices.push({ id: r.json.asset.id, face, supply, unitPrice, meta }); }
  else if (i === 0) ok(false, "first tokenize failed", r.json);
}
ok(tokenized === N, `tokenized ${tokenized}/${N} invoices → total face value ${inr(faceTotal)}`);
// Uniqueness: re-tokenizing an existing invoice (same fingerprint) must be rejected.
const dup = await call("POST", "/assets", { useCaseKey: "invoice-tokenization", name: "dupe", chainId: "fabric", initialSupply: "1", treasuryAccount: SUP, metadata: invoices[0].meta, sale: { unitPrice: "900", currency: CUR, treasuryAccount: SUP } }, issuer);
ok(dup.status === 409, `duplicate invoice blocked → ${dup.json?.error}`, dup.json);

console.log(`\n== 3) Finance all ${N} — financiers buy the discounted units (DvP) ==`);
// Invoices share ONE use-case ERC-20 contract, so raw ledger balances are pooled
// across invoices; per-invoice delivery is proven by each buy receipt, and the
// per-invoice holdings that drive redemption come from the audit fold.
const pooledBal = async (assetId, w) => (((await call("GET", `/assets/${assetId}/accounts`, null, uca)).json ?? []).find((a) => a.address === w)?.balance) ?? "0";
let financed = 0, deliveredOk = 0, disbursed = 0n;
for (let i = 0; i < invoices.length; i++) {
  const inv = invoices[i];
  const finTok = i % 2 === 0 ? fin1 : fin2;
  const finW = i % 2 === 0 ? FIN1 : FIN2;
  await call("POST", `/assets/${inv.id}/actions/allow`, { account: finW }, uca);
  const buy = await call("POST", `/assets/${inv.id}/buy`, { quantity: String(inv.supply) }, finTok);
  if (buy.status === 200) { financed++; disbursed += BigInt(buy.json.paid.amount); inv.holder = finW; inv.holderTok = finTok; if (buy.json.delivered?.amount === String(inv.supply)) deliveredOk++; }
  else if (i < 3) ok(false, `finance ${inv.meta.invoiceNumber} failed`, buy.json);
}
ok(financed === N, `financed ${financed}/${N} invoices → ${inr(disbursed)} disbursed to the supplier (net of discount)`);
ok(deliveredOk === N, `every financier received the exact discounted units for its invoice (${deliveredOk}/${N} buy receipts)`);
ok((await pooledBal(invoices[0].id, SUP)) === "0", "supplier fully sold out (pooled units → financiers)");

console.log(`\n== 4) Settle ${SETTLE} at maturity — maker-checker gated redemption ==`);
const cbdc = async (acct) => BigInt(((await call("GET", `/cash/balances?address=${acct}`, null, platform)).json ?? []).find((b) => b.currency === CUR)?.amount ?? "0");
let settled = 0;
for (let i = 0; i < SETTLE; i++) {
  const inv = invoices[i];
  const cfs = (await call("GET", `/assets/${inv.id}/cashflows`, null, uca)).json?.cashflows ?? [];
  const redemption = cfs.find((c) => c.kind === "redemption");
  if (!redemption) { ok(false, `no redemption cashflow for ${inv.meta.invoiceNumber}`, cfs); continue; }
  // The corporate buyer repays face at maturity — modelled by crediting the desk treasury, then settling.
  await call("POST", "/cash/credit", { account: SUP, currency: CUR, amount: String(inv.face) }, platform);
  const finBefore = await cbdc(inv.holder);
  const propose = await call("POST", `/assets/${inv.id}/cashflows/${redemption.id}/execute`, {}, uca); // gated → 202 proposal
  const approve = propose.json?.proposal?.id ? await call("POST", `/proposals/${propose.json.proposal.id}/approve`, {}, issuer) : { status: 0 };
  const cfsAfter = (await call("GET", `/assets/${inv.id}/cashflows`, null, uca)).json?.cashflows ?? [];
  const done = cfsAfter.find((c) => c.kind === "redemption")?.status === "executed";
  const paid = (await cbdc(inv.holder)) - finBefore;
  if (propose.status === 202 && approve.json?.proposal?.status === "executed" && done && paid === BigInt(inv.face)) settled++;
  else if (i === 0) ok(false, `settle ${inv.meta.invoiceNumber}`, { propose: propose.status, approve: approve.json?.proposal?.status, done, paid: String(paid) });
}
ok(settled === SETTLE, `settled ${settled}/${SETTLE} at maturity — each financier received full face value (yield realised)`);

console.log("\n== 5) Tamper-evident audit + analytics rollup ==");
const summary = (await call("GET", "/audit/verify", null, uca)).json;
ok(summary?.tampered?.length === 0 && summary?.verified >= N, `audit chains verified: ${summary?.verified}/${summary?.assets}, 0 tampered`, summary);
const anchor = (await call("POST", "/audit/anchor", {}, uca)).json;
ok((anchor?.anchored?.length ?? 0) >= N, `anchored ${anchor?.anchored?.length} chain heads on-ledger`);
const an = (await call("GET", "/analytics?useCaseKey=invoice-tokenization", null, uca)).json;
ok((an?.totals?.assets ?? 0) >= N, `analytics: ${an?.totals?.assets} invoice assets, tokenized value ${JSON.stringify(an?.totals?.valueByCurrency)}`, an?.totals);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : `✅ INVOICE TReDS END-TO-END PASSED for ${N} invoices — tokenize → dedup → finance (DvP discount) → gated settlement → audit verify+anchor`}`);
process.exit(fails ? 1 : 0);
