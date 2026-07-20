// End-to-end: DID/VC identity → invoice tokenization on REAL Fabric.
//
// The whole point is the CAUSAL link: an MSME supplier and a financier are
// onboarded with NO KYC, prove their identity with a holder-signed Verifiable
// Presentation from a trusted issuer (challenge → VP → verify), and ONLY THEN
// can the receivable be tokenized to the supplier and financed by the financier
// — because the invoice-tokenization use case gates allowlisting on KYC approval
// and minting/transfer on IN jurisdiction. We prove the gate is real by showing
// a still-pending financier is refused allowlisting, then verifying it and
// watching the same call succeed.
//
//   onboard (pending) → DID/VC verify supplier → tokenize invoice to supplier →
//   pending financier REFUSED → DID/VC verify financier → allowlist + finance
//   (DvP discount) → block a duplicate invoice → audit verify + anchor on Fabric.
const API = process.env.API ?? "http://localhost:4000/api/v1";
const CHAIN = process.env.CHAIN ?? "fabric";          // the canonical TReDS ledger
const TRUSTED_ISSUER = "did:key:z6MkmBbFP8p1GRsRWPBctZ9PcseXoojmFnyxuj5u9rMGa4uU";
const CUR = "CBDC-INR";
const PAR = 1000;                                     // ₹ face value per fungible unit

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ""}`); fails++; } };
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p }, null)).json?.token;
const addr = (s) => "0x" + s.toLowerCase().padStart(40, "0");
const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");
const runId = String(Date.now()).slice(-7);

// A DID/VC round-trip for one user: challenge → dev issuer mints a holder-signed
// VP with an IN credential → the desk verifies it → the user's KYC flips approved.
async function verifyIdentity(mgr, userId, legalName) {
  const ch = await call("POST", `/users/${userId}/identity/challenge`, {}, mgr);
  const challenge = ch.json?.challenge;
  if (!challenge) return { ok: false, step: "challenge", detail: ch.json };
  const mint = await call("POST", "/identity/mint", { claims: { country: "IN", legalName }, challenge }, mgr);
  if (mint.status !== 200 || mint.json?.issuerDid !== TRUSTED_ISSUER) return { ok: false, step: "mint", detail: mint.json };
  const verify = await call("POST", `/users/${userId}/identity/verify`, { presentation: mint.json.presentation }, mgr);
  const good = verify.status === 200 && verify.json?.status === "approved" && verify.json?.claims?.country === "IN";
  return { ok: good, step: "verify", detail: verify.json, holderDid: mint.json.holderDid, presentation: mint.json.presentation };
}

const platform = await login("admin@tokenlayer.dev", "admin123");
const uca = await login("m1.admin@tokenlayer.dev", "m1admin123");       // invoice use-case admin (desk)
const issuer = await login("m1.issuer@tokenlayer.dev", "m1issuer123");   // invoice issuer
if (!platform || !uca || !issuer) { console.error("login failed", { platform: !!platform, uca: !!uca, issuer: !!issuer }); process.exit(2); }

console.log("== 0) Preconditions ==");
const mintProbe = await call("POST", "/identity/mint", { claims: { country: "IN" }, challenge: "probe" }, uca);
if (mintProbe.status === 404) { console.error("❌ /identity/mint is 404 — boot the API with DEV_KYC_ISSUER_SEED + TRUSTED_KYC_ISSUERS set (see .env)."); process.exit(2); }
ok(mintProbe.status === 200, "dev issuer minter is available (DID/VC demo enabled)", mintProbe.json);

console.log("\n== 1) Onboard the MSME supplier + a financier — PENDING, no KYC country ==");
const SUP = addr("50a11e" + runId), FIN = addr("f1a11e" + runId);
const mkUser = async (email, wallet) => (await call("POST", "/users", { email, password: "didvc123", role: "Buyer", walletAddress: wallet }, uca)).json;
const supU = await mkUser(`didvc.supplier.${runId}@tokenlayer.dev`, SUP);
const finU = await mkUser(`didvc.financier.${runId}@tokenlayer.dev`, FIN);
ok(supU?.kycStatus === "pending" && finU?.kycStatus === "pending", "supplier + financier created, both kycStatus=pending", { sup: supU?.kycStatus, fin: finU?.kycStatus });

console.log("\n== 2) The supplier proves identity with a Verifiable Presentation (DID/VC) ==");
const supVC = await verifyIdentity(uca, supU.id, "Ganga MicroFab Pvt Ltd");
ok(supVC.ok, `supplier VP verified → KYC approved, country IN (holder ${supVC.holderDid?.slice(0, 22)}…)`, supVC.detail);
// Single-use: replaying the same VP must be rejected (challenge already consumed).
const replay = await call("POST", `/users/${supU.id}/identity/verify`, { presentation: supVC.presentation }, uca);
ok(replay.status === 400 && replay.json?.error === "CHALLENGE_EXPIRED", `VP replay refused → ${replay.json?.error} (single-use challenge)`, replay.json);

console.log("\n== 3) Tokenize the receivable to the (now DID/VC-verified) supplier ==");
const face = 1800000, supply = Math.round(face / PAR), discountPct = 8, unitPrice = Math.round(PAR * (100 - discountPct) / 100);
const meta = {
  invoiceNumber: `INV-DIDVC-${runId}`, invoiceDate: "2026-07-05", buyerName: "JSW Steel Limited", currency: "INR",
  amount: face, dueDate: "2026-10-15", status: "Available", discountRatePct: discountPct,
  invoiceDocUrl: `https://vault.example/${runId}.pdf`,
};
const tok = await call("POST", "/assets", { useCaseKey: "invoice-tokenization", name: meta.invoiceNumber, chainId: CHAIN, initialSupply: String(supply), treasuryAccount: SUP, metadata: meta, sale: { unitPrice: String(unitPrice), currency: CUR, treasuryAccount: SUP } }, issuer);
ok(tok.status === 201, `invoice tokenized on ${CHAIN} → ${supply} INVT units minted to the supplier (face ${inr(face)})`, tok.json);
const assetId = tok.json?.asset?.id;
const supBal = ((await call("GET", `/assets/${assetId}/accounts`, null, uca)).json ?? []).find((a) => a.address === SUP)?.balance;
ok(supBal === String(supply), `supplier holds the full tokenized receivable on-ledger (${supBal} units)`, { supBal });

console.log("\n== 4) The KYC gate is REAL — a still-pending financier is refused allowlisting ==");
const blocked = await call("POST", `/assets/${assetId}/actions/allow`, { account: FIN }, uca);
ok(blocked.status === 400 && blocked.json?.error === "KYC_NOT_APPROVED", `pending financier REFUSED allowlisting → ${blocked.json?.error}`, blocked.json);

console.log("\n== 5) The financier proves identity (DID/VC) → the same call now succeeds ==");
const finVC = await verifyIdentity(uca, finU.id, "Brookline Trade Finance");
ok(finVC.ok, `financier VP verified → KYC approved, country IN (holder ${finVC.holderDid?.slice(0, 22)}…)`, finVC.detail);
const allow = await call("POST", `/assets/${assetId}/actions/allow`, { account: FIN }, uca);
ok(allow.status === 200, "financier allowlisted — only possible because DID/VC flipped KYC to approved", allow.json);

console.log("\n== 6) Finance the invoice — financier buys the discounted units (DvP) ==");
await call("POST", "/cash/credit", { account: FIN, currency: CUR, amount: String(face) }, platform);
const fin = await login(`didvc.financier.${runId}@tokenlayer.dev`, "didvc123");
const buy = await call("POST", `/assets/${assetId}/buy`, { quantity: String(supply) }, fin);
const paid = BigInt(buy.json?.paid?.amount ?? "0"), expected = BigInt(unitPrice) * BigInt(supply);
ok(buy.status === 200 && buy.json?.delivered?.amount === String(supply), `financier received all ${supply} units (DvP)`, buy.json);
ok(paid === expected, `disbursed ${inr(paid)} to the supplier at a ${discountPct}% discount (face ${inr(face)})`, { paid: String(paid), expected: String(expected) });

console.log("\n== 7) Duplicate invoice (same fingerprint) is blocked ==");
const dup = await call("POST", "/assets", { useCaseKey: "invoice-tokenization", name: "dupe", chainId: CHAIN, initialSupply: "1", treasuryAccount: SUP, metadata: meta, sale: { unitPrice: "900", currency: CUR, treasuryAccount: SUP } }, issuer);
ok(dup.status === 409, `re-tokenizing the same invoice blocked → ${dup.json?.error}`, dup.json);

console.log(`\n== 8) Tamper-evident audit on ${CHAIN} ==`);
const summary = (await call("GET", "/audit/verify", null, uca)).json;
ok((summary?.tampered?.length ?? 1) === 0 && (summary?.verified ?? 0) >= 1, `audit chains verified: ${summary?.verified}/${summary?.assets}, 0 tampered`, summary);
const anchor = (await call("POST", "/audit/anchor", {}, uca)).json;
ok((anchor?.anchored?.length ?? 0) >= 1, `anchored ${anchor?.anchored?.length} chain head(s) on-ledger`, anchor);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : `✅ DID/VC → INVOICE TOKENIZATION END-TO-END PASSED — identity proven by VP, KYC gate enforced, receivable tokenized + financed (DvP) on real ${CHAIN}, duplicate blocked, audit verified`}`);
process.exit(fails ? 1 : 0);
