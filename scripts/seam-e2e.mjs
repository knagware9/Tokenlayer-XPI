// THE SEAM BETWEEN THE TWO PRODUCTS — proven across two running stacks.
//
//   bash scripts/stack-up.sh identity tokenization && node scripts/seam-e2e.mjs
//
// personas-e2e.mjs proves the persona BOUNDARY: which audience may call what.
// This proves the one thing that crosses it — tokenization asking identity
// whether a subject holds a credential, over the network, with a peer key.
//
// ── THE THREE ANSWERS, AND WHY ALL THREE MATTER ──────────────────────────────
//
//   200                            the holder identity verified is admitted
//   IDENTITY_NOT_VERIFIED          identity was asked and said no
//   IDENTITY_SERVICE_UNAVAILABLE   identity could not be asked at all
//
// A gate that collapses the last two is the dangerous one, and it fails in both
// directions: report "not verified" for a network failure and an operator hunts
// a policy problem that does not exist; report "verified" and an outage becomes
// an open door. So section 5 stops the identity stack and requires 503 — not a
// quiet no, and certainly not a pass.
//
// This file inherits that coverage from the retired split-topology e2e. The
// topology changed; the question it asked did not.
import { execFileSync } from "node:child_process";

const ID = `http://localhost:${process.env.IDENTITY_ISSUER_API_PORT ?? 4110}/api/v1`;
// The holder reads their own wallet through the WALLET edge — the issuer edge
// does not carry /me/credentials, and should not. Using the right door is part
// of what this script demonstrates.
const WALLET = `http://localhost:${process.env.IDENTITY_HOLDER_API_PORT ?? 4112}/api/v1`;
const TK = `http://localhost:${process.env.TOKENIZATION_ADMIN_API_PORT ?? 4122}/api/v1`;
const runId = String(Date.now()).slice(-6);
const UC = `seam-${runId}`;
// RUN-SCOPED WALLETS. A settlement account is upserted by address and keeps the
// FIRST user linked to it, so fixed addresses make every run after the first
// resolve to an earlier run's user — and the gate then reports the wrong
// person's identity. Costly to diagnose, because the failure is a correct
// refusal about a subject nobody in this run created.
const TREASURY = "0x" + `5ea1${runId}`.padEnd(40, "0");
const HOLDER = "0x" + `401de2${runId}`.padEnd(40, "0");
const STRANGER = "0x" + `5723a9${runId}`.padEnd(40, "0");

let fails = 0;
const ok = (c, msg, d) => {
  console.log(`  ${c ? "✓" : "✗"} ${msg}${!c && d !== undefined ? ` — ${JSON.stringify(d).slice(0, 240)}` : ""}`);
  if (!c) fails++;
};
const note = (m) => console.log(`    ${m}`);

async function call(base, method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}
const idn = (m, p, b, t) => call(ID, m, p, b, t);
const tok = (m, p, b, t) => call(TK, m, p, b, t);
const login = (base, email, pw) => call(base, "POST", "/auth/login", { email, password: pw }).then((r) => r.json?.token);

/** Onboard through maker-checker; a DIFFERENT admin approves (segregation of duties). */
async function onboard(base, maker, checker, payload) {
  const proposed = await call(base, "POST", "/users", payload, maker);
  if (proposed.status === 201) return proposed.json;
  if (proposed.status !== 202) return { __err: proposed.json ?? proposed.status };
  const decided = await call(base, "POST", `/proposals/${proposed.json.proposal.id}/approve`, {}, checker);
  if (decided.json?.proposal?.status !== "executed") return { __err: decided.json?.proposal ?? decided.json };
  const users = (await call(base, "GET", "/users", null, maker)).json ?? [];
  return users.find((u) => u.email === payload.email) ?? { __err: "not found after approval" };
}

const compose = (...args) =>
  execFileSync("docker", ["compose", "-p", "xi-identity", "-f", "docker-compose.identity.yml", ...args], { stdio: "pipe" });

// ── 0. Both stacks are up ────────────────────────────────────────────────────
console.log("== 0) Two stacks, two databases ==");
const idAdmin = await login(ID, "admin@tokenlayer.dev", "admin123");
const idChecker = await login(ID, "admin2@tokenlayer.dev", "admin123");
const tkAdmin = await login(TK, "admin@tokenlayer.dev", "admin123");
const tkChecker = await login(TK, "admin2@tokenlayer.dev", "admin123");
ok(!!idAdmin && !!tkAdmin, "signed in to both deployments");
if (!idAdmin || !tkAdmin) {
  console.log("\n⊘ both stacks must be up. Run: bash scripts/stack-up.sh identity tokenization");
  process.exit(2);
}
const idCfg = (await idn("GET", "/config", null, idAdmin)).json;
const tkCfg = (await tok("GET", "/config", null, tkAdmin)).json;
ok(JSON.stringify(idCfg?.domains) === '["identity"]', `identity serves ${JSON.stringify(idCfg?.domains)}`, idCfg);
ok(JSON.stringify(tkCfg?.domains) === '["tokenization"]', `tokenization serves ${JSON.stringify(tkCfg?.domains)}`, tkCfg);
ok(tkCfg?.subjectIdentifiers === "did", "tokenization carries subject DIDs — the gate has something to ask about", tkCfg);

// ── 1. Identity verifies a person ────────────────────────────────────────────
console.log("\n== 1) IDENTITY onboards and verifies a holder ==");
// A HOLDER IS SCOPED TO A PROGRAMME. Onboarding one with no credential use case
// leaves the role's domain unresolvable, and the refusal arrives as a flat
// FORBIDDEN that reads like a permissions problem rather than a missing scope.
let idProgrammes = (await idn("GET", "/credential-use-cases", null, idAdmin)).json ?? [];
if (!Array.isArray(idProgrammes) || idProgrammes.length === 0) {
  const { spawnSync } = await import("node:child_process");
  spawnSync(process.execPath, ["scripts/seed-identity-usecases.mjs"], { env: { ...process.env, API: ID }, stdio: "ignore" });
  idProgrammes = (await idn("GET", "/credential-use-cases", null, idAdmin)).json ?? [];
}
const programme = Array.isArray(idProgrammes) ? idProgrammes[0] : null;
ok(!!programme, `issuing under the '${programme?.key}' programme`, idProgrammes);
// ROLE BY DOMAIN: "Holder" here, "Buyer" on tokenization. A cross-domain role
// is refused with FORBIDDEN, which reads like a permissions problem rather than
// a vocabulary one.
const idHolder = await onboard(ID, idAdmin, idChecker, {
  email: `seam.holder.${runId}@x.dev`, password: "holder123", role: "Holder",
  useCaseKey: programme?.key,
  kyc: { legalName: `Seam Holder ${runId}`, country: "IN" },
});
ok(!!idHolder?.id && idHolder?.kycStatus === "approved", "holder onboarded on IDENTITY with an approved KYC credential", idHolder?.__err ?? idHolder?.kycStatus);
const holderDid = idHolder?.kyc ? (await idn("GET", "/users", null, idAdmin)).json?.find((u) => u.id === idHolder.id)?.did : null;
const holderToken = await login(WALLET, `seam.holder.${runId}@x.dev`, "holder123");
const heldCreds = (await call(WALLET, "GET", "/me/credentials", null, holderToken)).json ?? [];
const kycCred = Array.isArray(heldCreds) ? heldCreds.find((c) => (c.type ?? []).includes?.("KycCredential") ?? c.type === "KycCredential") ?? heldCreds[0] : null;
ok(!!kycCred && kycCred.revoked === false, "the holder holds a valid KycCredential — in IDENTITY's database", heldCreds);
const did = holderDid ?? kycCred?.holderDid;
ok(!!did, `their DID is ${String(did).slice(0, 26)}…`);

// ── 2. Tokenization gates a use case on that verification ────────────────────
console.log("\n== 2) TOKENIZATION configures a use case that requires a verified identity ==");
const created = await tok("POST", "/use-cases", {
  key: UC, name: `Seam ${runId}`, symbol: "SEAM", tokenStandard: "ERC-20",
  allowedChainIds: ["fabric"], defaultChainId: "fabric",
  metadataSchema: { type: "object", properties: { issuer: { type: "string" } }, required: ["issuer"] },
  lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
  compliance: { allowlist: false, transferRestrictions: false, requireVerifiedIdentity: true },
  roles: ["UseCaseAdmin", "Issuer"],
}, tkAdmin);
ok(created.status === 201, `configured '${UC}' with requireVerifiedIdentity`, created.json);

// The same people, onboarded here with their identity DID LINKED (not minted):
// onboarding on both sides would mint two DIDs and the gate would ask about one
// identity has never seen.
const tkHolder = await onboard(TK, tkAdmin, tkChecker, {
  email: `seam.holder.${runId}@x.dev`, password: "holder123", role: "Buyer",
  useCaseKey: UC, walletAddress: HOLDER, did,
});
ok(!!tkHolder?.id, "the holder is onboarded on TOKENIZATION carrying their identity DID", tkHolder?.__err ?? tkHolder?.id);
const tkTreasury = await onboard(TK, tkAdmin, tkChecker, {
  email: `seam.treasury.${runId}@x.dev`, password: "treas123", role: "Buyer",
  useCaseKey: UC, walletAddress: TREASURY, did,
});
ok(!!tkTreasury?.id, "so is the treasury — the mint credits it, so it faces the same gate", tkTreasury?.__err);
const tkStranger = await onboard(TK, tkAdmin, tkChecker, {
  email: `seam.stranger.${runId}@x.dev`, password: "strang123", role: "Buyer",
  useCaseKey: UC, walletAddress: STRANGER,
});
ok(!!tkStranger?.id, "and a stranger, with no identity behind them at all", tkStranger?.__err);

// ── 3. The gate ADMITS, on identity's word ───────────────────────────────────
console.log("\n== 3) The gate admits the verified holder — an answer that crossed the network ==");
const issued = await tok("POST", "/assets", {
  useCaseKey: UC, name: `SEAM-${runId}`, chainId: "fabric", initialSupply: "1000",
  treasuryAccount: TREASURY, metadata: { issuer: "Seam Co" },
}, tkAdmin);
// Every asset now starts pending_approval — see docs/superpowers/plans/
// 2026-09-05-asset-due-diligence-plan.md. Complete that flow here (prospectus,
// submit, and approve as a DIFFERENT admin than the one who issued it — the
// creator of an asset may never decide its own review) before this script's
// actual subject, the identity gate, gets to run against an active asset.
ok(issued.status === 202, "an offering is issued, pending due-diligence review", issued.json);
const assetId = issued.json?.asset?.id;
if (assetId) {
  const pdf = Buffer.from("%PDF-1.4 seam-e2e test prospectus").toString("base64");
  await tok("POST", `/assets/${assetId}/diligence/documents`, { slot: "prospectus", contentType: "application/pdf", dataBase64: pdf }, tkAdmin);
  await tok("POST", `/assets/${assetId}/submit-for-review`, {}, tkAdmin);
  const decided = await tok("POST", `/assets/${assetId}/review-decision`, { decision: "approved", riskTier: "low" }, tkChecker);
  ok(decided.status === 200, "the offering clears due-diligence review and activates", decided.json);
}
const delivered = assetId
  ? await tok("POST", `/assets/${assetId}/actions/transfer`, { from: TREASURY, to: HOLDER, amount: "200" }, tkAdmin)
  : { status: 0, json: "no asset" };
ok(delivered.status === 200, "200 units delivered to the VERIFIED holder — identity said yes", delivered.json);

// The proof the yes was not answered locally: this deployment has no credential
// surface at all, so there is nowhere here it could have come from.
const noStore = await tok("GET", `/credentials/${kycCred?.id ?? "x"}/status`, null, tkAdmin);
ok(noStore.status === 404, "tokenization exposes no credential surface — the verdict was not local", noStore.json);

// ── 4. …and REFUSES the one identity has nothing on ──────────────────────────
console.log("\n== 4) …and refuses the holder identity has nothing on ==");
const denied = assetId
  ? await tok("POST", `/assets/${assetId}/actions/transfer`, { from: TREASURY, to: STRANGER, amount: "1" }, tkAdmin)
  : { status: 0, json: "no asset" };
ok(denied.status >= 400 && denied.json?.error === "IDENTITY_NOT_VERIFIED",
  `the unverified holder is refused → ${denied.json?.error} (${denied.status})`, denied.json);
if (denied.json?.error === "IDENTITY_SERVICE_UNAVAILABLE") {
  note("NOTE: that is the 'could not ask' code, not the 'asked and told no' one — the peer call failed rather than answering.");
}

// ── 5. FAIL CLOSED, and loudly ───────────────────────────────────────────────
// The check the whole seam exists for. With identity stopped, the SAME transfer
// that succeeded in section 3 must answer 503 — not 200 (an outage as an open
// door) and not IDENTITY_NOT_VERIFIED (a network failure reported as policy).
console.log("\n== 5) With IDENTITY STOPPED, the gate fails closed and says which failure it was ==");
let stopped = false;
try {
  compose("stop", "identity-api");
  stopped = true;
  await new Promise((r) => setTimeout(r, 3000));
  const outage = assetId
    ? await tok("POST", `/assets/${assetId}/actions/transfer`, { from: TREASURY, to: HOLDER, amount: "1" }, tkAdmin)
    : { status: 0, json: "no asset" };
  ok(outage.status === 503 && outage.json?.error === "IDENTITY_SERVICE_UNAVAILABLE",
    `the gated transfer fails CLOSED: ${outage.status} ${outage.json?.error}`, outage.json);
  if (outage.status === 200) note("A 200 with identity down means the gate passed everyone — an outage became an open door.");
  if (outage.json?.error === "IDENTITY_NOT_VERIFIED") note("IDENTITY_NOT_VERIFIED here reports a POLICY answer for a NETWORK failure — the collapse this test exists to catch.");

  // Tokenization's own product keeps working: only the gated action is blocked.
  const stillAlive = await tok("GET", "/use-cases", null, tkAdmin);
  ok(stillAlive.status === 200, "tokenization still serves its own product with identity down", stillAlive.status);
} finally {
  if (stopped) {
    console.log("    (restarting identity…)");
    try { compose("start", "identity-api"); } catch { console.log("    ⚠ could not restart identity-api — run: bash scripts/stack-up.sh identity"); }
  }
}

console.log(`\n${fails
  ? `❌ ${fails} CHECK(S) FAILED`
  : "✅ SEAM VERIFIED — two stacks, two databases: identity verified the holder, tokenization admitted them on identity's word, refused the one identity had nothing on, and with identity down failed CLOSED with 503 rather than guessing."}`);
process.exit(fails ? 1 : 0);
