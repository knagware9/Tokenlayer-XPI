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
      credentialTypes: [{
        name: "CourseCompletion", title: "Course Completion", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
        certificate: { enabled: true },
      }],
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
    // ordinary way carries `purpose: null` and is unaffected.
    const h = await buildTestAppWithRepos();
    const a = await org(h, "Acme");
    const tag = Math.random().toString(36).slice(2, 8);
    const key = `prune-ok-${tag}`;
    await h.deps.credentialUseCases.create({
      key, name: "Prune Programme",
      credentialTypes: [{
        name: "CourseCompletion", title: "Course Completion", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
        certificate: { enabled: true },
      }],
      issuer: { kind: "org", orgId: a.id },
      holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      ownerOrgId: a.id,
    } as never);

    const art = await h.deps.documents.create({ contentType: "image/png", bytes: Buffer.from(PNG_B64, "base64"), ownerOrgId: a.id, purpose: null });
    const pinned = await h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${key}/certificate`, headers: auth(a.token),
      payload: { credentialType: "CourseCompletion", background: { documentId: art.id, sha256: art.sha256 } },
    });
    expect(pinned.statusCode).toBe(200);
  });
});
