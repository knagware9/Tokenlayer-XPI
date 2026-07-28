// Idempotent seed for the Decentralized-Identity-Work-Flow use cases (all except
// DigiYatra, whose binding is biometric, not key-based, so it isn't a DID/VC
// credential use case). Creates a dedicated GOVERNMENT issuer org per use case —
// each gets its own custodial DID, so credentials are signed under the real-world
// authority (University registrar, GSTN IRP, District office, Line department) —
// then creates (or re-binds) each credential use case to that issuer.
//
// Run against a live API:  node scripts/seed-identity-usecases.mjs
//   env: API (default http://localhost:4000/api/v1), ADMIN_EMAIL, ADMIN_PASSWORD.
// Safe to re-run: orgs are matched by name, use cases created-or-updated by key.

const API = process.env.API ?? "http://localhost:4000/api/v1";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@tokenlayer.dev";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin123";

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { ...(body != null ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body != null ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const S = (extra = {}) => ({ type: "string", ...extra });
const N = (extra = {}) => ({ type: "number", ...extra });
const ct = (name, title, required, properties, validityDays = 1825, requiredApprovals = 1) =>
  ({ name, title, requiredApprovals, validityDays, claimSchema: { type: "object", required, properties } });

// Issuer orgs (name → orgType). Each is created once and reused across runs.
const ISSUER_ORGS = {
  university: { name: "University Registrar (Sample)", orgType: "government" },
  gstn: { name: "GSTN IRP Portal", orgType: "government" },
  district: { name: "District Collector Office", orgType: "government" },
  lineDept: { name: "State Line Department", orgType: "government" },
};

// Credential use cases → which issuer org signs them.
const USE_CASES = (orgId) => [
  {
    issuerKey: "university",
    def: {
      key: "education-certificate", name: "Education Certificate",
      description: "Degree & academic credentials issued by a university registrar or examination board; verified by employers, BGV agencies and foreign universities. OpenBadges 3.0 semantics with selective disclosure.",
      credentialTypes: [ct("DegreeCredential", "Degree Credential",
        ["studentName", "institution", "degree", "conferredYear"],
        { studentName: S(), institution: S(), degree: S(), conferredYear: N({ min: 1900, max: 2100 }),
          classification: S({ enum: ["First Class with Distinction", "First Class", "Second Class", "Pass"] }), rollNumber: S() }, 10950)],
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    },
  },
  {
    issuerKey: "gstn",
    def: {
      key: "invoice-financing", name: "Invoice Financing",
      description: "Chained receivable credentials: an Invoice VC on IRN generation plus a Buyer Acceptance VC, presented by an MSME to a financier/NBFC via TReDS/OCEN. A shared encumbrance registry stops double-financing.",
      credentialTypes: [
        ct("InvoiceCredential", "Invoice Credential", ["irn", "invoiceNumber", "amount"],
          { irn: S(), invoiceNumber: S(), documentHash: S(), sellerGstin: S(), buyerGstin: S(), amount: N({ min: 0 }), currency: S({ enum: ["INR"] }), dueDate: S() }),
        ct("AcceptanceCredential", "Buyer Acceptance Credential", ["irn", "paymentDueDate"],
          { irn: S(), buyerName: S(), paymentDueDate: S(), grnReference: S() })],
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    },
  },
  {
    issuerKey: "district",
    def: {
      key: "domicile-certificate", name: "Domicile Certificate",
      description: "Residence credential issued by a Tehsildar/District Collector office; verified by state admissions, PSC recruitment, scholarship portals and EWS checks. Designed for predicate disclosure — prove the 15-year rule without revealing the address.",
      credentialTypes: [ct("DomicileCredential", "Domicile Credential",
        ["holderName", "state", "continuousResidenceSinceYear"],
        { holderName: S(), state: S(), district: S(), continuousResidenceSinceYear: N({ min: 1900, max: 2100 }) })],
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    },
  },
  {
    issuerKey: "lineDept",
    def: {
      key: "egovernance-certificate", name: "e-Governance Certificate",
      description: "The meta-pattern: income, caste, birth and trade-licence credentials issued by line departments (revenue, municipal, registrar) and consumed by other departments, banks and insurers — collapsing N-squared integrations to N.",
      credentialTypes: [
        ct("IncomeCertificate", "Income Certificate", ["holderName", "annualIncome", "financialYear"],
          { holderName: S(), annualIncome: N({ min: 0 }), financialYear: S(), issuingAuthority: S() }),
        ct("CasteCertificate", "Caste Certificate", ["holderName", "category"],
          { holderName: S(), category: S({ enum: ["SC", "ST", "OBC", "General"] }), issuingAuthority: S() }),
        ct("BirthCertificate", "Birth Certificate", ["holderName", "dateOfBirth"],
          { holderName: S(), dateOfBirth: S(), placeOfBirth: S(), registrationNumber: S() }, 36500),
        ct("TradeLicence", "Trade Licence", ["businessName", "licenceNumber"],
          { businessName: S(), licenceNumber: S(), tradeType: S(), validUpto: S() })],
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    },
  },
];

const login = await call("POST", "/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
const token = login.json?.token;
if (!token) { console.error("login failed — is the API up?", login.status); process.exit(2); }

// 1) Ensure each issuer org exists (match by name), capturing its id + DID.
const existing = (await call("GET", "/orgs", null, token)).json ?? [];
const orgId = {};
for (const [key, spec] of Object.entries(ISSUER_ORGS)) {
  let org = existing.find((o) => o.name === spec.name);
  if (!org) {
    const r = await call("POST", "/orgs", spec, token);
    org = r.json;
    console.log(`  + org  ${spec.name.padEnd(28)} ${r.status === 201 ? "created" : `ERR ${r.status} ${JSON.stringify(r.json)}`}  ${org?.did?.slice(0, 24) ?? ""}`);
  } else {
    console.log(`  = org  ${spec.name.padEnd(28)} reused   ${org.did?.slice(0, 24) ?? ""}`);
  }
  orgId[key] = org?.id;
}

// 2) Create or re-bind each credential use case to its issuer org.
for (const uc of USE_CASES()) {
  const def = { ...uc.def, issuer: { kind: "org", orgId: orgId[uc.issuerKey] } };
  const found = await call("GET", `/credential-use-cases/${def.key}`, null, token);
  const [method, path] = found.status === 200 ? ["PATCH", `/credential-use-cases/${def.key}`] : ["POST", "/credential-use-cases"];
  const r = await call(method, path, def, token);
  const types = def.credentialTypes.map((t) => t.name).join(", ");
  console.log(`  ${r.status < 300 ? "OK " : "ERR"} ${String(r.status).padEnd(3)} ${def.key.padEnd(24)} issuer=${ISSUER_ORGS[uc.issuerKey].name} [${types}]${r.status < 300 ? "" : ` -> ${JSON.stringify(r.json)}`}`);
}
console.log("\nDone — Decentralized-Identity use cases seeded (DigiYatra excluded: biometric binding, not a key-based DID/VC credential).");
