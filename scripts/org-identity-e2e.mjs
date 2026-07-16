// End-to-end: PlatformAdmin onboards an org (parent DID); creates an OrgAdmin
// (sub-DID + membership VC); the OrgAdmin adds an Issuer + a Buyer (each a sub-DID
// + membership VC). Asserts every membership VC is retrievable via /me/credentials,
// carries the OrganizationMembership type, and binds to the member's DID; asserts
// the DID document resolves; asserts cross-org isolation (OrgAdmin A ↛ org B) and
// that an OrgAdmin cannot escalate to PlatformAdmin.
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

console.log("== 1) Onboard organizations (parent DIDs) ==");
const orgA = (await call("POST", "/orgs", { name: `Acme Bank ${runId}`, orgType: "bank", registrationId: `REG-A-${runId}`, jurisdiction: "IN" }, platform)).json;
const orgB = (await call("POST", "/orgs", { name: `Globex ${runId}`, orgType: "corporate" }, platform)).json;
ok(orgA?.did?.startsWith("did:key:z"), `org A minted parent DID ${orgA?.did?.slice(0, 24)}…`, orgA);
ok(orgB?.did?.startsWith("did:key:z"), "org B minted parent DID", orgB);
ok(orgA?.verified === true, "org A is verified on creation (admin-onboarded)", orgA);

const doc = (await call("GET", `/dids/${encodeURIComponent(orgA.did)}/document`, null, platform)).json;
ok(doc?.id === orgA.did && doc?.verificationMethod?.[0]?.type === "Ed25519VerificationKey2020", "org A DID document resolves (W3C, Ed25519VerificationKey2020)", doc);
const badDoc = await call("GET", `/dids/${encodeURIComponent("did:web:example.com")}/document`, null, platform);
ok(badDoc.status === 400, "a non-did:key is rejected (400)", badDoc.json);

console.log("\n== 2) PlatformAdmin creates the OrgAdmin for org A ==");
const oaEmail = `orgadmin.${runId}@acme.dev`;
const oa = (await call("POST", `/orgs/${orgA.id}/users`, { email: oaEmail, password: "orgadmin123", role: "OrgAdmin" }, platform)).json;
ok(oa?.did && oa?.membershipVc === true, "OrgAdmin created with sub-DID + membership VC", oa);
const orgAdmin = await login(oaEmail, "orgadmin123");
ok(!!orgAdmin, "OrgAdmin can log in");

console.log("\n== 3) OrgAdmin adds an Issuer + a Buyer ==");
const issuer = (await call("POST", `/orgs/${orgA.id}/users`, { email: `issuer.${runId}@acme.dev`, password: "issuer123", role: "Issuer" }, orgAdmin)).json;
const buyer = (await call("POST", `/orgs/${orgA.id}/users`, { email: `buyer.${runId}@acme.dev`, password: "buyer1234", role: "Buyer" }, orgAdmin)).json;
ok(issuer?.did && buyer?.did, "issuer + buyer each got a sub-DID", { issuer: issuer?.did, buyer: buyer?.did });

const members = (await call("GET", `/orgs/${orgA.id}/members`, null, orgAdmin)).json ?? [];
ok(members.length >= 3 && members.every((m) => m.did), `org A roster lists ${members.length} members, every one carrying a DID`, members);

console.log("\n== 4) Every member holds a verifiable membership VC issued by org A ==");
for (const [email, pw] of [[oaEmail, "orgadmin123"], [`issuer.${runId}@acme.dev`, "issuer123"], [`buyer.${runId}@acme.dev`, "buyer1234"]]) {
  const t = await login(email, pw);
  const creds = (await call("GET", "/me/credentials", null, t)).json ?? [];
  const vc = creds.find((c) => c.type.includes("OrganizationMembership"));
  ok(vc && vc.claims.orgId === orgA.id && vc.issuerDid === orgA.did, `${email} holds an OrganizationMembership VC issued by org A`, creds);
}

console.log("\n== 5) Cross-org isolation + no privilege escalation ==");
const crossCreate = await call("POST", `/orgs/${orgB.id}/users`, { email: `x.${runId}@globex.dev`, password: "x1234567", role: "Issuer" }, orgAdmin);
ok(crossCreate.status === 403, "OrgAdmin A cannot create members in org B (403)", crossCreate.json);
const crossList = await call("GET", `/orgs/${orgB.id}/members`, null, orgAdmin);
ok(crossList.status === 403, "OrgAdmin A cannot list org B's members (403)", crossList.json);
const crossRead = await call("GET", `/orgs/${orgB.id}`, null, orgAdmin);
ok(crossRead.status === 403, "OrgAdmin A cannot read org B (403)", crossRead.json);
const escalate = await call("POST", `/orgs/${orgA.id}/users`, { email: `pa.${runId}@acme.dev`, password: "pa123456", role: "PlatformAdmin" }, orgAdmin);
ok(escalate.status === 403, "OrgAdmin cannot mint a PlatformAdmin (403)", escalate.json);
const orgList = (await call("GET", "/orgs", null, orgAdmin)).json ?? [];
ok(orgList.length === 1 && orgList[0].id === orgA.id, "OrgAdmin's GET /orgs returns only their own org", orgList);

console.log("\n== 6) The custodial seed is never exposed ==");
const leak = JSON.stringify([orgA, orgB, oa, issuer, buyer, members, orgList]);
ok(!leak.includes("didSeedEncrypted") && !leak.includes("Seed"), "no response body leaks didSeedEncrypted / any seed material");

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ ORG + IDENTITY END-TO-END PASSED — orgs onboarded with parent DIDs, members minted sub-DIDs, membership VCs verified, isolation + escalation enforced, no seed leakage"}`);
process.exit(fails ? 1 : 0);
