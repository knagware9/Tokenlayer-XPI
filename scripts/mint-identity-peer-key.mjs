// Mint the ONE credential that binds a tokenization deployment to an identity one:
// an org-scoped API key holding `identity:assert`, and nothing else.
//
// Prints the secret to STDOUT and everything else to STDERR, so a caller can do
//   IDENTITY_SERVICE_KEY=$(node scripts/mint-identity-peer-key.mjs)
// without parsing anything.
//
// The secret exists exactly once — in this response — so it is never re-readable
// and there is no way to recover it later. Re-run to mint a fresh one.
//
// Usage: IDENTITY_URL=http://localhost:4100/api/v1 node scripts/mint-identity-peer-key.mjs

const API = process.env.IDENTITY_URL ?? "http://localhost:4100/api/v1";
const EMAIL = process.env.IDENTITY_ADMIN_EMAIL ?? "admin@tokenlayer.dev";
const PASS = process.env.IDENTITY_ADMIN_PASSWORD ?? "admin123";
const ORG_NAME = process.env.PEER_ORG_NAME ?? "Tokenization Peer";

const log = (m) => process.stderr.write(`[peer-key] ${m}\n`);
const die = (m, d) => { process.stderr.write(`[peer-key] ERROR: ${m}${d ? ` — ${JSON.stringify(d).slice(0, 300)}` : ""}\n`); process.exit(1); };

async function call(method, path, body, token) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

const login = await call("POST", "/auth/login", { email: EMAIL, password: PASS }, null);
if (login.status !== 200) die(`could not sign in to ${API} as ${EMAIL}`, login.json);
const token = login.json.token;

// Reuse the peer org if it is already there — this script is run on every
// bring-up and a second org with the same name is a 409, not a fresh start.
const orgs = await call("GET", "/orgs", null, token);
let org = (orgs.json ?? []).find((o) => o.name === ORG_NAME);
if (!org) {
  const created = await call("POST", "/orgs", { name: ORG_NAME, orgType: "corporate" }, token);
  if (created.status !== 201) die("could not create the peer organization", created.json);
  org = created.json;
  log(`created peer org '${ORG_NAME}' (${org.id})`);
} else {
  log(`reusing peer org '${ORG_NAME}' (${org.id})`);
}

// ONE scope. `identity:assert` answers yes/no about any subject and nothing
// else — no claims, no issuer, no credential id — and every call is audited.
const key = await call("POST", `/orgs/${org.id}/api-keys`, {
  name: `tokenization-peer-${new Date().toISOString().slice(0, 10)}`,
  role: "Auditor",
  scopes: ["identity:assert"],
}, token);
if (key.status !== 201 || !key.json?.secret) die("could not mint the peer API key", key.json);

log(`minted key ${key.json.prefix ?? ""}… with scopes [identity:assert]`);
process.stdout.write(key.json.secret);
