// TWO DEPLOYMENTS, ONE HOLDER — the proof that the product split actually works.
//
// Everything before this ran inside one process, where "the identity answer" and
// "the tokenization gate" were two functions in the same binary. This talks to
// two APIs over HTTP:
//
//   IDENTITY      ENABLED_DOMAINS=identity      · its own database
//   TOKENIZATION  ENABLED_DOMAINS=tokenization  · its own database
//                 IDENTITY_SERVICE_URL/KEY → the identity deployment
//
// What it proves, in the order it matters:
//
//   1. THE BOUNDARY IS REAL both ways — each deployment 404s the other's routes.
//   2. A holder is onboarded and KYC'd on IDENTITY, and nowhere else.
//   3. The same holder is onboarded on TOKENIZATION carrying that DID (`did` on
//      POST /users). Without this the split cannot work at all: each deployment
//      would mint its own DID and the gate would ask about one the other has
//      never seen.
//   4. A `requireVerifiedIdentity` use case ADMITS them — and the tokenization
//      deployment holds no credential for them, so the yes came over the wire.
//   5. A holder with a DID that has no credential is REFUSED. Without this, a
//      gate that passed everyone would look identical to a working one.
//
// Usage (see scripts/split-topology-up.sh, which boots both and runs this):
//   IDENTITY_URL=http://localhost:4100/api/v1 \
//   TOKENIZATION_URL=http://localhost:4000/api/v1 node scripts/split-topology-e2e.mjs

const IDENTITY = process.env.IDENTITY_URL ?? "http://localhost:4100/api/v1";
const TOKENIZE = process.env.TOKENIZATION_URL ?? "http://localhost:4000/api/v1";
const runId = String(Date.now()).slice(-7);

async function call(base, method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}
const idn = (m, p, b, t) => call(IDENTITY, m, p, b, t);
const tok = (m, p, b, t) => call(TOKENIZE, m, p, b, t);

let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 300)}` : ""}`); fails++; } };
const note = (m) => console.log(`  · ${m}`);
const login = async (base, e, p) => (await call(base, "POST", "/auth/login", { email: e, password: p }, null)).json?.token;
const addr = (s) => "0x" + s.toLowerCase().padStart(40, "0").slice(-40);

/** Gated onboarding: POST /users 202s a proposal that a SECOND manager approves. */
async function onboard(base, maker, checker, body) {
  const r = await call(base, "POST", "/users", body, maker);
  if (r.status === 201) return r.json;
  if (r.status !== 202) return { __err: r };
  const ap = await call(base, "POST", `/proposals/${r.json.proposal.id}/approve`, {}, checker);
  if (ap.json?.proposal?.status !== "executed") return { __err: ap };
  const list = await call(base, "GET", "/users", null, checker);
  return (list.json ?? []).find((u) => u.email === body.email) ?? { __err: r };
}

const HOLDER = addr("da" + runId);      // verified on the identity deployment
const STRANGER = addr("db" + runId);    // a DID identity has never issued to
const TREASURY = addr("dc" + runId);
const UC = `split-gated-${runId}`;
// Seeded on any deployment that runs the identity product (see server.ts).
const IDENTITY_UC = process.env.IDENTITY_USE_CASE ?? "corp-trade-credentials";

const idAdmin = await login(IDENTITY, "admin@tokenlayer.dev", "admin123");
const idAdmin2 = await login(IDENTITY, "admin2@tokenlayer.dev", "admin123");
const tkAdmin = await login(TOKENIZE, "admin@tokenlayer.dev", "admin123");
const tkAdmin2 = await login(TOKENIZE, "admin2@tokenlayer.dev", "admin123");
if (!idAdmin || !idAdmin2) { console.error(`identity login failed — is ${IDENTITY} up?`); process.exit(2); }
if (!tkAdmin || !tkAdmin2) { console.error(`tokenization login failed — is ${TOKENIZE} up?`); process.exit(2); }

console.log(`XI split topology — identity ${IDENTITY}  ·  tokenization ${TOKENIZE}   (run ${runId})\n`);

// ─────────────────────── 1) the boundary, both directions ───────────────────
console.log("== 1) Each deployment serves ONE product ==");
{
  const a = await idn("GET", "/config", null, idAdmin);
  const b = await tok("GET", "/config", null, tkAdmin);
  ok(JSON.stringify(a.json?.domains) === '["identity"]', `identity deployment reports domains ${JSON.stringify(a.json?.domains)}`, a.json);
  ok(JSON.stringify(b.json?.domains) === '["tokenization"]', `tokenization deployment reports domains ${JSON.stringify(b.json?.domains)}`, b.json);

  const idTok = await idn("GET", "/use-cases", null, idAdmin);
  ok(idTok.status === 404 && idTok.json?.error === "DOMAIN_NOT_ENABLED", "identity 404s /use-cases — it does not sell tokenization", idTok.json);
  const idOwn = await idn("GET", "/credential-use-cases", null, idAdmin);
  ok(idOwn.status === 200, "…and serves its own /credential-use-cases", idOwn.json);

  const tkId = await tok("GET", "/credential-use-cases", null, tkAdmin);
  ok(tkId.status === 404 && tkId.json?.error === "DOMAIN_NOT_ENABLED", "tokenization 404s /credential-use-cases — the mirror", tkId.json);
  const tkOwn = await tok("GET", "/use-cases", null, tkAdmin);
  ok(tkOwn.status === 200, "…and serves its own /use-cases", tkOwn.json?.length !== undefined ? `${tkOwn.json.length} use cases` : tkOwn.json);

  // The assertion API is the ONE door between them, and it lives on identity.
  const assertHere = await tok("POST", "/identity/assertions", { subject: "did:key:zNope" }, tkAdmin);
  ok(assertHere.status === 404, "the assertion API is not served by tokenization — it is identity's door", assertHere.json);
}

// ───────────────── 2) the holder exists and is KYC'd on IDENTITY ─────────────
console.log("\n== 2) The holder is onboarded and KYC'd on the IDENTITY deployment ==");
const holderEmail = `holder.${runId}@split.dev`;
const idHolder = await onboard(IDENTITY, idAdmin, idAdmin2, {
  email: holderEmail, password: "holder123", role: "Holder", useCaseKey: IDENTITY_UC,
  kyc: { legalName: "Asha Rao", country: "IN" },
});
ok(!!idHolder?.id && idHolder?.kycStatus === "approved", "holder onboarded on identity with an approved KYC credential", idHolder?.kycStatus ?? idHolder);
const holderTok = await login(IDENTITY, holderEmail, "holder123");
const heldCredsRaw = (await idn("GET", "/me/credentials", null, holderTok)).json;
const heldCreds = Array.isArray(heldCredsRaw) ? heldCredsRaw : [];
const kycCred = heldCreds.find((c) => (c.type ?? []).includes("KycCredential"));
ok(!!kycCred && kycCred.revoked === false, "the holder holds a valid KycCredential — on the identity deployment", heldCreds.map((c) => c.type));
const holderDid = kycCred?.subjectDid ?? kycCred?.holderDid ?? idHolder?.did;
ok(typeof holderDid === "string" && holderDid.startsWith("did:key:"), `their DID is ${String(holderDid).slice(0, 30)}…`, holderDid);

// The treasury receives the mint, so it must be verified too — its own person,
// its own DID, issued the same way. (Sharing the holder's DID would work and
// would also hide a mistake: two wallets resolving to one identity.)
const treasuryEmail = `treasury.${runId}@split.dev`;
const idTreasury = await onboard(IDENTITY, idAdmin, idAdmin2, {
  email: treasuryEmail, password: "treas123", role: "Holder", useCaseKey: IDENTITY_UC,
  kyc: { legalName: "Split Treasury", country: "IN" },
});
const treasTok = await login(IDENTITY, treasuryEmail, "treas123");
const treasCredsRaw = (await idn("GET", "/me/credentials", null, treasTok)).json;
const treasCred = (Array.isArray(treasCredsRaw) ? treasCredsRaw : []).find((c) => (c.type ?? []).includes("KycCredential"));
const treasuryDid = treasCred?.subjectDid ?? treasCred?.holderDid;
ok(!!idTreasury?.id && typeof treasuryDid === "string" && treasuryDid !== holderDid,
  "a treasury identity exists, separately verified — a DIFFERENT DID", treasuryDid);

// THE CONTROL: a well-formed DID the identity deployment has never issued
// anything to. Not a broken string — a subject it simply has nothing on, which
// is the case a gate that passes everyone would answer identically.
const strangerDid = `did:key:z6MkNeverIssued${runId}`;

// ───────────── 3) the same holder on TOKENIZATION, carrying that DID ─────────
console.log("\n== 3) The same people are onboarded on TOKENIZATION, carrying their identity DIDs ==");
const cfg = {
  key: UC, name: `Split gated ${runId}`, tokenStandard: "ERC-20", symbol: "SPG",
  defaultChainId: "fabric", allowedChainIds: ["fabric"],
  metadataSchema: { type: "object", properties: { issuer: { type: "string" } }, required: ["issuer"] },
  lifecycle: { mint: true, transfer: true, burn: false, freeze: false },
  // THE RULE THIS WHOLE PROGRAM EXISTS FOR: this deployment holds no
  // credentials, so the only way to answer it is to ask the other one.
  compliance: { allowlist: false, transferRestrictions: false, requireVerifiedIdentity: true },
  roles: ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"],
};
const created = await tok("POST", "/use-cases", cfg, tkAdmin);
ok(created.status === 201, `tokenization configures a requireVerifiedIdentity use case '${UC}'`, created.json);

const tkHolder = await onboard(TOKENIZE, tkAdmin, tkAdmin2, {
  email: holderEmail, password: "holder123", role: "Buyer", useCaseKey: UC,
  walletAddress: HOLDER, did: holderDid,
});
ok(!!tkHolder?.id, "holder onboarded on tokenization with a wallet and the identity DID (linked, not minted)", tkHolder?.__err ?? tkHolder?.id);

const strangerEmail = `stranger.${runId}@split.dev`;
const tkStranger = await onboard(TOKENIZE, tkAdmin, tkAdmin2, {
  email: strangerEmail, password: "stranger1", role: "Buyer", useCaseKey: UC,
  walletAddress: STRANGER, did: strangerDid,
});
ok(!!tkStranger?.id, "the control holder likewise — same wiring, no credential behind it", tkStranger?.__err ?? tkStranger?.id);

const treasury = await onboard(TOKENIZE, tkAdmin, tkAdmin2, {
  email: treasuryEmail, password: "treas123", role: "Auditor", useCaseKey: UC,
  walletAddress: TREASURY, did: treasuryDid,
});
ok(!!treasury?.id, "the treasury too — the mint credits it, so it must pass the same gate", treasury?.__err ?? treasury?.id);

// The refusal that keeps a linked DID from being an impersonation door.
const refused = await idn("POST", "/users", { email: `nope.${runId}@split.dev`, password: "nope1234", role: "Holder", did: holderDid }, idAdmin);
ok(refused.status === 400 && refused.json?.error === "DID_NOT_ACCEPTED", "IDENTITY refuses a supplied DID — it mints its own", refused.json);

// ─────────── 4) the gate ADMITS the verified holder, over the wire ───────────
console.log("\n== 4) The gate admits the verified holder — an answer that crossed the network ==");
// Driven by the platform admin: this is a test of the identity GATE, and a
// scoped desk would only add a second (RBAC) reason for a refusal to look the
// same as the one being measured.
const issued = await tok("POST", "/assets", {
  useCaseKey: UC, name: `SPG-${runId}`, chainId: "fabric", initialSupply: "1000",
  treasuryAccount: TREASURY, metadata: { issuer: "Split Co" },
}, tkAdmin);
ok(issued.status === 201, "an offering is minted to the identity-verified treasury", issued.json);
const assetId = issued.json?.asset?.id;

const delivered = await tok("POST", `/assets/${assetId}/actions/transfer`, { from: TREASURY, to: HOLDER, amount: "200" }, tkAdmin);
ok(delivered.status === 200, "200 units delivered to the VERIFIED holder — the identity service said yes", delivered.json);

// The proof it was not answered locally: this deployment serves no credential
// surface at all, so there is nowhere here for that yes to have come from.
const noStore = await tok("GET", `/credentials/${kycCred?.id ?? "x"}/status`, null, null);
ok(noStore.status === 404, "tokenization exposes no credential surface — the verdict was not local", noStore.json);

// ─────────────── 5) …and refuses the one with no credential ─────────────────
console.log("\n== 5) …and refuses the holder identity has nothing on ==");
const denied = await tok("POST", `/assets/${assetId}/actions/transfer`, { from: TREASURY, to: STRANGER, amount: "1" }, tkAdmin);
ok(denied.status >= 400 && denied.json?.error === "IDENTITY_NOT_VERIFIED",
  `the unverified holder is refused → ${denied.json?.error} (${denied.status})`, denied.json);
if (denied.json?.error === "IDENTITY_SERVICE_UNAVAILABLE") {
  note("NOTE: that is the 'could not ask' code, not the 'not verified' one — the peer call failed rather than answering no");
}

// Hand the runner what it needs for the one proof this script cannot make: with
// the identity deployment STOPPED, the same transfer must answer 503
// IDENTITY_SERVICE_UNAVAILABLE — not a quiet "not verified", and not a pass.
if (process.env.SPLIT_HANDOFF && !fails) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.SPLIT_HANDOFF, JSON.stringify({ assetId, treasury: TREASURY, holder: HOLDER }));
}

console.log(`\n${fails
  ? `❌ ${fails} CHECK(S) FAILED`
  : "✅ SPLIT TOPOLOGY E2E PASSED — two deployments, two databases: identity verified the holder, tokenization admitted them on identity's word, and refused the holder identity had nothing on."}`);
process.exit(fails ? 1 : 0);
