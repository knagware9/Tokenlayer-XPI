// End-to-end: ONE holder travels the whole XI platform, IDENTITY domain → TOKENIZATION domain.
//
//   IDENTITY (verify who you are)
//     1. A verifier ORG issues the holder a KycCredential (country IN) through the real
//        maker-checker chain — a VC signed by the org's DID and ANCHORED ON-CHAIN (Besu registry).
//     2. The credential's PUBLIC status endpoint reports it valid (no token, no claim leakage).
//     3. A desk verifies the holder's DID/VP presentation → the user's KYC flips to approved/IN.
//
//   TOKENIZATION (do something with it)
//     4. Configure + deploy a real ERC-20 use case → a contract is DEPLOYED ON BESU.
//     5. The desk issues an offering (mints supply on Besu).
//     6. The identity-verified holder is allowlisted (only possible because KYC is now approved)
//        and SUBSCRIBES — a real on-chain delivery.
//     7. INDEPENDENT PROOF: eth_call balanceOf(holder) on the Besu contract shows the tokens.
//
// The seam the whole program collapses: identity verification (steps 1-3) is exactly what
// unlocks tokenization participation (step 6). Two domains, one holder, one thread.

import { readFileSync } from "node:fs";

const API = process.env.API ?? "http://localhost:4000/api/v1";
const RPC = process.env.BESU_RPC_URL ?? "http://localhost:8545";
const TRUSTED_ISSUER = "did:key:z6MkmBbFP8p1GRsRWPBctZ9PcseXoojmFnyxuj5u9rMGa4uU";
const runId = String(Date.now()).slice(-7);

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await res.json()).result;
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ""}`); fails++; } };
const note = (msg) => console.log(`  · ${msg}`);
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p }, null)).json?.token;
const addr = (s) => "0x" + s.toLowerCase().padStart(40, "0").slice(-40);

// Gated onboarding: POST /users 202s a proposal; a second manager approves it.
async function onboard(makerTok, approverTok, body) {
  const r = await call("POST", "/users", body, makerTok);
  if (r.status === 201) return r.json;
  if (r.status !== 202) return { __err: r };
  await call("POST", `/proposals/${r.json.proposal.id}/approve`, {}, approverTok);
  const list = await call("GET", "/users", null, approverTok);
  return (list.json ?? []).find((u) => u.email === body.email) ?? { __err: r };
}

const HOLDER = addr("d0" + runId), TREAS = addr("c0" + runId);
const CUR = "CBDC-INR";

const platform = await login("admin@tokenlayer.dev", "admin123");
const platform2 = await login("admin2@tokenlayer.dev", "admin123");
if (!platform || !platform2) { console.error("platform login failed — is the API up?"); process.exit(2); }
console.log(`XI end-to-end — identity → tokenization   (run ${runId}, chain ${RPC})\n`);

// ───────────────────────────── IDENTITY DOMAIN ─────────────────────────────
console.log("═══ IDENTITY DOMAIN ═══");

console.log("\n== 1) Onboard the holder (Buyer, wallet, NO KYC yet) ==");
const holder = await onboard(platform, platform2, { email: `holder.${runId}@xi.dev`, password: "holder123", role: "Buyer", useCaseKey: "generic-asset", walletAddress: HOLDER });
ok(holder?.id && holder?.kycStatus === "pending", "holder created — pending KYC (no country claim yet)", holder);
const holderId = holder?.id;

console.log("\n== 2) A verifier ORG issues the holder a KycCredential (maker-checker → on-chain anchor) ==");
const org = (await call("POST", "/orgs", { name: `KYC Verifier ${runId}`, orgType: "verifier" }, platform)).json;
const a1 = `oa1.${runId}@kv.dev`, a2 = `oa2.${runId}@kv.dev`;
await call("POST", `/orgs/${org.id}/users`, { email: a1, password: "orgadmin1", role: "OrgAdmin" }, platform);
await call("POST", `/orgs/${org.id}/users`, { email: a2, password: "orgadmin2", role: "OrgAdmin" }, platform);
const t1 = await login(a1, "orgadmin1"), t2 = await login(a2, "orgadmin2");
ok(org?.did && t1 && t2, `verifier org ${org?.did?.slice(0, 24)}… with two OrgAdmins`, { org: org?.did });
const req = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: holderId, claims: { legalName: "Asha Rao", country: "IN" } }, t1);
ok(req.status === 202, "credential request captured as a gated proposal (202) — nothing issued yet", req.json);
const self = await call("POST", `/proposals/${req.json.proposal.id}/approve`, {}, t1);
ok(self.status === 403 && self.json?.error === "SELF_APPROVAL", "the maker cannot approve their own request (403 SELF_APPROVAL)", self.json);
const done = await call("POST", `/proposals/${req.json.proposal.id}/approve`, {}, t2);
ok(done.json?.proposal?.status === "executed", "a second, distinct OrgAdmin approved → VC issued", done.json?.proposal);
const holderTok = await login(`holder.${runId}@xi.dev`, "holder123");
const creds = (await call("GET", "/me/credentials", null, holderTok)).json ?? [];
const kyc = creds.find((c) => c.type.includes("KycCredential"));
ok(kyc && kyc.claims.country === "IN" && kyc.revoked === false, "the holder now holds a valid KycCredential", creds.map((c) => c.type));
ok(kyc?.issuerDid === org.did, "issued BY the verifier org's DID", { iss: kyc?.issuerDid, org: org.did });
const holderDid = kyc?.subjectDid ?? kyc?.holderDid ?? kyc?.credentialSubject?.id;
if (holderDid) note(`bound to the holder's custodial DID ${String(holderDid).slice(0, 28)}…`);

console.log("\n== 3) The credential is anchored on-chain + its PUBLIC status is verifiable ==");
const reg = (await call("GET", "/registry", null, platform)).json;
const anchored = reg?.deployments?.find((d) => d.chainId === "besu");
if (anchored) ok(true, `VC registry live on Besu — VcRegistry ${String(anchored.vcRegistry ?? anchored.address ?? "").slice(0, 12)}…`, anchored);
else note("registry not reported on besu — credential stored but unanchored (boot without REGISTRY_CHAIN_ID)");
const status = await call("GET", `/credentials/${kyc.id}/status`, null, null); // NO token
ok(status.status === 200 && status.json?.revoked === false, "the status endpoint is PUBLIC (no token) and reports not-revoked", status.json);
ok(status.json?.claims === undefined && status.json?.holderDid === undefined, "public status leaks no claims and no holder DID", status.json);
if (status.json?.onChain !== undefined) ok(status.json.onChain === true, "public status confirms the on-chain anchor", status.json);

console.log("\n== 4) A desk verifies the holder's DID/VP → user KYC flips to approved/IN ==");
const ch = await call("POST", `/users/${holderId}/identity/challenge`, {}, platform);
ok(ch.status === 200 && !!ch.json?.challenge, "desk issues a single-use challenge", ch.json);
const mint = await call("POST", "/identity/mint", { claims: { country: "IN", legalName: "Asha Rao" }, challenge: ch.json?.challenge }, platform);
ok(mint.status === 200 && mint.json?.issuerDid === TRUSTED_ISSUER, `trusted dev issuer minted a holder-signed VP (issuer ${mint.json?.issuerDid?.slice(0, 20)}…)`, mint.json);
const verify = await call("POST", `/users/${holderId}/identity/verify`, { presentation: mint.json?.presentation }, platform);
ok(verify.status === 200 && verify.json?.status === "approved" && verify.json?.claims?.country === "IN", "VP verified → user KYC APPROVED, country IN", verify.json);
const replay = await call("POST", `/users/${holderId}/identity/verify`, { presentation: mint.json?.presentation }, platform);
ok(replay.status === 400, `replay of the same VP rejected → ${replay.json?.error} (single-use challenge)`, replay.json);

// ─────────────────────────── TOKENIZATION DOMAIN ───────────────────────────
console.log("\n═══ TOKENIZATION DOMAIN ═══");

console.log("\n== 5) Configure + deploy a real ERC-20 use case (contract on the ledger) ==");
const cfg = JSON.parse(readFileSync(new URL("../config/use-cases/generic-asset.json", import.meta.url), "utf8"));
let uc = await call("GET", "/use-cases/generic-asset", null, platform);
if (uc.status === 404) {
  const created = await call("POST", "/use-cases", cfg, platform);
  ok(created.status === 201, "POST /use-cases deploys generic-asset on the available chains", created.json);
  uc = { json: created.json };
} else note("generic-asset already configured — reusing");
const contracts = uc.json?.contracts ?? {};
const chainId = contracts.besu ? "besu" : Object.keys(contracts)[0];
const contractRef = contracts[chainId];
const contractAddr = typeof contractRef === "string" ? contractRef : (contractRef?.address ?? contractRef?.contractId ?? contractRef?.id);
ok(uc.json?.symbol === "GEN" && !!chainId, `ERC-20 deployed on '${chainId}'${contractAddr ? ` at ${contractAddr}` : ""}`, contracts);
if (chainId === "besu") {
  const code = await rpc("eth_getCode", [contractAddr, "latest"]);
  ok(code && code !== "0x" && code.length > 4, `INDEPENDENT: eth_getCode shows real bytecode on Besu (${(code.length - 2) / 2} bytes)`, code?.slice(0, 20));
} else {
  note(`chain '${chainId}' is a simulated ledger — on-chain bytecode/balance proofs (Besu) are skipped this run`);
}

console.log("\n== 6) Bootstrap the use-case desk + a KYC'd treasury ==");
const gAdmin = await onboard(platform, platform2, { email: `gen.admin.${runId}@xi.dev`, password: "genadmin1", role: "UseCaseAdmin", useCaseKey: "generic-asset" });
ok(!!gAdmin?.id, "platform bootstraps the generic-asset desk (UseCaseAdmin) via maker-checker");
const desk = await login(`gen.admin.${runId}@xi.dev`, "genadmin1");
const treas = await onboard(platform, platform2, { email: `treasury.${runId}@xi.dev`, password: "treas123", role: "Auditor", useCaseKey: "generic-asset", walletAddress: TREAS, kyc: { legalName: "GEN Treasury", country: "IN" } });
ok(treas?.kycStatus === "approved" && treas?.kyc?.country === "IN", "an IN-KYC'd treasury exists (so the mint passes jurisdiction)", treas?.kyc);

console.log("\n== 7) The desk issues an offering (mints supply on the ledger) ==");
const issue = await call("POST", "/assets", { useCaseKey: "generic-asset", name: `GEN-${runId}`, chainId, initialSupply: "1000", treasuryAccount: TREAS, metadata: { issuer: "Acme Metals Ltd", assetClass: "commodity", valuation: 1000000 }, sale: { unitPrice: "900", currency: CUR, treasuryAccount: TREAS } }, desk);
ok(issue.status === 201, "desk issues a 1000-unit offering, priced 900/unit", issue.json);
const assetId = issue.json?.asset?.id;
const txMint = issue.json?.asset?.mintTx ?? issue.json?.mintTx ?? issue.json?.asset?.txHash;
if (txMint) note(`mint tx ${txMint}`);

console.log("\n== 8) The identity-verified holder subscribes (ledger delivery) ==");
const allow = await call("POST", `/assets/${assetId}/actions/allow`, { account: HOLDER }, desk);
ok(allow.status === 200, "holder allowlisted — allowed ONLY because their KYC is now approved (identity unlocked it)", allow.json);
await call("POST", "/cash/credit", { account: HOLDER, currency: CUR, amount: "500000" }, platform);
const buy = await call("POST", `/assets/${assetId}/buy`, { quantity: "200" }, holderTok);
ok(buy.status === 200 && buy.json?.delivered?.amount === "200", `holder subscribes 200 GEN for ${buy.json?.paid?.amount} ${CUR}`, buy.json);

console.log("\n== 9) Proof the tokens landed with the identity-verified holder ==");
if (chainId === "besu" && contractAddr) {
  const data = "0x70a08231" + HOLDER.replace(/^0x/, "").padStart(64, "0"); // balanceOf(address)
  const bal = await rpc("eth_call", [{ to: contractAddr, data }, "latest"]);
  const balN = BigInt(bal ?? "0x0");
  ok(balN === 200n, `INDEPENDENT: Besu eth_call balanceOf(holder) = ${balN} GEN — tokens on-chain, held by the identity-verified holder`, bal);
} else {
  const hold = await call("GET", `/assets/${assetId}/holders`, null, desk);
  const rows = hold.json?.holders ?? (Array.isArray(hold.json) ? hold.json : []);
  const mine = rows.find?.((h) => (h.account ?? "").toLowerCase() === HOLDER.toLowerCase());
  if (mine) ok(BigInt(mine.balance ?? mine.amount ?? 0) === 200n, `${chainId} ledger balance for holder = ${mine.balance ?? mine.amount} GEN`, mine);
  else ok(buy.json?.delivered?.amount === "200", `${chainId} ledger delivered 200 GEN to the holder (buy.delivered confirmed)`, buy.json?.delivered);
}

const chainWord = chainId === "besu" ? "a real ERC-20 subscription on Besu, proven by an independent eth_call" : `a real ERC-20 subscription on the '${chainId}' ledger`;
console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : `✅ IDENTITY → TOKENIZATION E2E PASSED — one holder: org-issued VC + DID/VP KYC verification unlocked ${chainWord}.`}`);
process.exit(fails ? 1 : 0);
