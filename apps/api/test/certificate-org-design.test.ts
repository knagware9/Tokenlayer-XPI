import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/api-keys.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const TEST_ROUNDS = 4;

/** A real 2×1 RGB PNG whose pixel data actually inflates — the fixture the
 *  EN-F suites share, reused rather than re-typed. */
const PNG_2x1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGM4AwYAEMMEyWIMKSwAAAAASUVORK5CYII=";

/** An org, its OrgAdmin, and a credential use case the org OWNS. */
interface World {
  h: TestAppHandle;
  orgId: string;
  orgAdmin: string;
  platform: string;
  key: string;
}

async function world(opts: { ownerOrgId?: string | null } = {}): Promise<World> {
  const h = await buildTestAppWithRepos();
  const tag = Math.random().toString(36).slice(2, 10);
  const org = await h.organizations.create({
    name: `Design Co ${tag}`, orgType: "issuer", registrationId: null, jurisdiction: null,
    did: `did:key:zDC${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
    verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
  });
  const email = `design-admin-${tag}@tokenlayer.dev`;
  const password = `design-admin-${tag}`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync(password, TEST_ROUNDS), role: "OrgAdmin",
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId: org.id, kind: "human",
  });
  const key = `design-${tag}`;
  await h.deps.credentialUseCases.create({
    key, name: "Design Programme",
    credentialTypes: [{
      name: "CourseCompletion", title: "Course Completion", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" }, grade: { type: "string" } } },
      certificate: { enabled: true },
    }],
    issuer: { kind: "org", orgId: org.id },
    holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    ownerOrgId: opts.ownerOrgId === undefined ? org.id : opts.ownerOrgId,
  } as never);
  return {
    h, orgId: org.id, key,
    orgAdmin: await loginAs(h.app, email, password),
    platform: await loginAs(h.app, "admin@tokenlayer.dev", "admin123"),
  };
}

/** Store a document DIRECTLY through the repository — the point of several tests
 *  below is that the HTTP document store refuses an OrgAdmin. */
async function storeDoc(h: TestAppHandle, contentType: string, b64: string): Promise<{ id: string; sha256: string }> {
  const d = await h.deps.documents.create({ contentType, bytes: Buffer.from(b64, "base64") });
  return { id: d.id, sha256: d.sha256 };
}

describe("a supplied background sha256 is verified at every writing door", () => {
  it("POST /credential-use-cases refuses a background whose pin does not match the stored bytes", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    const res = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(w.platform),
      payload: {
        key: `pinned-${Math.random().toString(36).slice(2, 8)}`, name: "Pinned",
        credentialTypes: [{
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: doc.id, sha256: "0x" + "b".repeat(64) } },
        }],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BACKGROUND_DOCUMENT_MISMATCH");
  });

  it("POST /credential-use-cases refuses a background naming a NON-IMAGE document", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "text/plain", Buffer.from("not a picture").toString("base64"));
    const res = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(w.platform),
      payload: {
        key: `texty-${Math.random().toString(36).slice(2, 8)}`, name: "Texty",
        credentialTypes: [{
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: doc.id } },
        }],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BACKGROUND_NOT_AN_IMAGE");
  });

  it("still accepts a bare documentId naming nothing — the render-time fallback is the guard there", async () => {
    // certificate-artwork.test.ts pins this on purpose: a deleted document must
    // degrade to the built-in layout, not turn every certificate into an error.
    // Tightening THIS door would break that, so it is deliberately not tightened.
    const w = await world();
    const res = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(w.platform),
      payload: {
        key: `ghost-${Math.random().toString(36).slice(2, 8)}`, name: "Ghost",
        credentialTypes: [{
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: "doc_does_not_exist" } },
        }],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("the preview route refuses a mismatched pin too", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    const res = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`, headers: auth(w.platform),
      payload: {
        credentialType: {
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: doc.id, sha256: "0x" + "c".repeat(64) }, placements: [] },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BACKGROUND_DOCUMENT_MISMATCH");
  });

  it("refuses a webp background — the renderer can draw only PNG and JPEG", async () => {
    // It would otherwise store with a 201 and silently print the built-in
    // layout on every certificate, which reads as "our design vanished".
    const w = await world();
    const doc = await storeDoc(w.h, "image/webp", PNG_2x1_B64);
    const res = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases`, headers: auth(w.platform),
      payload: {
        key: `webp-${Math.random().toString(36).slice(2, 8)}`, name: "Webp",
        credentialTypes: [{
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: doc.id } },
        }],
        issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BACKGROUND_NOT_AN_IMAGE");
  });

  it("the preview route refuses a malformed pin rather than ignoring it", async () => {
    // No definition validator runs on this door, so a non-string pin used to
    // set `pin = null` and skip verification entirely with a 200.
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    const res = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/preview-certificate`, headers: auth(w.platform),
      payload: {
        credentialType: {
          name: "C", title: "C", validityDays: 365, requiredApprovals: 1,
          claimSchema: { type: "object", required: ["fullName"], properties: { fullName: { type: "string" } } },
          certificate: { enabled: true, background: { documentId: doc.id, sha256: "not-a-digest" }, placements: [] },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BACKGROUND_PIN_MALFORMED");
  });

  it("PATCH /credential-use-cases/:key verifies the background too", async () => {
    // Wired identically to POST, and previously pinned only by inspection.
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    const current = (await w.h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/${w.key}`, headers: auth(w.platform) })).json() as Record<string, unknown>;
    const types = (current.credentialTypes as Array<Record<string, unknown>>).map((c) => ({
      ...c, certificate: { enabled: true, background: { documentId: doc.id, sha256: "0x" + "f".repeat(64) } },
    }));
    const res = await w.h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${w.key}`, headers: auth(w.platform),
      payload: { ...current, credentialTypes: types },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BACKGROUND_DOCUMENT_MISMATCH");
  });
});
