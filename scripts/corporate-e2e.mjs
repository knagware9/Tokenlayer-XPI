// End-to-end against REAL Besu: the full corporate self-service arc, proven
// independently of our API. A company REGISTERS itself from the public endpoint
// (no token) → a pending org + a pending admin who cannot log in. A platform
// admin sees it in the approval queue and APPROVES → the org's DID is registered
// on-chain (verified by a direct eth_call to the DidRegistry, API out of the
// loop) and the org admin receives an OrganizationMembership VC + can now log in.
// The org admin then CONFIGURES a use case (maker-checker 202 proposal); the
// admin cannot self-approve (SoD); a platform admin approves → the use case is
// created org-owned and its contract deployed. Finally the org onboards its own
// Issuer and mints an asset — the corporate is tokenizing.
//
//   node scripts/corporate-e2e.mjs
import { createRequire } from "node:module";
import { availableIds, envHintFor, fetchChains, pickChain, rpcFor, rpcUrlFor, skip } from "./lib/chain-preflight.mjs";
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
const addr = (s) => "0x" + s.toLowerCase().padStart(40, "0").slice(-40);

const platform = await login("admin@tokenlayer.dev", "admin123");
if (!platform) { console.error("platform login failed — is the API up?"); process.exit(2); }

// PREFLIGHT. This script proves two on-chain facts by eth_call (the org DID's
// registration and its anchored OrganizationCredential) and then mints on a use
// case it configures itself. The anchor chain is the API's choice; the ISSUANCE
// chain is ours, so it is picked from what exists rather than pinned to Besu.
const available = availableIds(await fetchChains(API, platform));
console.log("== 0) Registries are live on-chain ==");
const reg = (await call("GET", "/registry", null, platform)).json;
if (!reg?.didRegistry) skip("this API has no on-chain identity registry — the DID and KYB anchors cannot be proved", [
  "The registries deploy at boot on REGISTRY_CHAIN_ID; without a real EVM chain there are none.",
]);
if (!rpcUrlFor(reg.chainId)) skip(`the registries are on '${reg.chainId}', which this script has no RPC URL for`, [
  `Set ${String(reg.chainId).toUpperCase()}_RPC_URL so the eth_call proofs can bypass our API.`,
]);
const rpc = rpcFor(reg.chainId);
const CHAIN = pickChain(available, ["besu", "mst"]);
if (!CHAIN) skip("no real EVM chain is available here, so the corporate has nothing to tokenize on", [
  envHintFor("besu"), `Available here: ${[...available].join(", ") || "(none)"}`,
]);
console.log(`chains: anchoring on '${reg.chainId}', the corporate will tokenize on '${CHAIN}'\n`);
ok(reg?.didRegistry?.startsWith("0x"), `DidRegistry on '${reg?.chainId}': ${reg?.didRegistry?.slice(0, 14)}…`, reg);

console.log("\n== 1) A company REGISTERS itself (public, no token) → pending org + pending admin ==");
const upload = async (label, contentType) => (await call("POST", "/orgs/register/documents", { contentType, dataBase64: Buffer.from(`%PDF-1.4 ${label} ${runId}`).toString("base64") }, null)).json;
console.log("  -- 1a) KYB documents upload (public) --");
const cinDoc = await upload("cin-cert", "application/pdf");
const gstinDoc = await upload("gstin-cert", "image/png");
ok(cinDoc?.id && cinDoc?.sha256, `CIN certificate stored (${cinDoc?.sha256?.slice(0, 12)}…)`, cinDoc);
ok(gstinDoc?.id && gstinDoc?.sha256, `GSTIN certificate stored (${gstinDoc?.sha256?.slice(0, 12)}…)`, gstinDoc);
const company = `Globex ${runId}`;
const adminEmail = `admin.${runId}@globex.example`;
const adminPass = "globexadmin1";
const registerBody = {
  company: {
    name: company, orgType: "corporate",
    cin: `U72900MH2020PTC${runId}`, pan: `AABCU${runId}R`, gstin: `27AABCU${runId}1Z5`,
    state: "Maharashtra", pincode: "400001", dateOfIncorporation: "2020-06-15",
    category: "private-limited", companyStatus: "active",
    documents: { cinCertificate: { id: cinDoc.id }, gstinCertificate: { id: gstinDoc.id } },
  },
  admin: { name: "Grace Hopper", email: adminEmail, password: adminPass },
};
const reg1 = await call("POST", "/orgs/register", registerBody, null); // no token — public
ok(reg1.status === 202 && reg1.json?.status === "pending", `registered → 202 pending (org ${reg1.json?.organizationId?.slice(0, 8)}…)`, reg1.json);
const orgId = reg1.json?.organizationId;
ok(!(await login(adminEmail, adminPass)), "the pending admin CANNOT log in yet (awaiting approval)");

console.log("\n== 2) The platform admin sees it in the approval queue — with the KYB documents ==");
const pending = (await call("GET", "/orgs?status=pending", null, platform)).json ?? [];
ok(Array.isArray(pending) && pending.some((o) => o.id === orgId), `GET /orgs?status=pending lists the new org (${pending.length} pending)`, pending.map((o) => o.name));
const mine = pending.find((o) => o.id === orgId);
ok(mine?.companyProfile?.documents?.cinCertificate?.sha256 === cinDoc.sha256, "the pending org carries the SERVER-verified CIN certificate ref (sha256 matches the upload)", mine?.companyProfile?.documents);

console.log("\n== 3) Approve → the ISSUANCE CEREMONY: DID on-chain + platform-issued OrganizationCredential + admin VC + login ==");
const appr = await call("POST", `/orgs/${orgId}/approve`, {}, platform);
ok(appr.status === 200 && appr.json?.status === "active" && appr.json?.verified === true, "approved → org active + verified", appr.json);
const orgDid = appr.json?.did;
ok(!!orgDid, `the org has a parent DID ${orgDid?.slice(0, 22)}…`, appr.json);
const { issuerDid, orgCredentialId } = appr.json ?? {};
ok(!!issuerDid && !!orgCredentialId && issuerDid !== orgDid, `the PLATFORM (issuer ${issuerDid?.slice(0, 22)}…) issued OrganizationCredential ${orgCredentialId?.slice(0, 8)}…`, appr.json);
const adminTok = await login(adminEmail, adminPass);
ok(!!adminTok, "the org admin can NOW log in (approval activated the account)");
const creds = (await call("GET", "/me/credentials", null, adminTok)).json ?? [];
const membership = creds.find((c) => c.type?.includes?.("OrganizationMembership"));
ok(!!membership?.vcJwt, "the admin holds an OrganizationMembership VC (VC-JWT present)", creds.map((c) => c.type));

console.log("\n== 4) INDEPENDENT proof — the org DID is registered + active on real Besu (eth_call, API out of the loop) ==");
const iface = new Interface(["function resolve(string) view returns (tuple(string did, address controller, bool active, uint64 registeredAt, uint64 deactivatedAt))"]);
const data = iface.encodeFunctionData("resolve", [orgDid]);
const rec = iface.decodeFunctionResult("resolve", await rpc("eth_call", [{ to: reg.didRegistry, data }, "latest"]))[0];
ok(rec.registeredAt > 0n, "eth_call resolve(orgDid) → registeredAt > 0 (the DID is genuinely on-chain)", { registeredAt: rec.registeredAt?.toString() });
ok(rec.active === true, "eth_call resolve(orgDid) → active: true");
ok(rec.did === orgDid, "the on-chain record's DID string equals the org DID we hold — no substitution", { onChain: rec.did?.slice(0, 22) });

console.log("\n== 4b) INDEPENDENT proof — the OrganizationCredential is anchored on real Besu (eth_call, API out of the loop) ==");
const vcIface = new Interface(["function statusOf(bytes32) view returns (bool exists, bool revoked, uint64 revokedAt, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt)"]);
const st = vcIface.decodeFunctionResult("statusOf", await rpc("eth_call", [{ to: reg.vcRegistry, data: vcIface.encodeFunctionData("statusOf", [keccak256(toUtf8Bytes(orgCredentialId))]) }, "latest"]));
ok(st.exists === true && st.revoked === false, "eth_call statusOf(orgCredentialId) → exists:true, revoked:false (the platform-issued KYB attestation is on-chain)");

console.log("\n== 5) The org admin CONFIGURES a use case (maker-checker 202 proposal) ==");
const useCaseKey = `globex-bond-${runId}`;
const def = {
  key: useCaseKey, name: `Globex Bond ${runId}`, symbol: "GXB", tokenStandard: "ERC-20",
  allowedChainIds: [CHAIN], defaultChainId: CHAIN,
  metadataSchema: { type: "object", properties: {} },
  lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
  compliance: { allowlist: false, transferRestrictions: false },
  roles: ["UseCaseAdmin", "Issuer"],
};
const prop = await call("POST", "/use-cases", def, adminTok);
ok(prop.status === 202 && prop.json?.proposal?.kind === "create-use-case", "OrgAdmin POST /use-cases → 202 create-use-case proposal (NOT created yet)", prop.json);
const pid = prop.json?.proposal?.id;

console.log("\n== 6) Segregation of duties — the proposer cannot approve their own ==");
const self = await call("POST", `/proposals/${pid}/approve`, {}, adminTok);
ok(self.status === 403 && self.json?.error === "SELF_APPROVAL", `OrgAdmin self-approve REFUSED → ${self.json?.error}`, self.json);

console.log("\n== 7) The platform admin approves → the use case is created org-owned + deployed ==");
const decide = await call("POST", `/proposals/${pid}/approve`, {}, platform);
ok(decide.json?.proposal?.status === "executed", "platform admin approved → proposal executed", decide.json?.proposal);
const uc = (await call("GET", "/use-cases", null, platform)).json?.find((u) => u.key === useCaseKey);
ok(uc?.ownerOrgId === orgId, "the use case is owned by the org (ownerOrgId)", { ownerOrgId: uc?.ownerOrgId });
ok(uc && Object.keys(uc.contracts ?? {}).length > 0, "the use case's contract is deployed on-chain", { contracts: Object.keys(uc?.contracts ?? {}) });

console.log("\n== 8) The corporate now tokenizes — onboard an Issuer + mint an asset ==");
const issuerEmail = `issuer.${runId}@globex.example`;
const issuer = await call("POST", `/orgs/${orgId}/users`, { email: issuerEmail, password: "globexissuer1", role: "Issuer", useCaseKey }, adminTok);
ok(issuer.status === 201 && !!issuer.json?.did, "the org onboarded an Issuer (sub-DID + membership VC minted)", issuer.json?.error ?? { did: issuer.json?.did?.slice(0, 22) });
const issuerTok = await login(issuerEmail, "globexissuer1");
const asset = await call("POST", "/assets", { useCaseKey, name: `Bond Series ${runId}`, chainId: CHAIN, initialSupply: "1000", treasuryAccount: addr("b09d" + runId), metadata: {} }, issuerTok);
ok(asset.status === 201 && !!asset.json?.asset?.id, `the Issuer minted a bond asset on ${CHAIN} — the corporate is tokenizing`, asset.json?.error ?? asset.json?.asset?.id);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : `✅ CORPORATE SELF-SERVICE END-TO-END PASSED — KYB documents uploaded → public self-registration → platform approval issues the DID (registered on real ${reg.chainId}) AND a platform-signed OrganizationCredential (anchored, both proven by eth_call) → membership VC + login → gated use-case config (SoD enforced) → org-owned deploy → the corporate onboards an Issuer and mints an asset`}`);
process.exit(fails ? 1 : 0);
