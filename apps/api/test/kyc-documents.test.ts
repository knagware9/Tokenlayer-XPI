import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

describe("KYC document upload and read gate", () => {
  it("an authenticated human can upload and then read back their own KYC document", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(buyer),
      payload: { contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 fake id doc").toString("base64") },
    });
    expect(upload.statusCode).toBe(201);
    const docId = upload.json().id as string;
    const read = await h.app.inject({ method: "GET", url: `${V1}/users/me/kyc/documents/${docId}`, headers: auth(buyer) });
    expect(read.statusCode).toBe(200);
    expect(read.payload).toContain("fake id doc");
  });

  it("a different non-admin user cannot read someone else's KYC document", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const other = await loginAs(h.app, "carbon.issuer@tokenlayer.dev", "carbon123");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(buyer),
      payload: { contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 private").toString("base64") },
    });
    const docId = upload.json().id as string;
    const read = await h.app.inject({ method: "GET", url: `${V1}/users/me/kyc/documents/${docId}`, headers: auth(other) });
    expect(read.statusCode).toBe(403);
  });

  it("a PlatformAdmin can read any KYC document", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(buyer),
      payload: { contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 reviewable").toString("base64") },
    });
    const docId = upload.json().id as string;
    const read = await h.app.inject({ method: "GET", url: `${V1}/users/me/kyc/documents/${docId}`, headers: auth(admin) });
    expect(read.statusCode).toBe(200);
  });

  it("accepts an upload whose base64 body exceeds the app's default 256KB bodyLimit but stays under DOC_UPLOAD_BODY_LIMIT", async () => {
    // A real ID scan or address-proof photo decodes to well over 190KB; base64
    // inflates that ~1.33x. This payload's raw bytes alone are ~300KB, so the
    // base64-encoded JSON body is well past Fastify's global 256KB bodyLimit but
    // safely under the route's DOC_UPLOAD_BODY_LIMIT (8MB) and MAX_DOC_BYTES (5MB)
    // ceiling — proving the route-level bodyLimit override is actually applied.
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(buyer),
      payload: { contentType: "application/pdf", dataBase64: Buffer.alloc(300 * 1024, "a").toString("base64") },
    });
    expect(upload.statusCode).toBe(201);
  });

  it("a UseCaseAdmin who is neither the uploader nor a PlatformAdmin gets 403 from GET /documents/:id on a KYC-purposed document (the dedicated gate is not bypassable via the pre-existing route)", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const useCaseAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(buyer),
      payload: { contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 kyc scan").toString("base64") },
    });
    expect(upload.statusCode).toBe(201);
    const docId = upload.json().id as string;
    const read = await h.app.inject({ method: "GET", url: `${V1}/documents/${docId}`, headers: auth(useCaseAdmin) });
    expect(read.statusCode).toBe(403);
    expect(read.json().error).toBe("FORBIDDEN");
  });

  it("a machine principal cannot upload a KYC document (no self to submit for)", async () => {
    const h = await buildTestAppWithRepos();
    // Real API-key minting path: an org, then POST /orgs/:id/api-keys — mirrors
    // apps/api/test/api-keys.test.ts's own makeOrg/mintKey helpers, reproduced
    // inline here since they're not exported from that file.
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await h.app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `KYC Doc Test Org ${Date.now()}`, orgType: "corporate" } });
    expect(org.statusCode).toBe(201);
    const orgId = org.json().id as string;
    const key = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${orgId}/api-keys`, headers: auth(admin),
      payload: { name: "kyc-doc-test-key", role: "Issuer", scopes: ["users:onboard"] },
    });
    expect(key.statusCode).toBe(201);
    const secret = key.json().secret as string;
    const upload = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/documents`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { contentType: "application/pdf", dataBase64: Buffer.from("x").toString("base64") },
    });
    expect(upload.statusCode).toBe(403);
    expect(upload.json().error).toBe("MACHINE_PRINCIPAL");
  });
});

describe("GET /users strips KYC document refs from non-PlatformAdmin views", () => {
  it("a UseCaseAdmin's view of a KYC-submitted user's kyc omits idDocument/addressDocument, but a PlatformAdmin's view of the same user keeps them", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const useCaseAdmin = await loginAs(h.app, "carbon.admin@tokenlayer.dev", "carbon123");
    const platformAdmin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const up1 = await h.app.inject({ method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(buyer), payload: { contentType: "application/pdf", dataBase64: Buffer.from("id").toString("base64") } });
    const up2 = await h.app.inject({ method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(buyer), payload: { contentType: "application/pdf", dataBase64: Buffer.from("addr").toString("base64") } });
    const submit = await h.app.inject({
      method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(buyer),
      payload: { legalName: "Doc Strip Test", country: "IN", idType: "passport", idNumber: "P9", idDocumentId: up1.json().id, addressDocumentId: up2.json().id },
    });
    expect(submit.statusCode).toBe(200);

    const asUseCaseAdmin = await h.app.inject({ method: "GET", url: `${V1}/users`, headers: auth(useCaseAdmin) });
    const uaRow = (asUseCaseAdmin.json() as { email: string; kyc: Record<string, unknown> }[]).find((u) => u.email === "carbon.buyer@tokenlayer.dev");
    expect(uaRow?.kyc?.legalName).toBe("Doc Strip Test");
    expect(uaRow?.kyc).not.toHaveProperty("idDocument");
    expect(uaRow?.kyc).not.toHaveProperty("addressDocument");

    const asPlatformAdmin = await h.app.inject({ method: "GET", url: `${V1}/users`, headers: auth(platformAdmin) });
    const paRow = (asPlatformAdmin.json() as { email: string; kyc: Record<string, unknown> }[]).find((u) => u.email === "carbon.buyer@tokenlayer.dev");
    expect((paRow?.kyc?.idDocument as { id: string } | undefined)?.id).toBe(up1.json().id);
    expect((paRow?.kyc?.addressDocument as { id: string } | undefined)?.id).toBe(up2.json().id);
  });
});
