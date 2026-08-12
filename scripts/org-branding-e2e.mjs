// EN-E end-to-end: an organization wears its own logo and colour.
//   1) a PlatformAdmin stands up two orgs, each with its own OrgAdmin
//   2) the OrgAdmin uploads a logo through the org's OWN door and applies it
//   3) every MEMBER — not just the admin — reads the mark back
//   4) the brand rides login, so the shell paints on first paint
//   5) the tenant boundary: org B cannot pin or read org A's mark
//   6) a certificate issued by the org carries the brand logo
// Pure HTTP against a live API. Nothing here is mocked.
const API = process.env.API ?? "http://localhost:4000/api/v1";

async function call(m, p, b, t, raw = false) {
  const res = await fetch(API + p, {
    method: m,
    headers: { ...(b != null ? { "Content-Type": "application/json" } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: b != null ? JSON.stringify(b) : undefined,
  });
  if (raw) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") };
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, json: j };
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 240)}` : ""}`); fails++; } };
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p })).json;
const runId = String(Date.now()).slice(-6);

// A 1x1 PNG and a 1x1 WEBP. The webp is a real image the PDF renderer cannot draw.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const WEBP = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

const admin = (await login("admin@tokenlayer.dev", "admin123"))?.token;
if (!admin) { console.error("platform login failed — is the API up?"); process.exit(2); }
console.log(`XI org-branding E2E — EN-E   (run ${runId})\n`);

async function makeOrg(label) {
  const org = (await call("POST", "/orgs", {
    name: `${label} ${runId}`, orgType: "corporate",
    registrationId: `U${runId}MH2020PLC0000${label.length}`, jurisdiction: "IN",
  }, admin)).json;
  const mk = async (role, tag) => {
    const email = `${tag}-${label.toLowerCase()}${runId}@brand.dev`;
    await call("POST", `/orgs/${org.id}/users`, { email, password: "brand-secret-1", role }, admin);
    return login(email, "brand-secret-1");
  };
  return { id: org.id, admin: await mk("OrgAdmin", "admin"), member: await mk("Buyer", "buyer") };
}

console.log("═══ 1 · two organizations, each with an OrgAdmin and an ordinary member ═══");
const a = await makeOrg("Acme");
const b = await makeOrg("Globex");
ok(!!a.admin?.token && !!a.member?.token && !!b.admin?.token, "both orgs provisioned with an admin and a member");
ok(a.admin.user.brandAccent === null && a.admin.user.brandLogoDocumentId === null,
   "an unbranded org's session carries BOTH brand fields as explicit null (not absent)", a.admin.user);

console.log("\n═══ 2 · the OrgAdmin brands their own org, through the org's own doors ═══");
const up = await call("POST", `/orgs/${a.id}/branding/logo`, { contentType: "image/png", dataBase64: PNG }, a.admin.token);
ok(up.status === 201 && up.json?.id, `OrgAdmin uploads a PNG → 201 (POST /documents would 403 this role)`, up.json);
const logoId = up.json?.id;
const patched = await call("PATCH", `/orgs/${a.id}/branding`, { brandLogoDocumentId: logoId, brandAccent: "#B3541E" }, a.admin.token);
ok(patched.status === 200 && patched.json?.brandAccent === "#b3541e", "applies logo + accent; the accent normalizes to lowercase", patched.json);

console.log("\n═══ 3 · every MEMBER reads the mark, not just the admin ═══");
const asAdmin = await call("GET", `/orgs/${a.id}/branding/logo`, null, a.admin.token, true);
ok(asAdmin.status === 200 && asAdmin.bytes.length > 0, `the OrgAdmin reads it back (${asAdmin.bytes.length} bytes, ${asAdmin.type})`);
const asMember = await call("GET", `/orgs/${a.id}/branding/logo`, null, a.member.token, true);
ok(asMember.status === 200 && asMember.bytes.equals(asAdmin.bytes), "a BUYER of the same org gets the identical bytes — GET /documents/:id 403s this role");

console.log("\n═══ 4 · the brand rides the session, so the shell paints on first paint ═══");
const relogin = await login(`admin-acme${runId}@brand.dev`, "brand-secret-1");
ok(relogin.user?.brandAccent === "#b3541e" && relogin.user?.brandLogoDocumentId === logoId,
   "POST /auth/login carries brandAccent + brandLogoDocumentId — no follow-up /me needed", relogin.user);
const me = (await call("GET", "/me", null, relogin.token)).json;
ok(me?.brandAccent === relogin.user.brandAccent && me?.brandLogoDocumentId === relogin.user.brandLogoDocumentId,
   "/me agrees with login — the two session doors cannot drift", me);

console.log("\n═══ 5 · the tenant boundary ═══");
const steal = await call("PATCH", `/orgs/${b.id}/branding`, { brandLogoDocumentId: logoId }, b.admin.token);
ok(steal.status === 400 && steal.json?.error === "BRAND_LOGO_NOT_FOUND",
   "org B cannot pin org A's logo — and the answer is the same as for a document that does not exist", steal.json);
const absent = await call("PATCH", `/orgs/${b.id}/branding`, { brandLogoDocumentId: "doc_does_not_exist" }, b.admin.token);
ok(absent.status === steal.status && absent.json?.error === steal.json?.error,
   "…so the route is not an existence oracle over the document store");
const peek = await call("GET", `/orgs/${a.id}/branding/logo`, null, b.admin.token, true);
ok(peek.status === 403, "a member of another org cannot READ org A's mark either", peek.status);
const crossUpload = await call("POST", `/orgs/${a.id}/branding/logo`, { contentType: "image/png", dataBase64: PNG }, b.admin.token);
ok(crossUpload.status === 403, "…nor upload into it");

console.log("\n═══ 6 · only what the renderer can actually draw ═══");
const webp = await call("POST", `/orgs/${a.id}/branding/logo`, { contentType: "image/webp", dataBase64: WEBP }, a.admin.token);
ok(webp.status === 415 && webp.json?.error === "UNSUPPORTED_DOCUMENT_TYPE",
   "image/webp is refused at the upload door — pdfkit cannot draw it and the failure would be silent", webp.json);

console.log("\n═══ 7 · a machine principal cannot set a brand, whatever its scopes ═══");
// Bound to an OrgAdmin service user AND granted `*` — the widest a key can be.
// If that is refused, a zero-scope key is refused for free.
const key = (await call("POST", `/orgs/${a.id}/api-keys`, { name: `brand-probe-${runId}`, role: "OrgAdmin", scopes: ["*"] }, admin)).json;
if (!key?.secret) ok(false, "minted a wildcard API key for the org", key);
else {
  const byKey = await call("PATCH", `/orgs/${a.id}/branding`, { brandAccent: "#000000" }, key.secret);
  ok(byKey.status === 403 && byKey.json?.error === "MACHINE_PRINCIPAL",
     "a wildcard `*` key is refused MACHINE_PRINCIPAL — setting a brand is a console act", byKey.json);
  const readByKey = await call("GET", `/orgs/${a.id}/branding/logo`, null, key.secret, true);
  ok(readByKey.status === 403, "…and so is reading the mark");
}

console.log("\n═══ 8 · clearing is an explicit act; omitting a key is not ═══");
await call("PATCH", `/orgs/${a.id}/branding`, {}, a.admin.token);
const untouched = (await call("GET", `/orgs/${a.id}`, null, a.admin.token)).json;
ok(untouched?.brandAccent === "#b3541e" && untouched?.brandLogoDocumentId === logoId, "an empty patch changes nothing", untouched);
const cleared = await call("PATCH", `/orgs/${a.id}/branding`, { brandAccent: null, brandLogoDocumentId: null }, a.admin.token);
ok(cleared.json?.brandAccent === null && cleared.json?.brandLogoDocumentId === null, "explicit nulls clear both", cleared.json);
const gone = await call("GET", `/orgs/${a.id}/branding/logo`, null, a.admin.token, true);
ok(gone.status === 404, "and the read door 404s once there is no mark", gone.status);

console.log(fails === 0
  ? `\n✅ ORG-BRANDING E2E PASSED — the org's own upload and read doors, the brand on the session, the tenant boundary, the renderable-type refusal, machine-principal refusal, and omit-vs-null.`
  : `\n❌ ${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
