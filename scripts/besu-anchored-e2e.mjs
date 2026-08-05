// ID-K live walkthrough on REAL BESU: provision (ID-J) → org DID registered
// on-chain → PUBLIC W3C resolver shows source:"chain" → independent eth_call
// proofs (DidRegistry.isActive + VcRegistry.statusOf) → anchored credential +
// certificate → VP verify trusts via the resolver (issuerResolution) →
// chain-first revoke flips verify + watermark.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const req = createRequire("/Users/kamleshnagware/Tokenlayer XPI/packages/adapters/package.json");
const { ethers } = req("ethers");

const API = "http://localhost:4000/api/v1";
const RPC = "http://localhost:8545";
const OUT = "/private/tmp/claude-501/-Users-kamleshnagware-Tokenlayer-XPI/9970d11e-033d-4071-9990-fb2d851347bc/scratchpad";
let fails = 0;
const ok = (c, m, d) => { console.log(`  ${c ? "✓" : "✗"} ${m}${!c && d !== undefined ? ` — ${JSON.stringify(d).slice(0,240)}` : ""}`); if (!c) fails++; };
const note = (m) => console.log(`  · ${m}`);
async function j(m, p, b, t) {
  const r = await fetch(API + p, { method: m, headers: { ...(b != null ? { "content-type": "application/json" } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b != null ? JSON.stringify(b) : undefined });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, json: body };
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
const login = async (e, p) => (await j("POST", "/auth/login", { email: e, password: p })).json?.token;
const runId = String(Date.now()).slice(-6);

const admin = await login("admin@tokenlayer.dev", "admin123");
const admin2 = await login("admin2@tokenlayer.dev", "admin123");
if (!admin || !admin2) { console.error("admin login failed"); process.exit(2); }
console.log(`ID-K anchored-on-Besu walkthrough  (run ${runId})\n`);

// registries from the API (authed /registry)
const reg = (await j("GET", "/registry", null, admin)).json;
const didRegAddr = reg?.didRegistry, vcRegAddr = reg?.vcRegistry;
ok(!!didRegAddr && !!vcRegAddr && reg?.chainId === "besu", `identity registries live on besu: did=${didRegAddr} vc=${vcRegAddr}`, reg);
const didIface = new ethers.Interface(["function isActive(string) view returns (bool)"]);
const vcIface = new ethers.Interface(["function statusOf(bytes32) view returns (bool exists, bool revoked, uint64 revokedAt, bytes32 vcHash, uint64 issuedAt, uint64 expiresAt)"]);
const ethIsActive = async (did) => didIface.decodeFunctionResult("isActive", await rpc("eth_call", [{ to: didRegAddr, data: didIface.encodeFunctionData("isActive", [did]) }, "latest"]))[0];
const ethVcStatus = async (id) => { const r = vcIface.decodeFunctionResult("statusOf", await rpc("eth_call", [{ to: vcRegAddr, data: vcIface.encodeFunctionData("statusOf", [ethers.id(id)]) }, "latest"])); return { exists: r[0], revoked: r[1] }; };

// ① provision from the domicile built-in (ID-J) — org DID registered ON-CHAIN
const orgName = `Tehsildar Besu ${runId}`;
const prov = await j("POST", "/credential-use-cases/provision", {
  templateKey: "domicile-certificate", params: { issuerOrgName: orgName },
  provisioning: { issuerOrgType: "government", createDeskUsers: true, deskEmailDomain: `besu${runId}.gov` },
}, admin);
ok(prov.status === 201, "provision from 'domicile-certificate' built-in → 201 (ID-J)", prov.json);
const uc = prov.json?.useCase, orgDid = prov.json?.org?.did;

// ② PUBLIC W3C resolver — no token — shows the on-chain state
const resolved = await (await fetch(`${API}/dids/${encodeURIComponent(orgDid)}/resolve`)).json();
ok(resolved?.didDocument?.id === orgDid && resolved?.didResolutionMetadata?.error === undefined, "PUBLIC /dids/:did/resolve returns the W3C DID document (no auth)");
const meta = resolved?.didDocumentMetadata;
ok(meta?.source === "chain" && meta?.registered === true && meta?.active === true && meta?.chainId === "besu" && meta?.registry === didRegAddr,
  `resolver didDocumentMetadata: source=chain registered active on besu @ ${meta?.registry?.slice(0,10)}…`, meta);
writeFileSync(`${OUT}/did-resolution.json`, JSON.stringify(resolved, null, 2));

// ③ INDEPENDENT eth_call proof of the DID registration
ok((await ethIsActive(orgDid)) === true, "INDEPENDENT: eth_call DidRegistry.isActive(orgDid) = true on Besu");
const badDid = "did:key:z6MkfakeUnregisteredDid00000000000000000000000";
ok((await ethIsActive(badDid)) === false, "INDEPENDENT: eth_call isActive(unregistered did) = false (negative control)");

// ④ issue a DomicileCredential → ANCHORED in the VcRegistry
const issuerLogin = prov.json.deskUsers.find((d) => d.role === "Issuer");
const holderLogin = prov.json.deskUsers.find((d) => d.role === "Holder");
const verifLogin = prov.json.deskUsers.find((d) => d.role === "Verifier");
const issuerTok = await login(issuerLogin.email, issuerLogin.password);
const holderTok = await login(holderLogin.email, holderLogin.password);
const verifTok = await login(verifLogin.email, verifLogin.password);
const holders = (await j("GET", `/credential-use-cases/${uc.key}/eligible-holders`, null, issuerTok)).json ?? [];
const subj = holders.find((h) => (h.label ?? "").includes(holderLogin.email)) ?? holders[0];
const iss = await j("POST", `/credential-use-cases/${uc.key}/credentials`, { credentialType: "DomicileCredential", [subj?.kind === "org" ? "subjectOrgId" : "subjectUserId"]: subj?.id, claims: { holderName: "Asha Rao", state: "Statelandia", district: "Central", continuousResidenceSinceYear: 2009 } }, issuerTok);
if (iss.status === 202) await j("POST", `/proposals/${iss.json.proposal.id}/approve`, {}, admin);
const held = (await j("GET", "/me/credentials", null, holderTok)).json?.find((c) => c.type.includes("DomicileCredential"));
ok(!!held, "credential issued to the provisioned Holder");
const st1 = (await j("GET", `/credentials/${held.id}/status`, null, null)).json;
ok(st1?.anchored === true && st1?.source === "chain" && st1?.revoked === false, "credential status: anchored on-chain (source: chain, not revoked)", st1);
const chainVc1 = await ethVcStatus(held.id);
ok(chainVc1.exists === true && chainVc1.revoked === false, "INDEPENDENT: eth_call VcRegistry.statusOf(credentialId) = exists, not revoked");
const pdf1 = Buffer.from(await (await fetch(`${API}/credentials/${held.id}/certificate.pdf`)).arrayBuffer());
ok(pdf1.subarray(0, 5).toString("latin1") === "%PDF-", `anchored certificate PDF renders (${pdf1.length} bytes)`);
writeFileSync(`${OUT}/besu-anchored-certificate.pdf`, pdf1);

// ⑤ VP verification — trust via the resolver, issuerResolution from Besu
const vreq = await j("POST", "/verification-requests", { holderDid: held.holderDid, requestedTypes: ["DomicileCredential"], purpose: "ID-K besu walkthrough", credentialUseCaseKey: uc.key }, verifTok);
ok(vreq.status === 201 || vreq.status === 202, "scoped Verifier requests a presentation", vreq.json);
const reqId = vreq.json?.id ?? vreq.json?.request?.id;
const consent = await j("POST", `/verification-requests/${reqId}/consent`, { credentialIds: [held.id] }, holderTok);
ok(consent.status === 200, "Holder consents (custodial VP signed)", consent.json);
const ver = await j("GET", `/verification-requests/${reqId}/verify`, null, verifTok);
const cred0 = ver.json?.credentials?.[0];
ok(ver.status === 200 && ver.json?.valid === true, "VP verifies: valid=true (trust computed via resolveDid on Besu)", ver.json);
ok(cred0?.issuerResolution?.registered === true && cred0?.issuerResolution?.active === true && cred0?.issuerResolution?.chainId === "besu",
  `verify result issuerResolution = registered+active on besu`, cred0?.issuerResolution);

// ⑥ chain-first revoke → everything flips
const rev = await j("POST", `/credentials/${held.id}/revoke`, { reason: "ID-K demo revoke" }, admin);
if (rev.status === 202) await j("POST", `/proposals/${rev.json.proposal.id}/approve`, {}, admin2);
const chainVc2 = await ethVcStatus(held.id);
ok(chainVc2.revoked === true, "INDEPENDENT: eth_call statusOf now shows revoked=true (chain-first revocation)");
const vreq2 = await j("POST", "/verification-requests", { holderDid: held.holderDid, requestedTypes: ["DomicileCredential"], purpose: "post-revoke", credentialUseCaseKey: uc.key }, verifTok);
const reqId2 = vreq2.json?.id ?? vreq2.json?.request?.id;
note(`vreq2: ${vreq2.status} id=${reqId2}`);
const consent2 = await j("POST", `/verification-requests/${reqId2}/consent`, { credentialIds: [held.id] }, holderTok);
ok(consent2.status === 400 && consent2.json?.error === "CREDENTIAL_NOT_ELIGIBLE",
  "after revoke the credential cannot even be PRESENTED (consent refused CREDENTIAL_NOT_ELIGIBLE — stricter than a failed verify)", consent2.json);
const reResolved = await (await fetch(`${API}/dids/${encodeURIComponent(orgDid)}/resolve`)).json();
ok(reResolved?.didDocumentMetadata?.active === true, "issuer DID still resolves active on-chain (revocation ≠ DID deactivation)", reResolved?.didDocumentMetadata);
const pdf2 = Buffer.from(await (await fetch(`${API}/credentials/${held.id}/certificate.pdf`)).arrayBuffer());
ok(pdf2.subarray(0, 5).toString("latin1") === "%PDF-" && pdf2.length !== pdf1.length, `revoked certificate re-renders with watermark (${pdf2.length} bytes)`);
writeFileSync(`${OUT}/besu-revoked-certificate.pdf`, pdf2);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ ID-K ANCHORED-ON-BESU WALKTHROUGH PASSED — public W3C resolver reads the live DidRegistry, verification trusts through it, credential anchored + chain-first revoked in the VcRegistry, all independently proven by eth_call."}`);
process.exit(fails ? 1 : 0);
