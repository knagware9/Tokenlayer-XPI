// End-to-end against REAL Besu: a verifier org requests a presentation; the holder
// consents; verification passes with issuer-trust sourced from the on-chain DID
// registry and revocation from the chain. Then revoke the credential and re-verify
// → notRevoked flips to false while the presentation's signatures still check.
//
//   node scripts/verification-e2e.mjs
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

// ── THE PRECONDITION THIS SCRIPT CANNOT ASSUME ──────────────────────────────
// Every trust check below reads the on-chain DID registry. With no registry
// deployed, NOTHING is trusted — so the script reports three confident
// UNTRUSTED_ISSUER failures that look like a policy bug and are really a
// missing environment variable. Worse, the negative case ("an untrusted issuer
// is rejected") then passes for the wrong reason, because with no registry
// every issuer is untrusted. Ask first, and say what is missing.
const registry = (await call("GET", "/registry", null, platform)).json;
if (!registry) {
  console.log("\n⊘ SKIPPED — no on-chain DID registry is deployed, so issuer trust cannot be evaluated.");
  console.log("  This script needs a real EVM chain. Start one and point the API at it:");
  console.log("    make besu-up");
  console.log("    BESU_RPC_URL=http://localhost:8545 BESU_OPERATOR_KEY=0x<qbft-genesis-key> pnpm --filter @tokenlayer/api start");
  console.log("  (the dev QBFT key is in apps/api/.env.example — never use it on a real network)");
  process.exit(2);
}
console.log(`   registry live on chain '${registry.chainId}' — DidRegistry ${String(registry.didRegistry ?? registry.address).slice(0, 12)}…\n`);

const mkOrg = async (name, orgType) => (await call("POST", "/orgs", { name, orgType }, platform)).json;
const mkMember = async (orgId, email, role, pw) => (await call("POST", `/orgs/${orgId}/users`, { email, password: pw, role }, platform)).json;

console.log("== 1) An issuer verifier-org issues KYC to a subject (its DID registered on-chain) ==");
const issuer = await mkOrg(`KYC Issuer ${runId}`, "verifier");
const ia1 = `ia1.${runId}@i.dev`, ia2 = `ia2.${runId}@i.dev`, sub = `s.${runId}@i.dev`;
await mkMember(issuer.id, ia1, "OrgAdmin", "orgadmin1"); await mkMember(issuer.id, ia2, "OrgAdmin", "orgadmin2");
const subject = await mkMember(issuer.id, sub, "Buyer", "subject1");
const it1 = await login(ia1, "orgadmin1"), it2 = await login(ia2, "orgadmin2");
const cr = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Priya", country: "IN" } }, it1);
await call("POST", `/proposals/${cr.json.proposal.id}/approve`, {}, it2);
const subjTok = await login(sub, "subject1");
const kyc = ((await call("GET", "/me/credentials", null, subjTok)).json ?? []).find((c) => c.type.includes("KycCredential"));
ok(!!kyc && !!subject.did, "issued a KYC credential to the subject", { did: subject.did });

console.log("\n== 2) A separate verifier org requests a presentation ==");
const verifier = await mkOrg(`Relying Party ${runId}`, "verifier");
const va = `va.${runId}@v.dev`;
await mkMember(verifier.id, va, "OrgAdmin", "orgadmin1");
const vt = await login(va, "orgadmin1");
const req = await call("POST", "/verification-requests", { holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "investor onboarding" }, vt);
ok(req.status === 201 && req.json.status === "pending", "verifier created a pending request (201)", req.json);
// a non-verifier org (the platform admin has no org) cannot request — sanity that the gate is real
const bad = await call("POST", "/verification-requests", { holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "x" }, platform);
ok(bad.status === 403, "a caller with no verifier org is refused (403)", bad.json);

console.log("\n== 3) The holder sees the request + consents ==");
const inbox = (await call("GET", "/me/verification-requests", null, subjTok)).json ?? [];
const entry = inbox.find((r) => r.id === req.json.id);
ok(entry?.eligibleCredentials?.some((c) => c.id === kyc.id), "the holder's inbox offers the KYC credential", entry?.eligibleCredentials);
const consent = await call("POST", `/verification-requests/${req.json.id}/consent`, { credentialIds: [kyc.id] }, subjTok);
ok(consent.status === 200 && consent.json.status === "consented", "consent signed + released the VP", consent.json);

console.log("\n== 4) The verifier verifies — trust from the on-chain DID registry ==");
const v1 = await call("GET", `/verification-requests/${req.json.id}/verify`, null, vt);
ok(v1.json?.valid === true, "verification PASSED", v1.json);
const c1 = v1.json?.credentials?.[0];
ok(c1?.checks?.signature === true, "signature verified (recomputed over the presented bytes)", c1?.checks);
ok(c1?.checks?.trusted === true, "issuer trusted via the on-chain DID registry", c1?.checks);
ok(c1?.checks?.notRevoked === true, "not revoked (chain-backed)", c1?.checks);
ok(c1?.checks?.subjectBound === true, "subject bound to the holder", c1?.checks);
ok(c1?.claims?.country === "IN", "the disclosed claim is present", c1?.claims);

console.log("\n== 5) Revoke the credential → re-verify flips notRevoked, live ==");
const rev = await call("POST", `/credentials/${kyc.id}/revoke`, { reason: "test revoke" }, it1);
await call("POST", `/proposals/${rev.json.proposal.id}/approve`, {}, it2);
const v2 = await call("GET", `/verification-requests/${req.json.id}/verify`, null, vt);
const c2 = v2.json?.credentials?.[0];
ok(c2?.checks?.notRevoked === false, "after revocation, notRevoked is false (live chain read)", c2?.checks);
ok(c2?.checks?.signature === true, "the signature STILL verifies — only revocation changed", c2?.checks);
ok(v2.json?.valid === false, "the overall presentation is now invalid", { valid: v2.json?.valid });

console.log("\n== 6) Trust comes from the CHAIN — asked both ways, against the registry itself ==");
// This section used to be `ok(true, ...)` with a comment explaining why it was
// safe to assume. An assertion that cannot fail is not a check: it passed on a
// deployment with no registry at all, while sections 4 and 5 were failing for
// exactly that reason. So ask the public resolver, and require BOTH answers.
//
// `source` is the load-bearing field. Any credential looks untrusted when the
// registry is missing, so a one-sided "untrusted is rejected" test proves
// nothing; only "this DID is trusted BECAUSE THE CHAIN SAYS SO, and that one is
// not" distinguishes a working trust path from an absent one.
const resolved = (await call("GET", `/dids/${encodeURIComponent(issuer.did)}/resolve`, null, null)).json;
const meta = resolved?.didDocumentMetadata;
ok(meta?.source === "chain", "the issuer's DID resolves FROM THE CHAIN, not from the local database", meta);
ok(meta?.registered === true && meta?.active === true, "…and the chain reports it registered and active", meta);

// The negative half: a syntactically valid did:key nobody ever registered. Same
// resolver, same chain, opposite answer — which is what makes the positive one
// mean something.
const strangerDid = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const stranger = (await call("GET", `/dids/${encodeURIComponent(strangerDid)}/resolve`, null, null)).json;
ok(stranger?.didDocumentMetadata?.registered === false,
  "an unregistered DID is reported NOT registered by the same on-chain lookup", stranger?.didDocumentMetadata);

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ VERIFIER / PRESENTATION END-TO-END PASSED — request → consent → verify, on-chain issuer trust, live revocation"}`);
process.exit(fails ? 1 : 0);
