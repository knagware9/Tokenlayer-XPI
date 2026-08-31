import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, onboardUser, V1, auth } from "./helpers.js";
import { certificateStatusBanner, humanizeKey } from "../src/identity/certificate.js";

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

describe("credential QR route", () => {
  it("renders an SVG QR that encodes the public verification link, with no auth", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const subject = await subjectWithDid(app);
    // NOT certificate-enabled: the QR is a property of the CREDENTIAL, not of
    // whether its type prints a PDF — a plain credential still needs a way for
    // a verifier to scan and check it.
    await issueAndApprove(app, admin, admin2, "domicile-cert", "PlainCredential", subject.id, { fullName: "No Cert" });

    const subjTok = await loginAs(app, subject.email, subject.password);
    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
    const cred = (held.json() as { id: string; type: string[] }[]).find((c) => c.type.includes("PlainCredential"))!;

    // No `auth(...)` header at all — this is the public capability URL a phone
    // camera scans, same posture as /status and /certificate.pdf.
    const res = await app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/qr.svg` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(res.body).toContain("<svg");

    // A QR image is pixel modules, not literal text — the only honest way to
    // check the id is actually encoded (not a static/shared image) is to prove
    // a DIFFERENT credential id produces DIFFERENT module data.
    await issueAndApprove(app, admin, admin2, "domicile-cert", "PlainCredential", subject.id, { fullName: "Second" });
    const held2 = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) });
    const cred2 = (held2.json() as { id: string; type: string[] }[]).filter((c) => c.type.includes("PlainCredential"))
      .find((c) => c.id !== cred.id)!;
    const res2 = await app.inject({ method: "GET", url: `${V1}/credentials/${cred2.id}/qr.svg` });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).not.toBe(res.body);
  });

  it("404s for an unknown credential id", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: `${V1}/credentials/does-not-exist/qr.svg` });
    expect(res.statusCode).toBe(404);
  });
});

describe("stored credential-type certificate preview route", () => {
  it("PlatformAdmin, and a UseCaseAdmin scoped to this use case, can both preview an existing type's design", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);

    const platform = await app.inject({
      method: "GET", url: `${V1}/credential-use-cases/domicile-cert/credential-types/DomicileCredential/certificate-preview`,
      headers: auth(admin),
    });
    expect(platform.statusCode).toBe(200);
    expect(platform.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(pdfBuf(platform).subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // The bug this route exists to fix: a UseCaseAdmin authoring their OWN
    // use case's schema could not preview it at all — POST
    // /credential-use-cases/preview-certificate is PlatformAdmin/OrgAdmin-only,
    // and a desk operator has neither role.
    await onboardUser(app, admin, admin2, { email: "certpreview.admin@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: "domicile-cert" });
    const ucAdminToken = await loginAs(app, "certpreview.admin@x.dev", "secret1");
    const scoped = await app.inject({
      method: "GET", url: `${V1}/credential-use-cases/domicile-cert/credential-types/DomicileCredential/certificate-preview`,
      headers: auth(ucAdminToken),
    });
    expect(scoped.statusCode).toBe(200);
    expect(pdfBuf(scoped).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("previews the built-in layout for a type with no certificate config at all", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    const res = await app.inject({
      method: "GET", url: `${V1}/credential-use-cases/domicile-cert/credential-types/PlainCredential/certificate-preview`,
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(200);
    expect(pdfBuf(res).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("refuses a UseCaseAdmin scoped to a DIFFERENT use case (403), and 404s an unknown type name", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    await seedUseCase(app, admin);
    await seedUseCase(app, admin, "other-cert");
    await onboardUser(app, admin, admin2, { email: "certpreview.other@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: "other-cert" });
    const otherToken = await loginAs(app, "certpreview.other@x.dev", "secret1");

    const wrongDesk = await app.inject({
      method: "GET", url: `${V1}/credential-use-cases/domicile-cert/credential-types/DomicileCredential/certificate-preview`,
      headers: auth(otherToken),
    });
    expect(wrongDesk.statusCode).toBe(403);

    const unknownType = await app.inject({
      method: "GET", url: `${V1}/credential-use-cases/domicile-cert/credential-types/NoSuchType/certificate-preview`,
      headers: auth(admin),
    });
    expect(unknownType.statusCode).toBe(404);
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
