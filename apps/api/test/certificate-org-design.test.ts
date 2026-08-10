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

/** An org-scoped API key of the given mode, bound to a service OrgAdmin. */
async function orgKey(h: TestAppHandle, orgId: string, scopes: string[], mode: "live" | "test" = "live"): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 10);
  const svc = await h.users.create({
    email: `svc-design-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`unguessable-${tag}`, TEST_ROUNDS),
    role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved",
    kyc: null, orgId, kind: "service",
  });
  const minted = await mintSecret(TEST_ROUNDS, mode);
  await h.apiKeys.create({
    orgId, userId: svc.id, name: `key ${tag}`, prefix: minted.prefix, secretHash: minted.hash,
    scopes, expiresAt: null, createdBy: "test", mode,
  });
  return minted.secret;
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

const design = (w: World, token: string, payload: unknown) =>
  w.h.app.inject({ method: "PATCH", url: `${V1}/credential-use-cases/${w.key}/certificate`, headers: auth(token), payload });

const readBack = async (w: World) => {
  const res = await w.h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/${w.key}`, headers: auth(w.platform) });
  return res.json() as { credentialTypes: Array<{ name: string; certificate?: Record<string, unknown> }>; ownerOrgId?: string | null; issuer: { kind: string; orgId?: string }; sandbox?: boolean };
};

describe("PATCH /credential-use-cases/:key/certificate", () => {
  it("an owner OrgAdmin sets artwork and placements on their own use case", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    const res = await design(w, w.orgAdmin, {
      credentialType: "CourseCompletion",
      background: { documentId: doc.id, sha256: doc.sha256 },
      placements: [{ field: "claim:fullName", x: 0.5, y: 0.4, align: "center", fontSize: 22 }],
    });
    expect(res.statusCode).toBe(200);
    const cert = (await readBack(w)).credentialTypes[0].certificate as Record<string, unknown>;
    expect(cert.background).toEqual({ documentId: doc.id, sha256: doc.sha256 });
    expect(cert.placements).toHaveLength(1);
  });

  it("an OrgAdmin of a DIFFERENT org is refused", async () => {
    const w = await world();
    const res = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [] });
    expect(res.statusCode).toBe(200); // control: the owner still passes
    // The foreign admin must live in THIS app instance — a second `world()`
    // builds a separate app whose tokens this one has never issued, so a 403
    // from it would prove nothing about ownership.
    const tag = Math.random().toString(36).slice(2, 10);
    const foreignOrg = await w.h.organizations.create({
      name: `Foreign ${tag}`, orgType: "issuer", registrationId: null, jurisdiction: null,
      did: `did:key:zF${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
      verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
    });
    await w.h.users.create({
      email: `foreign-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`foreign-${tag}`, TEST_ROUNDS),
      role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved",
      kyc: null, orgId: foreignOrg.id, kind: "human",
    });
    const foreign = await loginAs(w.h.app, `foreign-${tag}@tokenlayer.dev`, `foreign-${tag}`);
    const denied = await design(w, foreign, { credentialType: "CourseCompletion", placements: [] });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("FORBIDDEN");
  });

  it("a use case with a NULL ownerOrgId refuses every OrgAdmin — null is not a match", async () => {
    // The recurring shape: `undefined === undefined` and `null === null` both
    // read as "owned by me" if the guard is written as a bare comparison.
    const w = await world({ ownerOrgId: null });
    const res = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [] });
    expect(res.statusCode).toBe(403);
    // CONTROL: a PlatformAdmin may still design it.
    expect((await design(w, w.platform, { credentialType: "CourseCompletion", placements: [] })).statusCode).toBe(200);
  });

  it("an ORG-LESS OrgAdmin is refused an UNOWNED use case — the case a bare `!==` lets through", async () => {
    // The test above does NOT reach the emptiness guard: its admin carries a
    // real orgId, so `null !== "org_…"` refuses on the comparison alone and a
    // bare `existing.ownerOrgId !== claims.orgId` would pass it. THIS is the
    // pairing that makes null-as-allow bite — `orgId: null` on the caller and
    // `ownerOrgId: null` on the record, where `null !== null` is false and the
    // route answers 200 for a use case nobody owns. Verified by mutation: drop
    // the `!orgId` half and this test, and only this test, turns green at 200.
    const w = await world({ ownerOrgId: null });
    const tag = Math.random().toString(36).slice(2, 10);
    await w.h.users.create({
      email: `orgless-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`orgless-${tag}`, TEST_ROUNDS),
      role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved",
      kyc: null, orgId: null, kind: "human",
    });
    const orgless = await loginAs(w.h.app, `orgless-${tag}@tokenlayer.dev`, `orgless-${tag}`);
    const res = await design(w, orgless, { credentialType: "CourseCompletion", placements: [] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("a role that is neither PlatformAdmin nor OrgAdmin is refused, though authScoped admits every human", async () => {
    const w = await world();
    const tag = Math.random().toString(36).slice(2, 10);
    await w.h.users.create({
      email: `holder-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`holder-${tag}`, TEST_ROUNDS),
      role: "Holder", useCaseKey: w.key, accountId: null, active: true, kycStatus: "approved",
      kyc: null, orgId: w.orgId, kind: "human",
    });
    const holder = await loginAs(w.h.app, `holder-${tag}@tokenlayer.dev`, `holder-${tag}`);
    const res = await design(w, holder, { credentialType: "CourseCompletion", placements: [] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("a key without usecases:provision is refused; one with it passes", async () => {
    const w = await world();
    const wrong = await orgKey(w.h, w.orgId, ["credentials:read"]);
    const denied = await design(w, wrong, { credentialType: "CourseCompletion", placements: [] });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "usecases:provision" } });

    const right = await orgKey(w.h, w.orgId, ["usecases:provision"]);
    expect((await design(w, right, { credentialType: "CourseCompletion", placements: [] })).statusCode).toBe(200);
  });

  it("a tl_test_ key may not design a LIVE use case", async () => {
    const w = await world();
    const testKey = await orgKey(w.h, w.orgId, ["usecases:provision"], "test");
    const res = await design(w, testKey, { credentialType: "CourseCompletion", placements: [] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("WRONG_MODE");
  });

  it("404s an unknown use case and an unknown credential type", async () => {
    const w = await world();
    const noKey = await w.h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/nope-nope/certificate`,
      headers: auth(w.orgAdmin), payload: { credentialType: "CourseCompletion", placements: [] },
    });
    expect(noKey.statusCode).toBe(404);
    const noType = await design(w, w.orgAdmin, { credentialType: "NotAType", placements: [] });
    expect(noType.statusCode).toBe(404);
    expect(noType.json().message).toContain("NotAType");
  });

  it("changes NOTHING but the certificate, whatever else the body carries", async () => {
    const w = await world();
    const before = await readBack(w);
    const res = await design(w, w.orgAdmin, {
      credentialType: "CourseCompletion",
      placements: [{ field: "claim:fullName", x: 0.2, y: 0.2 }],
      // Every one of these is a field the definition PATCH would honour.
      key: "hijacked", sandbox: true, ownerOrgId: "org_someone_else",
      issuer: { kind: "platform" }, holderPolicy: { who: "specific", orgIds: [] },
      credentialTypes: [], name: "Renamed",
    });
    expect(res.statusCode).toBe(200);
    const after = await readBack(w);
    expect(after.ownerOrgId).toBe(before.ownerOrgId);
    expect(after.issuer).toEqual(before.issuer);
    expect(after.sandbox ?? false).toBe(before.sandbox ?? false);
    expect(after.credentialTypes.map((c) => c.name)).toEqual(before.credentialTypes.map((c) => c.name));
    expect((await w.h.app.inject({ method: "GET", url: `${V1}/credential-use-cases/hijacked`, headers: auth(w.platform) })).statusCode).toBe(404);
  });

  it("requires the pin, and refuses a mismatch, a missing document and a non-image", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    const text = await storeDoc(w.h, "text/plain", Buffer.from("nope").toString("base64"));

    const noPin = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: { documentId: doc.id } });
    expect(noPin.statusCode).toBe(400);
    expect(noPin.json().error).toBe("BACKGROUND_PIN_REQUIRED");

    const wrongPin = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: { documentId: doc.id, sha256: "0x" + "d".repeat(64) } });
    expect(wrongPin.json().error).toBe("BACKGROUND_DOCUMENT_MISMATCH");

    const missing = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: { documentId: "doc_nope", sha256: "0x" + "e".repeat(64) } });
    expect(missing.json().error).toBe("BACKGROUND_DOCUMENT_NOT_FOUND");

    const notImage = await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: { documentId: text.id, sha256: text.sha256 } });
    expect(notImage.json().error).toBe("BACKGROUND_NOT_AN_IMAGE");
  });

  it("omitting a field leaves it alone; null background clears the artwork; [] clears placements", async () => {
    const w = await world();
    const doc = await storeDoc(w.h, "image/png", PNG_2x1_B64);
    await design(w, w.orgAdmin, {
      credentialType: "CourseCompletion",
      background: { documentId: doc.id, sha256: doc.sha256 },
      placements: [{ field: "claim:fullName", x: 0.5, y: 0.4 }],
    });

    // Placements only — the artwork stays.
    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [{ field: "claim:grade", x: 0.6, y: 0.6 }] });
    let cert = (await readBack(w)).credentialTypes[0].certificate as Record<string, unknown>;
    expect((cert.background as { documentId: string }).documentId).toBe(doc.id);
    expect(cert.placements).toHaveLength(1);

    // Artwork cleared — placements survive, inert, exactly as an instantiated
    // template lands.
    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", background: null });
    cert = (await readBack(w)).credentialTypes[0].certificate as Record<string, unknown>;
    expect(cert.background).toBeUndefined();
    expect(cert.placements).toHaveLength(1);

    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [] });
    cert = (await readBack(w)).credentialTypes[0].certificate as Record<string, unknown>;
    expect(cert.placements).toEqual([]);
  });

  it("refuses a malformed placement with the placement code, naming the chip", async () => {
    const w = await world();
    const res = await design(w, w.orgAdmin, {
      credentialType: "CourseCompletion",
      placements: [{ field: "claim:fullName", x: 0.5, y: 0.5 }, { field: "claim:nope", x: 0.1, y: 0.1 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_CERTIFICATE_PLACEMENT");
    expect(res.json().message).toContain("[1]");
  });

  it("never toggles `enabled` on a type that has a certificate block, and creates one enabled when it does not", async () => {
    const w = await world();
    // The seeded type has { enabled: true }; turn it off through the platform
    // door, then design and confirm the design did not turn it back on.
    const full = (await readBack(w)) as unknown as Record<string, unknown>;
    const types = (full.credentialTypes as Array<Record<string, unknown>>).map((c) => ({ ...c, certificate: { enabled: false } }));
    const off = await w.h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${w.key}`, headers: auth(w.platform),
      payload: { ...full, credentialTypes: types },
    });
    expect(off.statusCode).toBe(200);
    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [{ field: "claim:fullName", x: 0.1, y: 0.1 }] });
    expect(((await readBack(w)).credentialTypes[0].certificate as { enabled: boolean }).enabled).toBe(false);

    // And with no block at all, designing creates one that is enabled —
    // otherwise the org has produced dead config it cannot turn on.
    const bare = (await readBack(w)) as unknown as Record<string, unknown>;
    const stripped = (bare.credentialTypes as Array<Record<string, unknown>>).map(({ certificate, ...rest }) => { void certificate; return rest; });
    expect((await w.h.app.inject({
      method: "PATCH", url: `${V1}/credential-use-cases/${w.key}`, headers: auth(w.platform),
      payload: { ...bare, credentialTypes: stripped },
    })).statusCode).toBe(200);
    await design(w, w.orgAdmin, { credentialType: "CourseCompletion", placements: [{ field: "claim:fullName", x: 0.1, y: 0.1 }] });
    expect(((await readBack(w)).credentialTypes[0].certificate as { enabled: boolean }).enabled).toBe(true);
  });
});

describe("POST /credential-use-cases/:key/certificate/artwork", () => {
  const upload = (w: World, token: string, payload: unknown) =>
    w.h.app.inject({ method: "POST", url: `${V1}/credential-use-cases/${w.key}/certificate/artwork`, headers: auth(token), payload });

  it("admits an owner OrgAdmin, who the general document store refuses", async () => {
    const w = await world();
    // THE CONTROL, and the reason this route exists: RbacPolicy grants OrgAdmin
    // only `read`, so the general store is closed to them in both directions.
    const store = await w.h.app.inject({
      method: "POST", url: `${V1}/documents`, headers: auth(w.orgAdmin),
      payload: { contentType: "image/png", dataBase64: PNG_2x1_B64 },
    });
    expect(store.statusCode).toBe(403);

    const res = await upload(w, w.orgAdmin, { contentType: "image/png", dataBase64: PNG_2x1_B64 });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { documentId: string; sha256: string; size: number };
    expect(body.documentId).toBeTruthy();
    expect(body.sha256).toMatch(/^0x[0-9a-f]{64}$/);

    // And what it returns is directly usable as the pin.
    const set = await design(w, w.orgAdmin, {
      credentialType: "CourseCompletion",
      background: { documentId: body.documentId, sha256: body.sha256 },
    });
    expect(set.statusCode).toBe(200);
  });

  it("refuses a non-image upload — this door is for artwork only", async () => {
    const w = await world();
    const res = await upload(w, w.orgAdmin, { contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4").toString("base64") });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe("UNSUPPORTED_DOCUMENT_TYPE");
  });

  it("refuses a foreign org, an unknown key, and a non-admin role", async () => {
    const w = await world();
    const tag = Math.random().toString(36).slice(2, 10);
    const foreignOrg = await w.h.organizations.create({
      name: `Foreign U ${tag}`, orgType: "issuer", registrationId: null, jurisdiction: null,
      did: `did:key:zFU${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
      verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
    });
    await w.h.users.create({
      email: `foreign-u-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`foreign-u-${tag}`, TEST_ROUNDS),
      role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved",
      kyc: null, orgId: foreignOrg.id, kind: "human",
    });
    const foreign = await loginAs(w.h.app, `foreign-u-${tag}@tokenlayer.dev`, `foreign-u-${tag}`);
    expect((await upload(w, foreign, { contentType: "image/png", dataBase64: PNG_2x1_B64 })).statusCode).toBe(403);

    const unknown = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/nope-nope/certificate/artwork`,
      headers: auth(w.orgAdmin), payload: { contentType: "image/png", dataBase64: PNG_2x1_B64 },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
