import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, onboardUser, V1, auth } from "./helpers.js";
import { certificateStatusBanner, humanizeKey } from "../src/certificate.js";

// Seed a credential use case with two types: one certificate-enabled, one not.
async function seedUseCase(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, key = "domicile-cert") {
  const DEF = {
    key, name: "Domicile",
    credentialTypes: [
      {
        name: "DomicileCredential", title: "Domicile Certificate", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["fullName", "district"], properties: { fullName: { type: "string" }, district: { type: "string" } } },
        certificate: { enabled: true, heading: "Certificate of Domicile", claimOrder: ["fullName", "district"] },
      },
      {
        name: "PlainCredential", title: "Plain", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
      },
    ],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
  };
  const r = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
  expect(r.statusCode).toBe(201);
  return DEF;
}

// A subject user with a DID (onboarding mints one; no kyc ⇒ no pre-existing credential).
async function subjectWithDid(app: Awaited<ReturnType<typeof buildTestApp>>): Promise<{ id: string; email: string; password: string }> {
  const maker = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  const checker = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
  const email = `cert-subj-${Math.random().toString(36).slice(2)}@x.dev`;
  const password = "secret1";
  const u = await onboardUser(app, maker, checker, {
    email, password, role: "Buyer", useCaseKey: "invoice-tokenization",
    walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  });
  return { id: u.id, email, password };
}

async function issueAndApprove(
  app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, admin2: string,
  ucKey: string, credentialType: string, subjectUserId: string, claims: Record<string, unknown>,
): Promise<void> {
  const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/${ucKey}/credentials`, headers: auth(admin),
    payload: { credentialType, subjectUserId, claims } });
  expect(issued.statusCode).toBe(202);
  const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${issued.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
  expect(approve.statusCode).toBe(200);
}

function pdfBuf(res: { rawPayload?: Buffer; payload: string }): Buffer {
  return res.rawPayload ?? Buffer.from(res.payload, "binary");
}

describe("credential PDF certificate route", () => {
  it("renders a PDF for a certificate-enabled credential", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app);
    await issueAndApprove(app, admin, admin2, "domicile-cert", "DomicileCredential", subject.id, { fullName: "Asha Rao", district: "Pune" });

    const subjTok = await loginAs(app, subject.email, subject.password);
    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
    const cred = (held.json() as { id: string; type: string[] }[]).find((c) => c.type.includes("DomicileCredential"))!;

    const res = await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/certificate.pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/pdf/);
    const buf = pdfBuf(res);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(800);
  });

  it("404s for a credential whose type has no certificate config", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app);
    await issueAndApprove(app, admin, admin2, "domicile-cert", "PlainCredential", subject.id, { fullName: "No Cert" });

    const subjTok = await loginAs(app, subject.email, subject.password);
    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
    const cred = (held.json() as { id: string; type: string[] }[]).find((c) => c.type.includes("PlainCredential"))!;

    const res = await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/certificate.pdf` });
    expect(res.statusCode).toBe(404);
  });

  it("404s for an unknown credential id", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: `${V1}/credentials/does-not-exist/certificate.pdf` });
    expect(res.statusCode).toBe(404);
  });

  it("certificateAvailable is true only for the cert-enabled type in /me/credentials", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app);
    await issueAndApprove(app, admin, admin2, "domicile-cert", "DomicileCredential", subject.id, { fullName: "Asha Rao", district: "Pune" });
    await issueAndApprove(app, admin, admin2, "domicile-cert", "PlainCredential", subject.id, { fullName: "No Cert" });

    const subjTok = await loginAs(app, subject.email, subject.password);
    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
    const rows = held.json() as { type: string[]; certificateAvailable: boolean }[];
    const withCert = rows.find((c) => c.type.includes("DomicileCredential"))!;
    const withoutCert = rows.find((c) => c.type.includes("PlainCredential"))!;
    expect(withCert.certificateAvailable).toBe(true);
    expect(withoutCert.certificateAvailable).toBe(false);
  });

  it("still renders a valid PDF (200) after the credential is revoked", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app);
    await issueAndApprove(app, admin, admin2, "domicile-cert", "DomicileCredential", subject.id, { fullName: "Asha Rao", district: "Pune" });

    const subjTok = await loginAs(app, subject.email, subject.password);
    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
    const cred = (held.json() as { id: string; type: string[] }[]).find((c) => c.type.includes("DomicileCredential"))!;

    const rReq = await app.inject({ method: "POST", url: `${V1}/credentials/${cred.id}/revoke`, headers: auth(admin), payload: { reason: "test revoke" } });
    expect(rReq.statusCode).toBe(202);
    const rApprove = await app.inject({ method: "POST", url: `${V1}/proposals/${rReq.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    expect(rApprove.statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/certificate.pdf` });
    expect(res.statusCode).toBe(200);
    const buf = pdfBuf(res);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("certificate helper functions", () => {
  it("humanizeKey title-cases camelCase / snake / kebab keys", () => {
    expect(humanizeKey("fullName")).toBe("Full Name");
  });

  it("certificateStatusBanner returns REVOKED when revoked", () => {
    expect(certificateStatusBanner({ status: { revoked: true, revokedAt: null, revokedReason: "fraud" }, expiresAt: null, nowMs: 0 })?.label).toBe("REVOKED");
  });

  it("certificateStatusBanner returns EXPIRED when past expiry", () => {
    expect(certificateStatusBanner({ status: { revoked: false, revokedAt: null, revokedReason: null }, expiresAt: "2000-01-01T00:00:00Z", nowMs: Date.parse("2020-01-01") })?.label).toBe("EXPIRED");
  });

  it("certificateStatusBanner returns null when live & unexpired", () => {
    expect(certificateStatusBanner({ status: { revoked: false, revokedAt: null, revokedReason: null }, expiresAt: null, nowMs: 0 })).toBeNull();
  });
});
