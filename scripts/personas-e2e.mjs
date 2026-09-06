// SIX AUDIENCE APPS, AND THE BOUNDARY BETWEEN THEM — proven against the live stack.
//
//   bash scripts/stack-up.sh identity tokenization && node scripts/personas-e2e.mjs
//
// Both stacks must be up: sections 4 and 6 assert that neither product is
// reachable through the other's edges, which needs both to exist. Bring up only
// one and section 0 stops with the command to run.
//
// ── WHAT THIS PROVES THAT A UNIT TEST CANNOT ─────────────────────────────────
//
// The equivalence test in apps/api already proves the generated config DECIDES
// the same way the catalogue does. It cannot prove that nginx parses it, that
// the container carries the right one, or that a refusal comes from the EDGE
// rather than from the API behind it. Those are deployment facts and they need
// the deployment.
//
// The distinction that matters most here is the last one. Two different 404s
// exist in this system and they mean opposite things about the architecture:
//
//     PERSONA_ROUTE_NOT_ALLOWED   the edge refused; the request never left it
//     DOMAIN_NOT_ENABLED          the API answered; the edge proxied it through
//
// A test that only checked the status code would pass on either and would
// therefore be satisfied by an edge that proxies everything — the exact
// non-boundary this whole design exists to avoid. So every refusal below is
// asserted on the ERROR CODE.
//
// PROBES ARE HAND-WRITTEN, deliberately. Deriving them from the persona
// catalogue would check the catalogue against itself and pass no matter what it
// said; each one below names a thing a real audience must or must not be able
// to do.
const EDGES = {
  "identity-issuer": Number(process.env.IDENTITY_ISSUER_API_PORT ?? 4110),
  "identity-verifier": Number(process.env.IDENTITY_VERIFIER_API_PORT ?? 4111),
  "identity-holder": Number(process.env.IDENTITY_HOLDER_API_PORT ?? 4112),
  "tokenization-issuer": Number(process.env.TOKENIZATION_ISSUER_API_PORT ?? 4120),
  "tokenization-marketplace": Number(process.env.TOKENIZATION_MARKETPLACE_API_PORT ?? 4121),
  "tokenization-admin": Number(process.env.TOKENIZATION_ADMIN_API_PORT ?? 4122),
};
const base = (persona) => `http://localhost:${EDGES[persona]}`;

let fails = 0;
const ok = (cond, msg, detail) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 220)}` : ""}`);
  if (!cond) fails++;
};

async function call(persona, method, path, body, token) {
  const res = await fetch(`${base(persona)}/api/v1${path}`, {
    method,
    headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

const login = async (persona, email, password) =>
  (await call(persona, "POST", "/auth/login", { email, password })).json?.token;

/** True when THE EDGE refused — not the API behind it. */
const refusedAtEdge = (r) => r.status === 404 && r.json?.error === "PERSONA_ROUTE_NOT_ALLOWED";

// ── 0. Every edge is up and knows which persona it is ────────────────────────
console.log("== 0) Six edges, six identities ==");
for (const [persona, port] of Object.entries(EDGES)) {
  let health = null;
  try { health = await (await fetch(`http://localhost:${port}/healthz`)).json(); } catch (e) {
    ok(false, `${persona} edge on :${port} is reachable`, String(e));
    continue;
  }
  ok(health?.persona === persona, `${persona} edge on :${port} reports itself as '${health?.persona}'`, health);
}
if (fails) {
  console.log("\n⊘ not every edge is up. Run: bash scripts/stack-up.sh identity tokenization");
  process.exit(2);
}

// ── 1. Each app can do its own job ───────────────────────────────────────────
// The positive half. An allowlist that refused everything would sail through
// every negative assertion below and ship six containers nobody can log in to.
console.log("\n== 1) Each app can do its own job ==");
const admin = {};
for (const persona of Object.keys(EDGES)) {
  admin[persona] = await login(persona, "admin@tokenlayer.dev", "admin123");
  ok(!!admin[persona], `${persona}: a platform admin can sign in through this edge`);
}
ok((await call("identity-issuer", "GET", "/credential-use-cases", null, admin["identity-issuer"])).status === 200,
  "identity-issuer: reads the credential programmes it issues against");
ok((await call("identity-verifier", "POST", "/verification-requests", {}, admin["identity-verifier"])).status !== 404,
  "identity-verifier: reaches the presentation-request route (the edge proxies it)");
ok((await call("identity-holder", "GET", "/me/credentials", null, admin["identity-holder"])).status === 200,
  "identity-holder: reads its own wallet");
ok((await call("tokenization-issuer", "GET", "/use-cases", null, admin["tokenization-issuer"])).status === 200,
  "tokenization-issuer: reads the use cases it mints against");
ok((await call("tokenization-marketplace", "GET", "/me/portfolio", null, admin["tokenization-marketplace"])).status === 200,
  "tokenization-marketplace: reads its own portfolio");
ok((await call("tokenization-admin", "GET", "/analytics", null, admin["tokenization-admin"])).status === 200,
  "tokenization-admin: reads the platform dashboard");

// ── 2. …and cannot do anybody else's ─────────────────────────────────────────
console.log("\n== 2) …and the edge refuses what that audience has no business calling ==");
const denials = [
  ["identity-holder", "POST", "/orgs/o1/users", "a wallet cannot onboard people into an organization"],
  ["identity-holder", "GET", "/users", "a wallet cannot read the roster"],
  ["identity-holder", "GET", "/events", "a wallet cannot read the activity feed"],
  ["identity-holder", "POST", "/credentials/c1/revoke", "a wallet cannot revoke a credential"],
  ["identity-verifier", "POST", "/credentials/c1/revoke", "a VERIFIER cannot revoke — it checks, it does not issue"],
  ["identity-verifier", "POST", "/credential-use-cases", "a verifier cannot define a credential programme"],
  ["tokenization-marketplace", "POST", "/assets", "an investor cannot mint an asset"],
  ["tokenization-marketplace", "GET", "/users", "an investor cannot read the roster"],
];
for (const [persona, method, path, why] of denials) {
  const r = await call(persona, method, path, method === "POST" ? {} : null, admin[persona]);
  ok(refusedAtEdge(r), `${persona}: ${why}`, r.json ?? r.status);
}

// ── 3. The refusals are not vacuous ──────────────────────────────────────────
// Every path refused above is ALLOWED on the persona whose job it is. Without
// this, an edge that 404'd its entire allowlist would pass section 2 perfectly.
console.log("\n== 3) POSITIVE CONTROL — the same routes are open where they belong ==");
const controls = [
  ["identity-issuer", "POST", "/credentials/c1/revoke", "an ISSUER may revoke (refused above for the verifier and the wallet)"],
  ["identity-issuer", "POST", "/credential-use-cases", "an issuer may define a programme"],
  ["identity-issuer", "GET", "/users", "a staff app may read the roster"],
  ["tokenization-issuer", "POST", "/assets", "an ISSUER may mint (refused above for the marketplace)"],
  ["tokenization-admin", "POST", "/cash/credit", "the platform admin may credit a settlement account"],
  ["tokenization-admin", "GET", "/use-cases", "the platform admin may read every use case"],
  // Deliberately open at this edge too, not refused: /cash/credit POST-only
  // self-funds one's own account (enforced by the route handler, not the
  // edge — see personas.ts's tokenization-marketplace grant), and /use-cases
  // GET backs the asset detail page's compliance/lifecycle rules. Neither
  // belongs in section 2's denial list.
  ["tokenization-marketplace", "POST", "/cash/credit", "an investor may self-fund their own settlement account"],
  ["tokenization-marketplace", "GET", "/use-cases", "an investor may read a use case's compliance/lifecycle rules (asset detail page)"],
];
for (const [persona, method, path, why] of controls) {
  const r = await call(persona, method, path, method === "POST" ? {} : null, admin[persona]);
  // "Not an edge refusal" is NOT ENOUGH, and the first version of this test
  // stopped there — so a 502 from an API that had not finished booting counted
  // as proof the route was open. A positive control has to show the APPLICATION
  // answered: 400 for an empty body and 404 for a made-up id are the app
  // deciding, which is the point; 5xx is nothing having decided at all.
  const reached = !refusedAtEdge(r) && r.status < 500;
  ok(reached, `${persona}: ${why} (API answered ${r.status})`, r.json);
}

// ── 4. The products still cannot see each other ──────────────────────────────
console.log("\n== 4) Neither product is reachable through the other's edges ==");
for (const persona of ["identity-issuer", "identity-verifier", "identity-holder"]) {
  const r = await call(persona, "GET", "/assets", null, admin[persona]);
  ok(refusedAtEdge(r), `${persona}: tokenization's asset ledger is refused at the edge`, r.json ?? r.status);
}
for (const persona of ["tokenization-issuer", "tokenization-marketplace", "tokenization-admin"]) {
  const r = await call(persona, "GET", "/credential-use-cases", null, admin[persona]);
  ok(refusedAtEdge(r), `${persona}: identity's credential programmes are refused at the edge`, r.json ?? r.status);
}

// ── 5. The machine-to-machine oracle is on nobody's edge ─────────────────────
console.log("\n== 5) The identity oracle is not published to any browser ==");
for (const persona of Object.keys(EDGES)) {
  const r = await call(persona, "POST", "/identity/assertions", { subjectDid: "did:key:z6Mk", credentialType: "KycCredential" }, admin[persona]);
  ok(refusedAtEdge(r), `${persona}: POST /identity/assertions is refused`, r.json ?? r.status);
}
// …while the seam it serves still works: tokenization asks identity over the
// internal network with its peer key, which is why the gate below can answer.
console.log("  (the tokenization API still reaches it container-to-container — see section 6)");

// ── 6. A real cross-persona flow, entirely through the edges ─────────────────
console.log("\n== 6) A credential crosses three apps: issued, held, and honoured ==");
const runId = String(Date.now()).slice(-6);
// Provisioned HERE rather than assumed: a fresh container has no seeded
// programme, and an e2e that silently skipped its only cross-app flow when the
// database happened to be empty would report a green run for nothing.
let ucs = (await call("identity-issuer", "GET", "/credential-use-cases", null, admin["identity-issuer"])).json ?? [];
if (!Array.isArray(ucs) || ucs.length === 0) {
  console.log("  · no programme on this deployment — seeding one through the issuer edge");
  const seed = await new Promise((resolve) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(process.execPath, ["scripts/seed-identity-usecases.mjs"],
        { env: { ...process.env, API: `${base("identity-issuer")}/api/v1` }, stdio: "ignore" });
      child.on("exit", (code) => resolve(code === 0));
    });
  });
  ok(seed, "seeded the identity deployment's credential programmes through the issuer edge");
  ucs = (await call("identity-issuer", "GET", "/credential-use-cases", null, admin["identity-issuer"])).json ?? [];
}
const programme = Array.isArray(ucs) ? ucs[0] : null;
if (!programme) {
  ok(false, "the identity deployment has a credential programme to issue against", ucs);
} else {
  ok(true, `issuing against the '${programme.key}' programme`);
  const email = `holder.${runId}@personas.dev`;
  const onboard = await call("identity-issuer", "POST", "/users",
    { email, password: "holder123", role: "Holder", useCaseKey: programme.key, kyc: { legalName: `Persona Holder ${runId}`, country: "IN" } },
    admin["identity-issuer"]);
  ok(onboard.status === 201 || onboard.status === 202, `identity-issuer onboarded a holder (${onboard.status})`, onboard.json);
  if (onboard.status === 202) {
    // A DIFFERENT admin approves. The proposer cannot approve their own — that
    // is the platform's segregation of duties, and the first version of this
    // script accepted the 403 as "decided", which left no holder to sign in
    // with and reported the real failure two lines later as a login problem.
    const checker = await login("identity-issuer", "admin2@tokenlayer.dev", "admin123");
    ok(!!checker, "a second platform admin is available to approve (segregation of duties)");
    const appr = await call("identity-issuer", "POST", `/proposals/${onboard.json.proposal.id}/approve`, {}, checker);
    ok(appr.status === 200 && appr.json?.proposal?.status === "executed",
      "the onboarding was approved by the OTHER admin and executed", appr.json?.proposal ?? appr.json);
  }
  // The holder signs in to THEIR OWN app, on a different port, against a
  // different container, and finds what the issuer created.
  const holderTok = await login("identity-holder", email, "holder123");
  ok(!!holderTok, "the holder signs in to the WALLET app — a different container entirely");
  if (holderTok) {
    const wallet = await call("identity-holder", "GET", "/me/credentials", null, holderTok);
    ok(wallet.status === 200 && Array.isArray(wallet.json), "the wallet reads the credential the issuer minted", wallet.json);
    // And still cannot do the issuer's job with its own valid session.
    const cannot = await call("identity-holder", "POST", "/credential-use-cases", { key: "x" }, holderTok);
    ok(refusedAtEdge(cannot), "…and with a VALID session still cannot define a programme — the edge, not the role, refuses", cannot.json);
  }
}

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ PERSONA TOPOLOGY VERIFIED — six edges, each serving one audience; every refusal came from the EDGE (PERSONA_ROUTE_NOT_ALLOWED), every allowed route reached the API, and neither product is reachable through the other's door"}`);
process.exit(fails ? 1 : 0);
