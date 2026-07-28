// Idempotent: for each Decentralized-Identity credential use case, onboard a
// separate scoped Issuer, Holder and Verifier user (the ID-F desk model). Each
// user is scoped to its use case (useCaseKey) and gets its own login. Run AFTER
// scripts/seed-identity-usecases.mjs. Prints a credentials table at the end.
//
//   node scripts/seed-identity-desk-users.mjs
//   env: API (default http://localhost:4000/api/v1), ADMIN_EMAIL, ADMIN_PASSWORD,
//        ADMIN2_EMAIL (the maker-checker approver, default admin2@tokenlayer.dev).

const API = process.env.API ?? "http://localhost:4000/api/v1";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@tokenlayer.dev";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin123";
const ADMIN2_EMAIL = process.env.ADMIN2_EMAIL ?? "admin2@tokenlayer.dev";
const ADMIN2_PASSWORD = process.env.ADMIN2_PASSWORD ?? "admin123";

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p }, null)).json?.token;

// use case → email prefix
const DESKS = [
  { key: "education-certificate", prefix: "edu" },
  { key: "invoice-financing", prefix: "inv" },
  { key: "domicile-certificate", prefix: "dom" },
  { key: "egovernance-certificate", prefix: "egov" },
];
const ROLES = ["Issuer", "Holder", "Verifier"];

const maker = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
const checker = await login(ADMIN2_EMAIL, ADMIN2_PASSWORD);
if (!maker || !checker) { console.error("admin login failed — is the API up?"); process.exit(2); }

const existing = new Set(((await call("GET", "/users", null, maker)).json ?? []).map((u) => u.email));
const rows = [];
for (const desk of DESKS) {
  for (const role of ROLES) {
    const email = `${desk.prefix}.${role.toLowerCase()}@xi.dev`;
    const password = `${desk.prefix}${role.toLowerCase()}1`;
    if (existing.has(email)) { rows.push([email, password, role, desk.key, "reused"]); continue; }
    const r = await call("POST", "/users", { email, password, role, useCaseKey: desk.key }, maker);
    if (r.status === 202) {
      const ap = await call("POST", `/proposals/${r.json.proposal.id}/approve`, {}, checker);
      rows.push([email, password, role, desk.key, ap.status === 200 ? "created" : `approve ${ap.status}`]);
    } else {
      rows.push([email, password, role, desk.key, `ERR ${r.status} ${r.json?.error ?? ""}`]);
    }
  }
}

console.log("\n  " + "EMAIL".padEnd(26) + "PASSWORD".padEnd(16) + "ROLE".padEnd(10) + "USE CASE".padEnd(24) + "STATUS");
console.log("  " + "-".repeat(84));
for (const [e, p, role, uc, status] of rows) console.log("  " + e.padEnd(26) + p.padEnd(16) + role.padEnd(10) + uc.padEnd(24) + status);
console.log(`\n  ${rows.length} scoped desk users across ${DESKS.length} use cases (Issuer / Holder / Verifier each). Each logs in to its own identity desk.`);
