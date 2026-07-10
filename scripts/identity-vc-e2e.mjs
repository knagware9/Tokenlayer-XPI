// Live E2E for DID/VC identity verification. Pure HTTP: the dev /identity/mint
// endpoint produces a holder-signed Verifiable Presentation from the trusted demo
// issuer; the desk verifies it → the investor's KYC flips to approved with the
// credential's country → and the investor can now SUBSCRIBE in the portal
// (jurisdiction passes). Before verification the same investor is blocked.
const API = "http://localhost:4000/api/v1";
const TRUSTED_ISSUER = "did:key:z6MkmBbFP8p1GRsRWPBctZ9PcseXoojmFnyxuj5u9rMGa4uU";

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 260)}` : ""}`); fails++; } };
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p }, null)).json?.token;
const addr = (s) => "0x" + s.toLowerCase().padStart(40, "0");

const runId = String(Date.now()).slice(-7);
const W = addr("d1d0" + runId), PW = addr("9a4e" + runId);
const CUR = "CBDC-INR";

const platform = await login("admin@tokenlayer.dev", "admin123");
const admin = await login("m1.admin@tokenlayer.dev", "m1admin123");
if (!platform || !admin) { console.error("login failed"); process.exit(2); }

console.log("== 1) Onboard a pending investor (wallet, NO KYC country) ==");
const inv = await call("POST", "/users", { email: `did.investor.${runId}@tokenlayer.dev`, password: "invest123", role: "Buyer", walletAddress: W }, admin);
ok(inv.status === 201 && inv.json?.kycStatus === "pending", "investor created, kycStatus=pending", inv.json);
const userId = inv.json?.id;

console.log("\n== 2) Desk verifies the investor's DID/VC presentation ==");
const ch = await call("POST", `/users/${userId}/identity/challenge`, {}, admin);
ok(ch.status === 200 && !!ch.json?.challenge, "challenge issued", ch.json);
const challenge = ch.json?.challenge;
const mint = await call("POST", "/identity/mint", { claims: { country: "IN", legalName: "Asha Rao" }, challenge }, platform);
ok(mint.status === 200 && mint.json?.issuerDid === TRUSTED_ISSUER, `dev issuer minted a VP (issuer ${mint.json?.issuerDid?.slice(0, 22)}…)`, mint.json);
const presentation = mint.json?.presentation;
const verify = await call("POST", `/users/${userId}/identity/verify`, { presentation }, admin);
ok(verify.status === 200 && verify.json?.status === "approved" && verify.json?.claims?.country === "IN", "VP verified → KYC approved, country=IN", verify.json);
ok(verify.json?.did === mint.json?.holderDid, "stored DID matches the presented holder DID");

console.log("\n== 4) Verification is single-use + fail-closed ==");
const replay = await call("POST", `/users/${userId}/identity/verify`, { presentation }, admin);
ok(replay.status === 400 && replay.json?.error === "CHALLENGE_EXPIRED", `replay rejected → ${replay.json?.error} (single-use challenge)`, replay.json);
const ch2 = await call("POST", `/users/${userId}/identity/challenge`, {}, admin);
const garbage = await call("POST", `/users/${userId}/identity/verify`, { presentation: "not-a-jwt" }, admin);
ok(garbage.status === 400, `malformed presentation rejected → ${garbage.json?.error} (400, not 500)`, garbage.json);

console.log("\n== 5) Persisted KYC reflects the credential ==");
const users = (await call("GET", "/users", null, admin)).json ?? [];
const u = users.find((x) => x.id === userId);
ok(u?.kycStatus === "approved" && u?.kyc?.country === "IN" && u?.kyc?.issuerDid === TRUSTED_ISSUER, "user record: approved, country IN, issuerDid recorded", u?.kyc);

console.log("\n== 6) The verified investor can now subscribe (jurisdiction passes) ==");
// Payer treasury linked to an IN user so its mint passes jurisdiction.
const pid = await call("POST", "/users", { email: `did.payer.${runId}@tokenlayer.dev`, password: "invest123", role: "Auditor", walletAddress: PW, kyc: { legalName: "Treasury", country: "IN" } }, admin);
await call("PATCH", `/users/${pid.json?.id}`, { kycStatus: "approved" }, admin);
const issue = await call("POST", "/assets", { useCaseKey: "invoice-tokenization", name: `INV-DID-${runId}`, chainId: "fabric", initialSupply: "1000", treasuryAccount: PW, metadata: { invoiceNumber: `INV-DID-${runId}`, invoiceDate: "2026-07-02", buyerName: "ITC Limited", currency: "INR", amount: 1000000, dueDate: "2026-12-31" }, sale: { unitPrice: "900", currency: CUR, treasuryAccount: PW } }, admin);
ok(issue.status === 201, "desk issues an offering", issue.json);
const assetId = issue.json?.asset?.id;
const allow = await call("POST", `/assets/${assetId}/actions/allow`, { account: W }, admin);
ok(allow.status === 200, "investor allowlisted (only possible because KYC is now approved)", allow.json);
await call("POST", "/cash/credit", { account: W, currency: CUR, amount: "500000" }, platform);
const investor = await login(`did.investor.${runId}@tokenlayer.dev`, "invest123");
const buy = await call("POST", `/assets/${assetId}/buy`, { quantity: "200" }, investor);
ok(buy.status === 200 && buy.json?.delivered?.amount === "200", `investor subscribes 200 units for ${buy.json?.paid?.amount} ${CUR} — DID/VC identity unlocked it`, buy.json);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ DID/VC IDENTITY E2E PASSED — challenge → holder-signed VP → verify (issuer-trusted) → KYC approved → investor subscribes; replay + malformed fail closed"}`);
process.exit(fails ? 1 : 0);
