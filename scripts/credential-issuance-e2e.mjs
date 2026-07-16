// End-to-end: a verifier org issues a KycCredential to a member through the real
// maker-checker chain; a 2-approval AuthorizedSignatory; revocation flips the
// PUBLIC status endpoint; cross-org isolation and segregation of duties hold.
//
//   onboard verifier org → request (maker) → self-approve blocked → approve
//   (checker) → VC issued by the org DID → per-type depth → public status →
//   gated revocation → cross-org isolation.
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

console.log("== 1) A verifier org with two OrgAdmins + a subject ==");
const org = (await call("POST", "/orgs", { name: `KYC Verifier ${runId}`, orgType: "verifier" }, platform)).json;
const mkIn = async (orgId, email, role, pw) => (await call("POST", `/orgs/${orgId}/users`, { email, password: pw, role }, platform)).json;
const a1 = `oa1.${runId}@kv.dev`, a2 = `oa2.${runId}@kv.dev`, sub = `subject.${runId}@kv.dev`;
await mkIn(org.id, a1, "OrgAdmin", "orgadmin1");
await mkIn(org.id, a2, "OrgAdmin", "orgadmin2");
const subject = await mkIn(org.id, sub, "Buyer", "subject1");
const t1 = await login(a1, "orgadmin1"), t2 = await login(a2, "orgadmin2");
ok(org?.did && subject?.did && t1 && t2, `verifier org ${org?.did?.slice(0, 22)}… with 2 admins + a subject`, { org: org?.did });

const catalog = (await call("GET", "/credential-types", null, t1)).json ?? [];
ok(catalog.length === 3 && catalog.find((c) => c.type === "AuthorizedSignatory")?.requiredApprovals === 2,
  `catalog: ${catalog.map((c) => `${c.type}(${c.requiredApprovals})`).join(", ")}`, catalog);

console.log("\n== 2) Request a KycCredential (maker) ==");
const req = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Priya Raman", country: "IN" } }, t1);
ok(req.status === 202 && req.json?.proposal?.kind === "issue-credential", "request captured as a gated proposal (202) — nothing issued yet", req.json);
const selfApprove = await call("POST", `/proposals/${req.json.proposal.id}/approve`, {}, t1);
ok(selfApprove.status === 403 && selfApprove.json?.error === "SELF_APPROVAL", "the maker cannot approve their own request (403 SELF_APPROVAL)", selfApprove.json);

console.log("\n== 3) Approve (checker) → the VC is issued ==");
const done = await call("POST", `/proposals/${req.json.proposal.id}/approve`, {}, t2);
ok(done.json?.proposal?.status === "executed", "the second admin approved → executed", done.json?.proposal);
const subjTok = await login(sub, "subject1");
const creds = (await call("GET", "/me/credentials", null, subjTok)).json ?? [];
const kyc = creds.find((c) => c.type.includes("KycCredential"));
ok(kyc && kyc.claims.country === "IN" && kyc.revoked === false, "the subject holds a valid KycCredential", creds.map((c) => c.type));
ok(kyc?.issuerDid === org.did, "issued BY the verifier org's parent DID", { iss: kyc?.issuerDid, org: org.did });

console.log("\n== 4) AuthorizedSignatory needs TWO approvals (per-type depth) ==");
const sig = await call("POST", "/credentials/requests", { type: "AuthorizedSignatory", subjectUserId: subject.id, claims: { role: "CFO", scope: "treasury" } }, t1);
ok(sig.json?.proposal?.required === 2, "AuthorizedSignatory requires 2 approvals", sig.json?.proposal);
const one = await call("POST", `/proposals/${sig.json.proposal.id}/approve`, {}, t2);
ok(one.json?.proposal?.status === "pending", "one approval is NOT enough — still pending", one.json?.proposal);
const two = await call("POST", `/proposals/${sig.json.proposal.id}/approve`, {}, platform);
ok(two.json?.proposal?.status === "executed", "a second, distinct approver issued it", two.json?.proposal);

console.log("\n== 5) Issuer trust + claim validation are enforced ==");
const corp = (await call("POST", "/orgs", { name: `Corp ${runId}`, orgType: "corporate" }, platform)).json;
const cEmail = `oa.c.${runId}@corp.dev`;
await mkIn(corp.id, cEmail, "OrgAdmin", "orgadmin1");
const tC = await login(cEmail, "orgadmin1");
const notPermitted = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "X", country: "IN" } }, tC);
ok(notPermitted.status === 403 && notPermitted.json?.error === "ISSUER_NOT_PERMITTED", "a 'corporate' org may not issue a KycCredential (403)", notPermitted.json);
const badClaims = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "X", country: "INDIA" } }, t1);
ok(badClaims.status === 400, "a bad country code fails the type's claim schema (400)", badClaims.json);
const badType = await call("POST", "/credentials/requests", { type: "NopeCredential", subjectUserId: subject.id, claims: {} }, t1);
ok(badType.status === 400 && badType.json?.error === "UNKNOWN_CREDENTIAL_TYPE", "an unknown credential type is rejected (400)", badType.json);

console.log("\n== 6) Public status + gated revocation ==");
const before = await call("GET", `/credentials/${kyc.id}/status`, null, null); // NO token
ok(before.status === 200 && before.json?.revoked === false, "the status endpoint is PUBLIC (no token) and reports not-revoked", before.json);
const noReason = await call("POST", `/credentials/${kyc.id}/revoke`, {}, t1);
ok(noReason.status === 400, "revocation without a reason is rejected (400)", noReason.json);
const rev = await call("POST", `/credentials/${kyc.id}/revoke`, { reason: "document expired" }, t1);
ok(rev.status === 202, "revocation captured as a gated proposal (202)", rev.json);
await call("POST", `/proposals/${rev.json.proposal.id}/approve`, {}, t2);
const after = await call("GET", `/credentials/${kyc.id}/status`, null, null);
ok(after.json?.revoked === true && after.json?.reason === "document expired", "the public status flipped to revoked, with the reason", after.json);
ok(after.json?.claims === undefined && after.json?.vcJwt === undefined && after.json?.holderDid === undefined, "the public status leaks no claims, no holder and no VC", after.json);
const reRevoke = await call("POST", `/credentials/${kyc.id}/revoke`, { reason: "again" }, t1);
ok(reRevoke.status === 409, "re-revoking an already-revoked credential is a 409", reRevoke.json);

console.log("\n== 7) Cross-org isolation (the null-useCaseKey trap) ==");
const orgB = (await call("POST", "/orgs", { name: `Rival ${runId}`, orgType: "verifier" }, platform)).json;
const bEmail = `oab.${runId}@rival.dev`;
// NB: create org B's admin against orgB.id — an OrgAdmin only ever acts for their own org.
await mkIn(orgB.id, bEmail, "OrgAdmin", "orgadmin1");
const tB = await login(bEmail, "orgadmin1");
const req2 = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Second", country: "IN" } }, t1);
const listB = (await call("GET", "/proposals", null, tB)).json ?? [];
ok(!listB.some((p) => p.id === req2.json.proposal.id), "a rival OrgAdmin cannot SEE org A's credential proposal (both have useCaseKey: null)", listB.map((p) => p.id));
const approveB = await call("POST", `/proposals/${req2.json.proposal.id}/approve`, {}, tB);
ok(approveB.status === 404, "a rival OrgAdmin cannot approve it — 404, not even acknowledged", approveB.json);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ CREDENTIAL ISSUANCE END-TO-END PASSED — gated issuance, per-type depth, segregation of duties, issuer trust, claim validation, public status, revocation, cross-org isolation"}`);
process.exit(fails ? 1 : 0);
