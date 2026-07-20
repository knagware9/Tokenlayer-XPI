// End-to-end against REAL Besu: gated onboarding + identity revoke, proven
// independently of our API. A use-case admin PROPOSES a Buyer with KYC; the
// proposer cannot self-approve (SoD); a platform admin approves; the onboarding
// mints a custodial DID + a KycCredential that is ANCHORED on-chain — verified by
// a direct eth_call to the VcRegistry (API out of the loop). Then a gated
// revoke-identity flips the credential on-chain (eth_call), the KYC gate refuses
// the wallet, but the user can STILL log in (identity revoke ≠ deactivation).
//
//   node scripts/onboarding-e2e.mjs
import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/adapters/package.json", import.meta.url));
const { keccak256, toUtf8Bytes, Interface } = require("ethers");

const API = process.env.API ?? "http://localhost:4000/api/v1";
const RPC = process.env.BESU_RPC_URL ?? "http://localhost:8545";
const runId = String(Date.now()).slice(-7);

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 260)}` : ""}`); fails++; } };
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p }, null)).json?.token;
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
const addr = (s) => "0x" + s.toLowerCase().padStart(40, "0");

const platform = await login("admin@tokenlayer.dev", "admin123");
const carbon = await login("carbon.admin@tokenlayer.dev", "carbon123");   // a UseCaseAdmin of carbon-credit
if (!platform || !carbon) { console.error("login failed", { platform: !!platform, carbon: !!carbon }); process.exit(2); }
const iface = new Interface(["function statusOf(bytes32) view returns (bool exists, bool revoked, uint64 revokedAt, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt)"]);
const statusOf = async (vcRegistry, credentialId) =>
  iface.decodeFunctionResult("statusOf", await rpc("eth_call", [{ to: vcRegistry, data: iface.encodeFunctionData("statusOf", [keccak256(toUtf8Bytes(credentialId))]) }, "latest"]));

console.log("== 0) Registries are live on-chain ==");
const reg = (await call("GET", "/registry", null, platform)).json;
ok(reg?.vcRegistry?.startsWith("0x"), `VcRegistry on '${reg?.chainId}': ${reg?.vcRegistry?.slice(0, 14)}…`, reg);

console.log("\n== 1) A use-case admin PROPOSES onboarding a Buyer with KYC (India) ==");
const WALLET = addr("cab0a5e7" + runId);
const email = `gated.buyer.${runId}@tokenlayer.dev`;
const propose = await call("POST", "/users", { email, password: "gated123", role: "Buyer", useCaseKey: "carbon-credit", walletAddress: WALLET, kyc: { legalName: "Asha Rao", country: "IN" } }, carbon);
ok(propose.status === 202 && propose.json?.proposal?.kind === "onboard-user", "proposal created (202, kind onboard-user) — the user does NOT exist yet", propose.json);
const proposalId = propose.json?.proposal?.id;

console.log("\n== 2) Segregation of duties — the proposer cannot approve their own ==");
const self = await call("POST", `/proposals/${proposalId}/approve`, {}, carbon);
ok(self.status === 403 && self.json?.error === "SELF_APPROVAL", `proposer self-approve REFUSED → ${self.json?.error}`, self.json);

console.log("\n== 3) A platform admin approves → user + custodial DID + anchored KYC VC ==");
const appr = await call("POST", `/proposals/${proposalId}/approve`, {}, platform);
ok(appr.json?.proposal?.status === "executed", "second manager approved → proposal executed", appr.json?.proposal);
const subjTok = await login(email, "gated123");
ok(!!subjTok, "the onboarded user can now log in");
const me = (await call("GET", "/users", null, platform)).json?.find((u) => u.email === email);
ok(me?.kycStatus === "approved" && !!me?.kyc?.credentialId, "user is KYC-approved with a credentialId", me?.kyc);
const creds = (await call("GET", "/me/credentials", null, subjTok)).json ?? [];
const kyc = creds.find((c) => c.type?.includes?.("KycCredential") || c.type === "KycCredential") ?? creds[0];
ok(!!kyc?.id && !!kyc?.vcJwt, "the holder holds one KycCredential (VC-JWT present)", { id: kyc?.id });

console.log("\n== 4) INDEPENDENT proof — the VC is anchored on real Besu (eth_call, API out of the loop) ==");
const d1 = await statusOf(reg.vcRegistry, kyc.id);
ok(d1.exists === true && d1.revoked === false, "eth_call statusOf → exists:true, revoked:false");
ok(d1.vcHash === keccak256(toUtf8Bytes(kyc.vcJwt)), "on-chain vcHash == keccak256(the VC-JWT we hold) — tamper-evident", { onChain: d1.vcHash });

console.log("\n== 5) The KYC gate lets the approved holder be allowlisted ==");
const asset = await call("POST", "/assets", { useCaseKey: "carbon-credit", name: `Gate ${runId}`, chainId: "besu", initialSupply: "1000", treasuryAccount: addr("caf00d" + runId), metadata: { projectName: "P", registry: "Verra", vintage: 2024 } }, carbon);
const assetId = asset.json?.asset?.id;
ok(asset.status === 201 && !!assetId, "issued a carbon asset on besu to allowlist against", asset.json?.error ?? assetId);
const allowOk = await call("POST", `/assets/${assetId}/actions/allow`, { account: WALLET }, carbon);
ok(allowOk.status === 200, "the approved holder's wallet is allowlisted (200)", allowOk.json);

console.log("\n== 6) Gated identity revoke — chain-first ==");
const rp = await call("POST", `/users/${me.id}/revoke-identity`, { reason: "left the programme" }, carbon);
ok(rp.status === 202 && rp.json?.proposal?.kind === "revoke-user-identity", "revoke-identity proposal created (202)", rp.json);
const dupe = await call("POST", `/users/${me.id}/revoke-identity`, { reason: "again" }, carbon);
ok(dupe.status === 409 && dupe.json?.error === "ALREADY_PENDING", "a duplicate pending revoke is refused (409 ALREADY_PENDING)", dupe.json);
const rappr = await call("POST", `/proposals/${rp.json.proposal.id}/approve`, {}, platform);
ok(rappr.json?.proposal?.status === "executed", "platform admin approved the revoke → executed", rappr.json?.proposal);

console.log("\n== 7) INDEPENDENT proof — the revocation is on-chain, and the KYC gate now refuses ==");
const d2 = await statusOf(reg.vcRegistry, kyc.id);
ok(d2.revoked === true, "eth_call statusOf → revoked:true (confirmed on-chain, independently of our API)");
const st = (await call("GET", `/credentials/${kyc.id}/status`, null, platform)).json;
ok(st?.revoked === true && st?.source === "chain", "GET /credentials/:id/status → revoked, source: chain", st);
const asset2 = await call("POST", "/assets", { useCaseKey: "carbon-credit", name: `Gate2 ${runId}`, chainId: "besu", initialSupply: "1", treasuryAccount: addr("caf11e" + runId), metadata: { projectName: "P", registry: "Verra", vintage: 2024 } }, carbon);
const blocked = await call("POST", `/assets/${asset2.json?.asset?.id}/actions/allow`, { account: WALLET }, carbon);
ok(blocked.status === 400 && blocked.json?.error === "KYC_NOT_APPROVED", `the revoked holder can no longer be allowlisted → ${blocked.json?.error}`, blocked.json);

console.log("\n== 8) Identity revoke ≠ deactivation — the user can still log in ==");
ok(!!(await login(email, "gated123")), "the user can STILL log in (their portfolio remains readable)");

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ GATED ONBOARDING END-TO-END PASSED — propose→approve (SoD), custodial DID + KYC VC anchored on real Besu (eth_call), gate enforced, revoke flips it on-chain, login survives"}`);
process.exit(fails ? 1 : 0);
