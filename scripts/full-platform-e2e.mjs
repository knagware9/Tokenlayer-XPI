// Full-platform end-to-end: the whole identity↔tokenization arc.
//   PART 1 (ID-G) enterprise provisioning — from a template catalog, stand up an
//     issuer org + credential use case + scoped Issuer/Holder/Verifier desk logins.
//   PART 2 (ID-F) scoped desk operation — the provisioned Issuer issues a credential
//     to the provisioned Holder; the Holder holds it.
//   PART 3 (ID-H) pluggable DID/VC gate — a tokenization use case with
//     requireVerifiedIdentity refuses a buy until the buyer holds a valid KYC VC,
//     and refuses again once it is revoked.
// Pure HTTP against a live API on :4000.

import { readFileSync } from "node:fs";
const API = process.env.API ?? "http://localhost:4000/api/v1";

async function call(m, p, b, t) {
  const res = await fetch(API + p, { method: m, headers: { ...(b != null ? { "Content-Type": "application/json" } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b != null ? JSON.stringify(b) : undefined });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, json: j };
}
let fails = 0;
const ok = (c, msg, d) => { if (c) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}${d !== undefined ? ` — ${JSON.stringify(d).slice(0, 260)}` : ""}`); fails++; } };
const note = (m) => console.log(`  · ${m}`);
const login = async (e, p) => (await call("POST", "/auth/login", { email: e, password: p })).json?.token;
const addr = (s) => "0x" + s.toLowerCase().replace(/[^0-9a-f]/g, "").padEnd(40, "0").slice(0, 40);
const runId = String(Date.now()).slice(-6);

async function onboard(mk, ck, body) {
  const r = await call("POST", "/users", body, mk);
  if (r.status === 201) return r.json;
  if (r.status !== 202) return { __err: r };
  await call("POST", `/proposals/${r.json.proposal.id}/approve`, {}, ck);
  return (await call("GET", "/users", null, ck)).json?.find((u) => u.email === body.email) ?? { __err: r };
}

const admin = await login("admin@tokenlayer.dev", "admin123");
const admin2 = await login("admin2@tokenlayer.dev", "admin123");
if (!admin || !admin2) { console.error("platform login failed — is the API up?"); process.exit(2); }
console.log(`XI full-platform E2E — identity ↔ tokenization   (run ${runId})\n`);

// ─────────────── PART 1 — ID-G enterprise provisioning from a template ───────────────
console.log("═══ PART 1 · ID-G — provision an identity program from a template ═══");
const tpls = (await call("GET", "/credential-use-case-templates", null, admin)).json?.templates ?? [];
ok(tpls.length >= 5 && tpls.some((t) => t.key === "education-certificate"), `template catalog: ${tpls.map((t) => t.key).join(", ")}`);
const orgName = `Acme University ${runId}`;
const prov = await call("POST", "/credential-use-cases/provision", {
  templateKey: "education-certificate",
  params: { issuerOrgName: orgName, jurisdiction: "IN" },
  provisioning: { issuerOrgType: "government", createDeskUsers: true, deskEmailDomain: `acme${runId}.edu` },
}, admin);
ok(prov.status === 201, "POST /provision → 201 (one step)", prov.json);
const ucKey = prov.json?.useCase?.key;
ok(prov.json?.org?.did && prov.json?.useCase?.issuer?.kind === "org", `issuer org ${orgName} (DID ${prov.json?.org?.did?.slice(0, 22)}…) bound to use case ${ucKey}`);
const desks = prov.json?.deskUsers ?? [];
ok(desks.length === 3, `desk logins created: ${desks.map((d) => d.role).join(", ")}`, desks.map((d) => d.email));
const issuerLogin = desks.find((d) => d.role === "Issuer");
const holderLogin = desks.find((d) => d.role === "Holder");

// ─────────────── PART 2 — ID-F scoped desk issues a credential ───────────────
console.log("\n═══ PART 2 · ID-F — the provisioned Issuer desk issues a credential ═══");
const issuerTok = await login(issuerLogin.email, issuerLogin.password);
const me = (await call("GET", "/me", null, issuerTok)).json;
ok(me?.role === "Issuer" && me?.useCaseKey === ucKey && me?.useCaseDomain === "identity", `${issuerLogin.email} logs into its scoped identity desk (useCaseKey=${me?.useCaseKey})`);
const holderTok = await login(holderLogin.email, holderLogin.password);
const holders = (await call("GET", `/credential-use-cases/${ucKey}/eligible-holders`, null, issuerTok)).json ?? [];
const subject = holders.find((h) => (h.label ?? "").includes(holderLogin.email)) ?? holders[0];
const credType = prov.json?.useCase?.credentialTypes?.[0]?.name ?? "DegreeCredential";
const iss = await call("POST", `/credential-use-cases/${ucKey}/credentials`, { credentialType: credType, [subject?.kind === "org" ? "subjectOrgId" : "subjectUserId"]: subject?.id, claims: { studentName: "Asha Rao", institution: orgName, degree: "B.Tech", conferredYear: 2026 } }, issuerTok);
ok(iss.status === 202, `Issuer issues a ${credType} to the Holder (gated → proposal)`, iss.json);
if (iss.status === 202) ok((await call("POST", `/proposals/${iss.json.proposal.id}/approve`, {}, admin)).status === 200, "approved → credential issued");
const held = (await call("GET", "/me/credentials", null, holderTok)).json ?? [];
ok(held.some((c) => c.type.includes(credType)), `the Holder now holds a ${credType}`, held.map((c) => c.type));

// ─────────────── PART 3 — ID-H pluggable DID/VC gate on tokenization ───────────────
console.log("\n═══ PART 3 · ID-H — a tokenization use case gated on a KYC credential ═══");
const gcfg = JSON.parse(readFileSync(new URL("../config/use-cases/generic-asset.json", import.meta.url), "utf8"));
gcfg.key = `gated-${runId}`; gcfg.name = `Gated Asset ${runId}`; gcfg.compliance = { ...(gcfg.compliance ?? {}), allowlist: true, requireVerifiedIdentity: true };
const guc = await call("POST", "/use-cases", gcfg, admin);
ok(guc.status === 201 && guc.json?.compliance?.requireVerifiedIdentity === true, `tokenization use case '${gcfg.key}' created with requireVerifiedIdentity ON`, guc.json?.compliance);
const chain = Object.keys(guc.json?.contracts ?? { fabric: 1 })[0];
// desk admin + KYC'd treasury
await onboard(admin, admin2, { email: `g.adm.${runId}@x.dev`, password: "gadm1234", role: "UseCaseAdmin", useCaseKey: gcfg.key });
const gdesk = await login(`g.adm.${runId}@x.dev`, "gadm1234");
const TRE = addr("77" + runId), BUY = addr("b0" + runId);
await onboard(admin, admin2, { email: `g.tre.${runId}@x.dev`, password: "gtre1234", role: "Auditor", useCaseKey: gcfg.key, walletAddress: TRE, kyc: { legalName: "Treasury", country: "IN" } });
const off = await call("POST", "/assets", { useCaseKey: gcfg.key, name: `GATE-${runId}`, chainId: chain, initialSupply: "1000", treasuryAccount: TRE, metadata: { issuer: "Demo", assetClass: "security" }, sale: { unitPrice: "10", currency: "CBDC-INR", treasuryAccount: TRE } }, gdesk);
const assetId = off.json?.asset?.id;
ok(off.status === 201, "desk issues a 1000-unit offering", off.json);
// buyer: kycStatus approved (passes the allowlist gate) but NO KYC credential yet
const buyer = await onboard(admin, admin2, { email: `g.buy.${runId}@x.dev`, password: "gbuy1234", role: "Buyer", useCaseKey: gcfg.key, walletAddress: BUY });
await call("PATCH", `/users/${buyer.id}`, { kycStatus: "approved" }, admin);
await call("POST", `/assets/${assetId}/actions/allow`, { account: BUY }, gdesk);
await call("POST", "/cash/credit", { account: BUY, currency: "CBDC-INR", amount: "100000" }, admin);
const buyerTok = await login(`g.buy.${runId}@x.dev`, "gbuy1234");
const b1 = await call("POST", `/assets/${assetId}/buy`, { quantity: "10" }, buyerTok);
ok(b1.status >= 400 && b1.json?.error === "IDENTITY_NOT_VERIFIED", "① buy WITHOUT a KYC credential → refused IDENTITY_NOT_VERIFIED", { status: b1.status, error: b1.json?.error });
// a verifier org issues the buyer a KycCredential
const vorg = (await call("POST", "/orgs", { name: `KYC Verifier ${runId}`, orgType: "verifier" }, admin)).json;
await call("POST", `/orgs/${vorg.id}/users`, { email: `v1.${runId}@x.dev`, password: "v1pass12", role: "OrgAdmin" }, admin);
await call("POST", `/orgs/${vorg.id}/users`, { email: `v2.${runId}@x.dev`, password: "v2pass12", role: "OrgAdmin" }, admin);
const v1 = await login(`v1.${runId}@x.dev`, "v1pass12"), v2 = await login(`v2.${runId}@x.dev`, "v2pass12");
const kreq = await call("POST", "/credentials/requests", { type: "KycCredential", subjectUserId: buyer.id, claims: { legalName: "Bob Buyer", country: "IN" } }, v1);
await call("POST", `/proposals/${kreq.json.proposal.id}/approve`, {}, v2);
ok(kreq.status === 202, "verifier org issues the buyer a KycCredential (maker-checker)");
const b2 = await call("POST", `/assets/${assetId}/buy`, { quantity: "10" }, buyerTok);
ok(b2.status === 200 && b2.json?.delivered?.amount === "10", "② buy WITH the KYC credential → allowed (10 delivered)", { status: b2.status, error: b2.json?.error });
// revoke → gate closes again
const kcred = (await call("GET", "/me/credentials", null, buyerTok)).json?.find((c) => c.type.includes("KycCredential"));
const rev = await call("POST", `/credentials/${kcred.id}/revoke`, { reason: "e2e demo" }, v1);
if (rev.status === 202) await call("POST", `/proposals/${rev.json.proposal.id}/approve`, {}, v2);
const b3 = await call("POST", `/assets/${assetId}/buy`, { quantity: "10" }, buyerTok);
ok(b3.status >= 400 && b3.json?.error === "IDENTITY_NOT_VERIFIED", "③ buy AFTER revoke → refused again (revocation flips the gate live)", { status: b3.status, error: b3.json?.error });

console.log(`\n${fails ? `❌ ${fails} CHECK(S) FAILED` : "✅ FULL-PLATFORM E2E PASSED — provisioned an identity program from a template (ID-G), a scoped desk issued a credential (ID-F), and a KYC credential gated a real tokenization buy with live revocation (ID-H)."}`);
process.exit(fails ? 1 : 0);
