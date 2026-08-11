import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

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
