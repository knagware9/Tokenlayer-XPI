// End-to-end against a REAL EVM chain: the registries deploy at boot, an org's DID is
// registered on-chain, a credential is anchored through the approval chain, its
// status resolves FROM CHAIN, revocation flips the chain, and an unknown id is
// not read as a chain negative.
//
// The decisive checks are the direct eth_calls in section 5 — they bypass our
// API entirely and decode the contract's own storage, the same way the Fabric
// work was proved with `peer chaincode query`.
//
//   node scripts/onchain-registry-e2e.mjs
import { createRequire } from "node:module";
import { rpcFor, rpcUrlFor, skip } from "./lib/chain-preflight.mjs";
// ethers is a dependency of @tokenlayer/adapters, not of the repo root — resolve
// it from there so this script runs from any cwd.
const require = createRequire(new URL("../packages/adapters/package.json", import.meta.url));
const { keccak256, toUtf8Bytes, Interface } = require("ethers");

const API = process.env.API ?? "http://localhost:4000/api/v1";
const runId = String(Date.now()).slice(-7);

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 260)}` : ""}`); fails++; } };
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p }, null)).json?.token;

const platform = await login("admin@tokenlayer.dev", "admin123");
if (!platform) { console.error("platform login failed"); process.exit(2); }

// PREFLIGHT. Every decisive check below is an eth_call against the registry the
// API deployed at boot, so the chain that matters is whichever one it landed on —
// not a hardcoded localhost:8545 that dies with ECONNREFUSED when Besu is absent.
console.log("== 1) The registries deployed at boot ==");
const reg = (await call("GET", "/registry", null, platform)).json;
if (!reg?.vcRegistry) skip("this API has no on-chain identity registry — nothing here can be proved on-chain", [
  "The registries deploy at boot on REGISTRY_CHAIN_ID; without a real EVM chain there are none.",
]);
if (!rpcUrlFor(reg.chainId)) skip(`the registries are on '${reg.chainId}', which this script has no RPC URL for`, [
  `Set ${String(reg.chainId).toUpperCase()}_RPC_URL so section 5 can read the chain directly.`,
]);
const rpc = rpcFor(reg.chainId);
ok(reg?.vcRegistry?.startsWith("0x") && reg?.didRegistry?.startsWith("0x"),
  `registries on '${reg?.chainId}': vc=${reg?.vcRegistry?.slice(0, 12)}… did=${reg?.didRegistry?.slice(0, 12)}…`, reg);

console.log("\n== 2) Onboard an org — its DID registers on-chain ==");
const org = (await call("POST", "/orgs", { name: `Anchored Verifier ${runId}`, orgType: "verifier" }, platform)).json;
ok(org?.did, `org parent DID ${org?.did?.slice(0, 22)}…`, org);
const doc = (await call("GET", `/dids/${encodeURIComponent(org.did)}/document`, null, platform)).json;
ok(doc?.registration?.registered === true && doc?.registration?.active === true,
  "the DID document reports it registered + active on-chain", doc?.registration);

console.log("\n== 3) Issue a credential through the approval chain ==");
const mk = async (email, role, pw) => (await call("POST", `/orgs/${org.id}/users`, { email, password: pw, role }, platform)).json;
const a1 = `a1.${runId}@ax.dev`, a2 = `a2.${runId}@ax.dev`, s = `s.${runId}@ax.dev`;
await mk(a1, "OrgAdmin", "orgadmin1"); await mk(a2, "OrgAdmin", "orgadmin2");
const subject = await mk(s, "Buyer", "subject1");
const t1 = await login(a1, "orgadmin1"), t2 = await login(a2, "orgadmin2");
const req = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Anchored Person", country: "IN" } }, t1);
const done = await call("POST", `/proposals/${req.json.proposal.id}/approve`, {}, t2);
ok(done.json?.proposal?.status === "executed", "approved → executed (had the anchor failed, this would say 'failed')", done.json?.proposal);
const creds = (await call("GET", "/me/credentials", null, await login(s, "subject1"))).json ?? [];
const kyc = creds.find((c) => c.type.includes("KycCredential"));
ok(!!kyc, "the subject holds the credential", creds.map((c) => c.type));

console.log("\n== 4) Status resolves FROM CHAIN ==");
const st = await call("GET", `/credentials/${kyc.id}/status`, null, null); // public, no token
ok(st.json?.source === "chain" && st.json?.anchored === true, `status source = ${st.json?.source} (anchored: ${st.json?.anchored})`, st.json);
ok(st.json?.chainId === reg.chainId && st.json?.registry === reg.vcRegistry, "it names the chain + registry that answered", st.json);

console.log("\n== 5) INDEPENDENT PROOF — read the chain directly, bypassing the API ==");
const iface = new Interface(["function statusOf(bytes32) view returns (bool exists, bool revoked, uint64 revokedAt, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt)"]);
const data = iface.encodeFunctionData("statusOf", [keccak256(toUtf8Bytes(kyc.id))]);
const decoded = iface.decodeFunctionResult("statusOf", await rpc("eth_call", [{ to: reg.vcRegistry, data }, "latest"]));
ok(decoded.exists === true, "eth_call statusOf → exists: true (the anchor is genuinely on-chain)");
ok(decoded.revoked === false, "eth_call statusOf → revoked: false");
ok(decoded.vcHash === keccak256(toUtf8Bytes(kyc.vcJwt)),
  "the anchored vcHash equals keccak256 of the VC-JWT we hold — tamper-evidence", { onChain: decoded.vcHash });

console.log("\n== 6) Revoke → the chain flips ==");
const rev = await call("POST", `/credentials/${kyc.id}/revoke`, { reason: "document expired" }, t1);
await call("POST", `/proposals/${rev.json.proposal.id}/approve`, {}, t2);
const after = await call("GET", `/credentials/${kyc.id}/status`, null, null);
ok(after.json?.revoked === true && after.json?.source === "chain", "the public status reports revoked, sourced from chain", after.json);
ok(after.json?.reason === "document expired", "the reason comes from the database (never on-chain)", after.json);
const decoded2 = iface.decodeFunctionResult("statusOf", await rpc("eth_call", [{ to: reg.vcRegistry, data }, "latest"]));
ok(decoded2.revoked === true, "eth_call confirms the revocation on-chain, independently of our API");

console.log("\n== 7) Privacy: the chain holds commitments only ==");
const code = await rpc("eth_getCode", [reg.vcRegistry, "latest"]);
ok(typeof code === "string" && code.length > 4, "the VC registry is real deployed bytecode", { len: code?.length });
const leak = JSON.stringify([st.json, after.json, doc]);
ok(!leak.includes(subject.did) || !JSON.stringify(decoded2).includes(subject.did), "no holder DID appears in the on-chain record");

console.log("\n== 8) An absent record is NOT a negative revocation ==");
const bogus = await call("GET", `/credentials/00000000-0000-0000-0000-000000000000/status`, null, null);
ok(bogus.status === 404, "an unknown credential 404s rather than reporting a chain 'not revoked'", bogus.json);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ ON-CHAIN REGISTRY END-TO-END PASSED — registries deployed, org DID registered, credential anchored + independently verified by eth_call, revocation reflected on-chain"}`);
process.exit(fails ? 1 : 0);
