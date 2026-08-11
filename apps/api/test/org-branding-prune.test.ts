import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";
import { PLATFORM_ORG_NAME } from "../src/platform-org.js";

const ROUNDS = 4;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQIABiAB/8s3lOgAAAAASUVORK5CYII=";

/** An active org plus a logged-in OrgAdmin of it. Same eleven-line fixture as
 *  org-branding-upload.test.ts, copied for the reason stated there: it is a
 *  fixture, not shared logic. */
async function org(h: TestAppHandle, label: string) {
  const tag = Math.random().toString(36).slice(2, 8);
  const rec = await h.organizations.create({
    name: `${label} ${tag}`, orgType: "corporate", registrationId: null, jurisdiction: null,
    did: `did:key:zB${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
    verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
    brandLogoDocumentId: null, brandAccent: null,
  });
  const email = `admin-${tag}@brandprune.dev`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync("brand-secret-1", ROUNDS), role: "OrgAdmin",
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId: rec.id, kind: "human",
  });
  return { id: rec.id, token: await loginAs(h.app, email, "brand-secret-1") };
}

const upload = (h: TestAppHandle, orgId: string, token: string) =>
  h.app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/branding/logo`, headers: auth(token), payload: { contentType: "image/png", dataBase64: PNG_B64 } });

const patchBranding = (h: TestAppHandle, orgId: string, token: string, body: unknown) =>
  h.app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/branding`, headers: auth(token), payload: body });

/** An ordinary (non-brand-logo) document, via the artwork upload door — the
 *  real door a caller would use, not a repository shortcut. Needs an org that
 *  owns a credential use case; the caller supplies both. */
const uploadArtwork = (h: TestAppHandle, useCaseKey: string, token: string) =>
  h.app.inject({
    method: "POST", url: `${V1}/credential-use-cases/${useCaseKey}/certificate/artwork`, headers: auth(token),
    payload: { contentType: "image/png", dataBase64: PNG_B64 },
  });

const courseCompletionType = (extra?: { logoDocumentId?: string }) => ({
  name: "CourseCompletion", title: "Course Completion", validityDays: 365, requiredApprovals: 1,
  claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
  certificate: { enabled: true, ...extra },
});

/**
 * THE REFUSAL THAT MAKES THE PRUNE SOUND, tested here rather than beside the
 * other certificate tests because it exists for this feature and nothing else.
 *
 * Certificate backgrounds live inside `CredentialUseCase.credentialTypes` JSON,
 * not in a column, and `checkBackgroundDocument` gated a pin on org ownership
 * alone. So an org could pin its own brand logo as artwork, that reference would
 * be invisible to any "is this document still pinned" query, and the prune would
 * delete bytes a certificate still draws. Refusing here closes the set of
 * possible references by construction: `Organization.brandLogoDocumentId` is
 * then the only one that can exist.
 */
describe("a brand logo is not certificate artwork", () => {
  it("refuses a brand-logo document at the certificate design door", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const tag = Math.random().toString(36).slice(2, 8);
    const key = `prune-${tag}`;
    await h.deps.credentialUseCases.create({
      key, name: "Prune Programme",
      credentialTypes: [courseCompletionType()],
      issuer: { kind: "org", orgId: a.id },
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      ownerOrgId: a.id,
    } as never);

    const up = await upload(h, a.id, a.token);
    expect(up.statusCode).toBe(201);
    const logo = up.json();

    const pinned = await h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${key}/certificate`, headers: auth(a.token),
      payload: { credentialType: "CourseCompletion", background: { documentId: logo.id, sha256: logo.sha256 } },
    });
    expect(pinned.statusCode).toBe(400);
    expect(pinned.json().error).toBe("BACKGROUND_IS_BRAND_LOGO");
  });

  it("still accepts artwork uploaded through the artwork door", async () => {
    // The refusal must bite brand logos and nothing else — artwork uploaded the
    // ordinary way carries `purpose: null` and is unaffected. Uploaded through
    // the real artwork door (not fabricated via the repository) so this proves
    // the HTTP path, not just the repository shape.
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const tag = Math.random().toString(36).slice(2, 8);
    const key = `prune-ok-${tag}`;
    await h.deps.credentialUseCases.create({
      key, name: "Prune Programme",
      credentialTypes: [courseCompletionType()],
      issuer: { kind: "org", orgId: a.id },
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      ownerOrgId: a.id,
    } as never);

    const art = await uploadArtwork(h, key, a.token);
    expect(art.statusCode).toBe(201);
    const artwork = art.json();
    const pinned = await h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${key}/certificate`, headers: auth(a.token),
      payload: { credentialType: "CourseCompletion", background: { documentId: artwork.documentId, sha256: artwork.sha256 } },
    });
    expect(pinned.statusCode).toBe(200);
  });
});

/**
 * A DOOR THE FIRST REVIEW MISSED: `certificate.logoDocumentId` is the same
 * kind of caller-supplied document reference as `certificate.background` — a
 * different field of the same JSON blob — and it is just as invisible to any
 * "is this document still pinned" query. `checkDefinitionBackgrounds` now
 * checks both, so both whole-definition doors (`POST`/`PATCH
 * /credential-use-cases`) refuse a brand logo named as a type's own logo, not
 * just as its background.
 */
describe("a brand logo is not a credential type's own logo either", () => {
  it("POST /credential-use-cases refuses certificate.logoDocumentId naming a brand-logo document", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const logo = (await upload(h, a.id, a.token)).json();
    const tag = Math.random().toString(36).slice(2, 8);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin),
      payload: {
        key: `logo-post-${tag}`, name: "Logo Programme",
        credentialTypes: [courseCompletionType({ logoDocumentId: logo.id })],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CERTIFICATE_LOGO_IS_BRAND_LOGO");
  });

  it("POST /credential-use-cases still accepts an ordinary document as logoDocumentId", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const art = await h.deps.documents.create({ contentType: "image/png", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: null, purpose: null });
    const tag = Math.random().toString(36).slice(2, 8);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin),
      payload: {
        key: `logo-post-ok-${tag}`, name: "Logo Programme",
        credentialTypes: [courseCompletionType({ logoDocumentId: art.id })],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("PATCH /credential-use-cases/:key refuses the same", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const logo = (await upload(h, a.id, a.token)).json();
    const tag = Math.random().toString(36).slice(2, 8);
    const key = `logo-patch-${tag}`;
    const created = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin),
      payload: {
        key, name: "Logo Programme", credentialTypes: [courseCompletionType()],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(created.statusCode).toBe(201);

    const patched = await h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${key}`, headers: auth(admin),
      payload: {
        name: "Logo Programme", credentialTypes: [courseCompletionType({ logoDocumentId: logo.id })],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().error).toBe("CERTIFICATE_LOGO_IS_BRAND_LOGO");
  });

  it("PATCH /credential-use-cases/:key still accepts an ordinary document as logoDocumentId", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const art = await h.deps.documents.create({ contentType: "image/png", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: null, purpose: null });
    const tag = Math.random().toString(36).slice(2, 8);
    const key = `logo-patch-ok-${tag}`;
    const created = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin),
      payload: {
        key, name: "Logo Programme", credentialTypes: [courseCompletionType()],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(created.statusCode).toBe(201);

    const patched = await h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${key}`, headers: auth(admin),
      payload: {
        name: "Logo Programme", credentialTypes: [courseCompletionType({ logoDocumentId: art.id })],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(patched.statusCode).toBe(200);
  });
});

/**
 * THE TEMPLATE-SAVE DOOR: `instantiateTemplate` copies `logoDocumentId`
 * verbatim onto the definitions it produces (unlike `background`, which it
 * always strips), so a saved template naming a brand logo would smuggle the
 * same invisible reference through every use case provisioned from it.
 * Refused at save, not stripped — there is no legitimate case to protect: the
 * fallback in `certificateLogoDocumentId` already applies the org's own brand
 * for free.
 */
describe("a brand logo is not a template's logo either", () => {
  it("POST /credential-use-case-templates refuses a template naming a brand-logo document", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const logo = (await upload(h, a.id, a.token)).json();
    const tag = Math.random().toString(36).slice(2, 8);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-case-templates`, headers: auth(admin),
      payload: {
        key: `tpl-logo-${tag}`, name: "Templated Programme", category: "custom", parameters: [],
        body: {
          keyTemplate: `tpl-logo-uc-${tag}`, nameTemplate: "Templated UC",
          holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
          credentialTypes: [{
            name: "ThingCredential", title: "Thing", validityDays: 365, requiredApprovals: 1,
            required: ["label"], properties: { label: { type: "string" } },
            certificate: { enabled: true, logoDocumentId: logo.id },
          }],
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CERTIFICATE_LOGO_IS_BRAND_LOGO");
  });

  it("POST /credential-use-case-templates still accepts an ordinary document as logoDocumentId", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const art = await h.deps.documents.create({ contentType: "image/png", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: null, purpose: null });
    const tag = Math.random().toString(36).slice(2, 8);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-case-templates`, headers: auth(admin),
      payload: {
        key: `tpl-logo-ok-${tag}`, name: "Templated Programme", category: "custom", parameters: [],
        body: {
          keyTemplate: `tpl-logo-ok-uc-${tag}`, nameTemplate: "Templated UC",
          holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
          credentialTypes: [{
            name: "ThingCredential", title: "Thing", validityDays: 365, requiredApprovals: 1,
            required: ["label"], properties: { label: { type: "string" } },
            certificate: { enabled: true, logoDocumentId: art.id },
          }],
        },
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

/**
 * THE PROVISION PATH: the template door refuses a brand-logo `logoDocumentId`
 * going forward, but a template saved BEFORE that refusal existed — simulated
 * here by writing straight to the template repository, bypassing the HTTP
 * save door entirely — can still carry one, and `POST
 * /credential-use-cases/provision` reads templates from storage with no
 * revalidation. This proves the belt-and-suspenders check on the provision
 * route itself, not just the template door, is what closes the gap: without
 * it, this exact template would provision successfully.
 */
describe("a brand logo cannot reach persistence through provisioning either", () => {
  it("POST /credential-use-cases/provision refuses a pre-existing template that names a brand-logo document", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const logo = (await upload(h, a.id, a.token)).json();
    const tag = Math.random().toString(36).slice(2, 8);
    const templateKey = `legacy-tpl-${tag}`;

    // Bypasses `POST /credential-use-case-templates` (and its refusal)
    // entirely — this is what a template saved before this change looks like.
    await h.deps.credentialTemplates.create({
      key: templateKey, name: "Legacy Programme", category: "custom", parameters: [],
      body: {
        keyTemplate: `legacy-uc-${tag}`, nameTemplate: "Legacy UC",
        holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
        credentialTypes: [{
          name: "ThingCredential", title: "Thing", validityDays: 365, requiredApprovals: 1,
          required: ["label"], properties: { label: { type: "string" } },
          certificate: { enabled: true, logoDocumentId: logo.id },
        }],
      },
    } as never);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/provision`, headers: auth(admin),
      payload: { templateKey, params: {}, provisioning: { issuerOrgName: `Provisioned Acme ${tag}` } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CERTIFICATE_LOGO_IS_BRAND_LOGO");
    // And nothing was left behind by the refused attempt.
    expect(await h.deps.credentialUseCases.get(`legacy-uc-${tag}`)).toBeNull();
  });

  it("POST /credential-use-cases/provision still provisions an ordinary template", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const art = await h.deps.documents.create({ contentType: "image/png", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: null, purpose: null });
    const tag = Math.random().toString(36).slice(2, 8);
    const templateKey = `ok-tpl-${tag}`;

    await h.deps.credentialTemplates.create({
      key: templateKey, name: "OK Programme", category: "custom", parameters: [],
      body: {
        keyTemplate: `ok-uc-${tag}`, nameTemplate: "OK UC",
        holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
        credentialTypes: [{
          name: "ThingCredential", title: "Thing", validityDays: 365, requiredApprovals: 1,
          required: ["label"], properties: { label: { type: "string" } },
          certificate: { enabled: true, logoDocumentId: art.id },
        }],
      },
    } as never);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/provision`, headers: auth(admin),
      payload: { templateKey, params: {}, provisioning: { issuerOrgName: `Provisioned OK ${tag}` } },
    });
    expect(res.statusCode).toBe(201);
  });
});

/**
 * ANOTHER DOOR: `POST /use-cases/:key/invoices` accepts a caller-supplied
 * `documentId` and checks only that it exists — no ownership, no purpose — so
 * an org's own unpinned brand-logo upload could otherwise be attached as
 * invoice evidence, a reference just as invisible to the prune as any other.
 */
describe("a brand logo is not invoice evidence", () => {
  const KEY = "invoice-tokenization";
  const row = { invoiceNumber: "PRUNE-1", invoiceDate: "2026-07-05", buyerName: "JSW Steel", currency: "INR", amount: 1800000, dueDate: "2026-10-15" };

  it("POST /use-cases/:key/invoices refuses a documentId naming a brand-logo document", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const issuer = await loginAs(h.app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const logo = (await upload(h, a.id, a.token)).json();

    const res = await h.app.inject({
      method: "POST", url: `${V1}/use-cases/${KEY}/invoices`, headers: auth(issuer),
      payload: { metadata: row, documentId: logo.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVOICE_DOCUMENT_IS_BRAND_LOGO");
  });

  it("POST /use-cases/:key/invoices still accepts an ordinary document as evidence", async () => {
    const h = await buildTestAppWithRepos();
    const issuer = await loginAs(h.app, "m1.issuer@tokenlayer.dev", "m1issuer123");
    const art = await h.deps.documents.create({ contentType: "image/png", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: null, purpose: null });

    const res = await h.app.inject({
      method: "POST", url: `${V1}/use-cases/${KEY}/invoices`, headers: auth(issuer),
      payload: { metadata: row, documentId: art.id },
    });
    expect(res.statusCode).toBe(201);
  });
});

/**
 * THE DOOR THE FIRST TWO REVIEWS BOTH MISSED: `POST /orgs/register` takes
 * caller-supplied document ids for `company.documents.{cinCertificate,
 * gstinCertificate}`, checks only that each exists, and persists
 * `{id, sha256}` into `Organization.companyProfile` JSON — the same shape as
 * `StagedInvoice.documentId`. Reachable by execution: upload a logo, pass its
 * id as the CIN certificate, get a 202. Unlike the other doors this one is
 * PUBLIC (registration runs before any org — and so any ownership check —
 * exists), which is exactly why it was easy to miss tracing the artwork
 * pipeline forward: KYB registration has nothing to do with certificates.
 */
describe("a brand logo is not a KYB certificate", () => {
  const registerBody = (tag: string, documents: { cinCertificate: { id: string }; gstinCertificate?: { id: string } }) => ({
    company: {
      name: `Regco ${tag}`, orgType: "corporate" as const, cin: `CIN${tag}`, pan: `PAN${tag}`,
      state: "Maharashtra", pincode: "400001", dateOfIncorporation: "2020-01-01",
      category: "private-limited" as const, companyStatus: "active" as const,
      documents,
    },
    admin: { name: "Reg Admin", email: `reg-admin-${tag}@brandprune.dev`, password: "reg-secret-1" },
  });
  const uploadKybDoc = (h: TestAppHandle) =>
    h.app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "image/png", dataBase64: PNG_B64 } });

  it("refuses a brand-logo document as the CIN certificate", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const logo = (await upload(h, a.id, a.token)).json();
    const tag = Math.random().toString(36).slice(2, 8);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/orgs/register`,
      payload: registerBody(tag, { cinCertificate: { id: logo.id } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("KYB_DOCUMENT_IS_BRAND_LOGO");
  });

  it("refuses a brand-logo document as the GSTIN certificate", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const logo = (await upload(h, a.id, a.token)).json();
    const cin = (await uploadKybDoc(h)).json();
    const tag = Math.random().toString(36).slice(2, 8);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/orgs/register`,
      payload: registerBody(tag, { cinCertificate: { id: cin.id }, gstinCertificate: { id: logo.id } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("KYB_DOCUMENT_IS_BRAND_LOGO");
  });

  it("still accepts an ordinary KYB upload", async () => {
    const h = await buildTestAppWithRepos();
    const cin = (await uploadKybDoc(h)).json();
    const tag = Math.random().toString(36).slice(2, 8);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/orgs/register`,
      payload: registerBody(tag, { cinCertificate: { id: cin.id } }),
    });
    expect(res.statusCode).toBe(202);
  });
});

/**
 * COVERAGE GAP CLOSED: `certificate.background` naming a brand logo was
 * proven at the org-scoped design door (the very first test in this file) but
 * never at the whole-definition doors that call `checkDefinitionBackgrounds`
 * directly — only `logoDocumentId` was tested there. Same predicate, same
 * field, the other door.
 */
describe("a brand logo is not a credential type's background either, at the whole-definition doors", () => {
  it("POST /credential-use-cases refuses certificate.background naming a brand-logo document", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const logo = (await upload(h, a.id, a.token)).json();
    const tag = Math.random().toString(36).slice(2, 8);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin),
      payload: {
        key: `bg-post-${tag}`, name: "Background Programme",
        credentialTypes: [{
          name: "CourseCompletion", title: "Course Completion", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: logo.id, sha256: logo.sha256 } },
        }],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BACKGROUND_IS_BRAND_LOGO");
  });

  it("PATCH /credential-use-cases/:key refuses the same", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const logo = (await upload(h, a.id, a.token)).json();
    const tag = Math.random().toString(36).slice(2, 8);
    const key = `bg-patch-${tag}`;
    const created = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin),
      payload: {
        key, name: "Background Programme", credentialTypes: [courseCompletionType()],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(created.statusCode).toBe(201);

    const patched = await h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${key}`, headers: auth(admin),
      payload: {
        name: "Background Programme",
        credentialTypes: [{
          name: "CourseCompletion", title: "Course Completion", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: logo.id, sha256: logo.sha256 } },
        }],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(patched.statusCode).toBe(400);
    expect(patched.json().error).toBe("BACKGROUND_IS_BRAND_LOGO");
  });
});

/**
 * THE ONE CALLER FOR WHICH `checkDefinitionBackgrounds` INSIDE
 * `createCredentialUseCaseFromDef` IS LOAD-BEARING. Provision's own create
 * branch is already refused earlier, at its own explicit call — this guard
 * exists for `POST /credential-use-cases/:key/clone-to-live`, which reaches
 * `createCredentialUseCaseFromDef` with no check of its own. The source use
 * case is seeded straight through the repository, bypassing every write-time
 * door, because that is the only way a sandbox use case can carry a
 * brand-logo `logoDocumentId` today — every door that writes one now refuses
 * it, which is exactly what makes this the one place left to prove.
 */
describe("a brand logo may not ride a clone to live either", () => {
  it("POST /credential-use-cases/:key/clone-to-live refuses a source carrying a brand-logo logoDocumentId", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const logo = (await upload(h, a.id, a.token)).json();
    const tag = Math.random().toString(36).slice(2, 8);
    const key = `clone-src-${tag}`;

    await h.deps.credentialUseCases.create({
      key, name: "Clone Source Programme", sandbox: true,
      credentialTypes: [courseCompletionType({ logoDocumentId: logo.id })],
      issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    } as never);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/clone-to-live`, headers: auth(admin), payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CERTIFICATE_LOGO_IS_BRAND_LOGO");
    // And no live clone was left behind by the refused attempt.
    expect(await h.deps.credentialUseCases.get(`${key}-live`)).toBeNull();
  });

  it("still clones a source with an ordinary logoDocumentId", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const art = await h.deps.documents.create({ contentType: "image/png", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: null, purpose: null });
    const tag = Math.random().toString(36).slice(2, 8);
    const key = `clone-src-ok-${tag}`;

    await h.deps.credentialUseCases.create({
      key, name: "Clone Source Programme", sandbox: true,
      credentialTypes: [courseCompletionType({ logoDocumentId: art.id })],
      issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    } as never);

    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/clone-to-live`, headers: auth(admin), payload: {},
    });
    expect(res.statusCode).toBe(201);
  });
});

const getDoc = (h: TestAppHandle, id: string) => h.deps.documents.get(id);

describe("POST /orgs/:id/branding/logo prunes superseded uploads", () => {
  it("a second upload deletes the unpinned first", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");

    const first = (await upload(h, a.id, a.token)).json();
    const second = (await upload(h, a.id, a.token)).json();

    expect(await getDoc(h, first.id)).toBeNull();
    expect(await getDoc(h, second.id)).not.toBeNull();
  });

  it("THE SAFETY PROPERTY: the pinned mark survives an upload", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");

    const live = (await upload(h, a.id, a.token)).json();
    expect((await patchBranding(h, a.id, a.token, { brandLogoDocumentId: live.id })).statusCode).toBe(200);

    const tryOne = (await upload(h, a.id, a.token)).json();
    const tryTwo = (await upload(h, a.id, a.token)).json();

    expect(await getDoc(h, live.id)).not.toBeNull();
    expect(await getDoc(h, tryOne.id)).toBeNull();
    expect(await getDoc(h, tryTwo.id)).not.toBeNull();

    // And the live mark is still served, which is what a user would notice.
    const served = await h.app.inject({ method: "GET", url: `${V1}/orgs/${a.id}/branding/logo`, headers: auth(a.token) });
    expect(served.statusCode).toBe(200);
  });

  it("is org-scoped: one org's upload leaves another's rows alone", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const b = await org(h, "Globex");

    const bLogo = (await upload(h, b.id, b.token)).json();
    await upload(h, a.id, a.token);
    await upload(h, a.id, a.token);

    expect(await getDoc(h, bLogo.id)).not.toBeNull();
  });

  it("a PlatformAdmin uploading on an org's behalf prunes THAT org's rows, not the platform org's", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const platformOrg = await h.organizations.findByName(PLATFORM_ORG_NAME);
    if (!platformOrg) throw new Error("platform org fixture missing");

    // Give the platform org its own brand-logo row FIRST. Without this the
    // platform org owns no brand-logo row in the fixture at all, and this
    // test would pass even for a prune that swept every org indiscriminately
    // — it never establishes the negative it claims to.
    const platformLogo = (await upload(h, platformOrg.id, admin)).json();

    const first = (await upload(h, a.id, admin)).json();
    const second = (await upload(h, a.id, admin)).json();

    expect(await getDoc(h, first.id)).toBeNull();
    expect(await getDoc(h, second.id)).not.toBeNull();
    expect(await getDoc(h, platformLogo.id)).not.toBeNull();
  });

  it("an ownerOrgId=null brand-logo row is never pruned — pinned by nothing, owned by no one", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const orphan = await h.deps.documents.create({ contentType: "image/png", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: null, purpose: "brand-logo" });

    await upload(h, a.id, a.token);
    await upload(h, a.id, a.token);

    expect(await getDoc(h, orphan.id)).not.toBeNull();
  });

  /**
   * A NOTE ON HOW THESE TWO TESTS ARE BUILT.
   *
   * `Promise.all` of two plain `app.inject()` calls does NOT create genuine
   * concurrent execution in this harness — verified empirically by tracing:
   * `MemoryDocumentRepository` has no real I/O latency, so the first
   * request's entire handler chain (list → store → prune) resolves purely
   * through microtasks and runs to completion before the second request's
   * handler is even dispatched, every single time. This held even across two
   * separate Fastify instances sharing the same `deps`, and even over a real
   * TCP loopback connection with `fetch()` — there is simply no forced yield
   * point anywhere in the handler when nothing it calls does real I/O. A
   * naive `Promise.all` test here would therefore either always fail (for
   * "two uploads", since the second deterministically supersedes the first —
   * which is exactly the intended, non-buggy feature behaviour for two
   * requests with no real overlap) or always pass for the wrong reason (for
   * "racing a PATCH", since the PATCH would simply finish first) — confirmed
   * by literally reverting each fix and watching a naive version of these
   * tests keep passing regardless.
   *
   * In production this doesn't apply: a real Prisma call against Postgres or
   * SQLite is real network/disk I/O, which is exactly the kind of operation
   * that lets two requests' handlers genuinely interleave — which is the
   * condition these two fixes exist for. `tick()` below simulates that one
   * property (a real repository call yields to the event loop) so the test
   * can exercise it — it does not fake any outcome; `documents.create` and
   * `documents.listByOwnerPurpose` still do exactly what they always do,
   * just after yielding once, the way a real database driver would.
   */
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  /**
   * CRITICAL 1 (quality review): the earlier version listed rows AFTER
   * storing this call's own upload and pruned anything that wasn't its own
   * row or the pinned mark, with no regard for timing — two overlapping
   * uploads would each see the OTHER as an abandoned pick and delete it.
   */
  it("two concurrent uploads to the same org do not delete each other", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");

    const realList = h.deps.documents.listByOwnerPurpose.bind(h.deps.documents);
    const realCreate = h.deps.documents.create.bind(h.deps.documents);
    h.deps.documents.listByOwnerPurpose = async (...args: Parameters<typeof realList>) => { await tick(); return realList(...args); };
    h.deps.documents.create = async (...args: Parameters<typeof realCreate>) => { await tick(); return realCreate(...args); };
    let r1, r2;
    try {
      [r1, r2] = await Promise.all([upload(h, a.id, a.token), upload(h, a.id, a.token)]);
    } finally {
      h.deps.documents.listByOwnerPurpose = realList;
      h.deps.documents.create = realCreate;
    }

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    const doc1 = r1.json();
    const doc2 = r2.json();

    expect(await getDoc(h, doc1.id)).not.toBeNull();
    expect(await getDoc(h, doc2.id)).not.toBeNull();
  });

  /**
   * CRITICAL 2 (quality review): the earlier version read the pin ONCE,
   * before the whole sweep, so a PATCH pinning an older mark anywhere during
   * the sweep was invisible to it. The pin is now re-read fresh immediately
   * before each candidate delete. Two rows are used deliberately: the PATCH
   * is triggered by the FIRST row's own delete completing, so it lands
   * strictly BETWEEN that moment and the SECOND row's own fresh pin check —
   * a window the old "read once, up front" code could not see into no
   * matter when the PATCH landed, and the new per-row read does.
   */
  it("an upload racing a PATCH that pins an older mark spares the newly pinned bytes", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");

    // Each upload prunes after itself, so setting up TWO unpinned candidates
    // side by side needs pruning suppressed for these two setup uploads —
    // otherwise the second setup upload would immediately delete the first,
    // and there would be nothing left for the real, triggering upload below
    // to race against.
    const realList = h.deps.documents.listByOwnerPurpose.bind(h.deps.documents);
    h.deps.documents.listByOwnerPurpose = async () => [];
    const otherOld = (await upload(h, a.id, a.token)).json(); // candidate #1 — processed first
    const willBePinnedMidSweep = (await upload(h, a.id, a.token)).json(); // candidate #2 — processed second
    h.deps.documents.listByOwnerPurpose = realList;

    const realRemove = h.deps.documents.removeByOwnerPurpose.bind(h.deps.documents);
    let firedOnce = false;
    h.deps.documents.removeByOwnerPurpose = async (id: string, ownerOrgId: string, purpose: "brand-logo") => {
      if (id === otherOld.id && !firedOnce) {
        firedOnce = true;
        // The REAL PATCH route, run mid-sweep — not a faked outcome.
        const patchRes = await patchBranding(h, a.id, a.token, { brandLogoDocumentId: willBePinnedMidSweep.id });
        expect(patchRes.statusCode).toBe(200);
      }
      return realRemove(id, ownerOrgId, purpose);
    };
    let uploadRes;
    try {
      uploadRes = await upload(h, a.id, a.token); // candidates snapshot: [otherOld, willBePinnedMidSweep]
    } finally {
      h.deps.documents.removeByOwnerPurpose = realRemove;
    }
    expect(uploadRes.statusCode).toBe(201);

    expect(await getDoc(h, otherOld.id)).toBeNull(); // genuinely superseded, deleted as normal
    expect(await getDoc(h, willBePinnedMidSweep.id)).not.toBeNull(); // pinned mid-sweep — spared
    // And the live mark is still served, which is what a user would notice.
    const served = await h.app.inject({ method: "GET", url: `${V1}/orgs/${a.id}/branding/logo`, headers: auth(a.token) });
    expect(served.statusCode).toBe(200);
  });

  /**
   * IMPORTANT 3 (quality review): the org re-read at the top of the handler
   * proves the org exists, but the PRUNE re-reads it again itself — and if
   * THAT read comes back null (the org vanished in between; `organizations
   * .remove` exists and is called elsewhere in this file), the earlier
   * version treated "unknown" as "nothing pinned" and deleted freely. Forcing
   * only the prune's own re-read to fail (not the handler's initial
   * existence check) proves the fix, not just the unit-level guard.
   */
  it("prunes nothing when the organization cannot be re-read partway through the request", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const first = (await upload(h, a.id, a.token)).json();

    const realGet = h.deps.organizations.get.bind(h.deps.organizations);
    let calls = 0;
    h.deps.organizations.get = async (orgId: string) => {
      calls++;
      // Call 1 is the handler's own top-of-route existence check — let it
      // through so the upload proceeds normally. Calls after that are the
      // prune's re-read; make the org look gone from there on.
      if (orgId === a.id && calls > 1) return null;
      return realGet(orgId);
    };
    try {
      const res = await upload(h, a.id, a.token);
      expect(res.statusCode).toBe(201);
      const second = res.json();

      expect(await getDoc(h, first.id)).not.toBeNull();
      expect(await getDoc(h, second.id)).not.toBeNull();
    } finally {
      h.deps.organizations.get = realGet;
    }
  });

  it("a prune failure at the route level still returns 201 for the upload", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await upload(h, a.id, a.token);

    const realList = h.deps.documents.listByOwnerPurpose.bind(h.deps.documents);
    h.deps.documents.listByOwnerPurpose = async () => { throw new Error("database is on fire"); };
    try {
      const res = await upload(h, a.id, a.token);
      expect(res.statusCode).toBe(201);
    } finally {
      h.deps.documents.listByOwnerPurpose = realList;
    }
  });

  it("leaves documents from the other upload doors untouched", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const artwork = await h.deps.documents.create({ contentType: "image/png", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: a.id, purpose: null });

    await upload(h, a.id, a.token);
    await upload(h, a.id, a.token);

    expect(await getDoc(h, artwork.id)).not.toBeNull();
  });

  it("records what it removed in the audit log, including kept and pinned", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const first = (await upload(h, a.id, a.token)).json();
    const second = (await upload(h, a.id, a.token)).json();

    const entries = await h.audit.list();
    const pruned = entries.filter((e) => e.action === "brand-logo-pruned");
    expect(pruned).toHaveLength(1);
    const payload = pruned[0]!.payload as { orgId: string; removed: Array<{ id: string; size: number; createdAt: string }>; kept: string; pinned: string | null };
    expect(payload.orgId).toBe(a.id);
    expect(payload.kept).toBe(second.id);
    expect(payload.pinned).toBeNull();
    // `removed` carries full DocumentSummary rows, not bare ids — an id alone
    // resolves to nothing once the row is gone.
    expect(payload.removed.map((r) => r.id)).toEqual([first.id]);
    expect(payload.removed[0]).toMatchObject({ id: first.id, size: expect.any(Number), createdAt: expect.any(String) });
  });

  it("writes no audit entry when there was nothing to prune", async () => {
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    await upload(h, a.id, a.token);

    const entries = await h.audit.list();
    expect(entries.filter((e) => e.action === "brand-logo-pruned")).toHaveLength(0);
  });
});
