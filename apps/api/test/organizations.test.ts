import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeJwt, publicKeyFromDidKey, verifyJwtSignature } from "@tokenlayer/core";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

let app: FastifyInstance;
let admin: string;
beforeAll(async () => {
  app = await buildTestApp();
  admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
});
afterAll(async () => { await app.close(); });

async function createOrg(token: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(token), payload: body });
}

describe("POST /orgs", () => {
  it("mints a resolvable parent DID (PlatformAdmin)", async () => {
    const res = await createOrg(admin, { name: "Acme Bank", orgType: "bank", registrationId: "REG-ACME", jurisdiction: "IN" });
    expect(res.statusCode).toBe(201);
    const org = res.json();
    expect(org.did.startsWith("did:key:z")).toBe(true);
    expect(org.verified).toBe(true);
    expect(() => publicKeyFromDidKey(org.did)).not.toThrow();
  });

  it("rejects a non-PlatformAdmin", async () => {
    const uca = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await createOrg(uca, { name: "Nope Inc", orgType: "corporate" });
    expect(res.statusCode).toBe(403);
  });

  it("409s a duplicate name", async () => {
    await createOrg(admin, { name: "Dup Org", orgType: "corporate" });
    const res = await createOrg(admin, { name: "Dup Org", orgType: "corporate" });
    expect(res.statusCode).toBe(409);
  });

  it("503s when the keystore is unconfigured in production", async () => {
    const prod = await buildTestApp({ isProduction: true, didMasterConfigured: false });
    const t = await loginAs(prod, "admin@tokenlayer.dev", "admin123");
    const res = await prod.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(t), payload: { name: "P", orgType: "bank" } });
    expect(res.statusCode).toBe(503);
    await prod.close();
  });
});

describe("GET /orgs, GET /orgs/:id", () => {
  it("PlatformAdmin lists all and reads one", async () => {
    const created = (await createOrg(admin, { name: "ReadMe Org", orgType: "msme" })).json();
    const list = await app.inject({ method: "GET", url: `${V1}/orgs`, headers: auth(admin) });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((o: { id: string }) => o.id === created.id)).toBe(true);
    const one = await app.inject({ method: "GET", url: `${V1}/orgs/${created.id}`, headers: auth(admin) });
    expect(one.statusCode).toBe(200);
    expect(one.json().name).toBe("ReadMe Org");
  });
});

describe("POST /orgs/:id/users (members)", () => {
  it("mints a sub-DID + a membership VC that verifies against the org DID", async () => {
    const org = (await createOrg(admin, { name: "Member Org", orgType: "bank" })).json();
    const res = await app.inject({
      method: "POST", url: `${V1}/orgs/${org.id}/users`, headers: auth(admin),
      payload: { email: `issuer.${org.id}@x.io`, password: "secret1", role: "Issuer" },
    });
    expect(res.statusCode).toBe(201);
    const member = res.json();
    expect(member.did.startsWith("did:key:z")).toBe(true);
    expect(member.membershipVc).toBe(true);

    const memberToken = await loginAs(app, `issuer.${org.id}@x.io`, "secret1");
    const creds = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(memberToken) });
    expect(creds.statusCode).toBe(200);
    const list = creds.json();
    expect(list).toHaveLength(1);
    expect(list[0].type).toContain("OrganizationMembership");
    expect(verifyJwtSignature(list[0].vcJwt, publicKeyFromDidKey(org.did))).toBe(true);
    expect((decodeJwt(list[0].vcJwt).payload.vc as { credentialSubject: { id: string } }).credentialSubject.id).toBe(member.did);
  });

  it("an OrgAdmin cannot mint a PlatformAdmin and cannot act on another org", async () => {
    const orgA = (await createOrg(admin, { name: "Org A", orgType: "corporate" })).json();
    const orgB = (await createOrg(admin, { name: "Org B", orgType: "corporate" })).json();
    const adminRes = await app.inject({
      method: "POST", url: `${V1}/orgs/${orgA.id}/users`, headers: auth(admin),
      payload: { email: `orgadmin.${orgA.id}@x.io`, password: "secret1", role: "OrgAdmin" },
    });
    expect(adminRes.statusCode).toBe(201);
    const orgAdmin = await loginAs(app, `orgadmin.${orgA.id}@x.io`, "secret1");

    const cross = await app.inject({ method: "POST", url: `${V1}/orgs/${orgB.id}/users`, headers: auth(orgAdmin), payload: { email: "x@x.io", password: "secret1", role: "Issuer" } });
    expect(cross.statusCode).toBe(403);
    const esc = await app.inject({ method: "POST", url: `${V1}/orgs/${orgA.id}/users`, headers: auth(orgAdmin), payload: { email: "pa@x.io", password: "secret1", role: "PlatformAdmin" } });
    expect(esc.statusCode).toBe(403);
    const listB = await app.inject({ method: "GET", url: `${V1}/orgs/${orgB.id}/members`, headers: auth(orgAdmin) });
    expect(listB.statusCode).toBe(403);
  });

  it("lists an org's members", async () => {
    const org = (await createOrg(admin, { name: "Roster Org", orgType: "government" })).json();
    await app.inject({ method: "POST", url: `${V1}/orgs/${org.id}/users`, headers: auth(admin), payload: { email: `a.${org.id}@x.io`, password: "secret1", role: "Auditor" } });
    const members = await app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/members`, headers: auth(admin) });
    expect(members.statusCode).toBe(200);
    expect(members.json().length).toBeGreaterThanOrEqual(1);
    expect(members.json()[0]).toHaveProperty("did");
  });
});

describe("GET /dids/:did/document", () => {
  it("resolves a did:key into a W3C DID document", async () => {
    const org = (await createOrg(admin, { name: "DIDDoc Org", orgType: "verifier" })).json();
    const res = await app.inject({ method: "GET", url: `${V1}/dids/${encodeURIComponent(org.did)}/document`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.id).toBe(org.did);
    expect(doc.verificationMethod[0].type).toBe("Ed25519VerificationKey2020");
    expect(doc.verificationMethod[0].publicKeyMultibase).toBe(org.did.slice("did:key:".length));
    expect(doc.authentication[0]).toBe(`${org.did}#0`);
  });

  it("400s a non-did:key", async () => {
    const res = await app.inject({ method: "GET", url: `${V1}/dids/${encodeURIComponent("did:web:example.com")}/document`, headers: auth(admin) });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /use-cases (org scoping)", () => {
  it("an OrgAdmin sees only use cases owned by their org", async () => {
    const orgA = (await createOrg(admin, { name: "UC Org A", orgType: "corporate" })).json();
    const orgB = (await createOrg(admin, { name: "UC Org B", orgType: "corporate" })).json();

    const memberRes = await app.inject({
      method: "POST", url: `${V1}/orgs/${orgA.id}/users`, headers: auth(admin),
      payload: { email: `ucadmin.${orgA.id}@x.io`, password: "secret1", role: "OrgAdmin" },
    });
    expect(memberRes.statusCode).toBe(201);
    const orgAdmin = await loginAs(app, `ucadmin.${orgA.id}@x.io`, "secret1");

    const stamp = Date.now();
    const keyA = `uc-org-a-${stamp}`;
    const keyB = `uc-org-b-${stamp}`;
    const base = {
      tokenStandard: "ERC-20", symbol: "UCS", allowedChainIds: ["fabric"], defaultChainId: "fabric",
      metadataSchema: { type: "object", properties: {} },
      lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
      compliance: { allowlist: false, transferRestrictions: false },
      roles: ["UseCaseAdmin", "Issuer"],
    };
    const createdA = await app.inject({
      method: "POST", url: `${V1}/use-cases`, headers: auth(admin),
      payload: { ...base, key: keyA, name: "UC Org A Case", ownerOrgId: orgA.id },
    });
    expect(createdA.statusCode).toBe(201);
    const createdB = await app.inject({
      method: "POST", url: `${V1}/use-cases`, headers: auth(admin),
      payload: { ...base, key: keyB, name: "UC Org B Case", ownerOrgId: orgB.id },
    });
    expect(createdB.statusCode).toBe(201);

    const scoped = await app.inject({ method: "GET", url: `${V1}/use-cases`, headers: auth(orgAdmin) });
    expect(scoped.statusCode).toBe(200);
    const scopedList = scoped.json() as Array<{ key: string; ownerOrgId?: string | null }>;
    const scopedKeys = scopedList.map((u) => u.key);
    expect(scopedKeys).toContain(keyA);
    expect(scopedKeys).not.toContain(keyB);
    // Legacy/seeded use cases have a null ownerOrgId and must not leak into an org-scoped view.
    expect(scopedList.every((u) => u.ownerOrgId === orgA.id)).toBe(true);

    const all = await app.inject({ method: "GET", url: `${V1}/use-cases`, headers: auth(admin) });
    expect(all.statusCode).toBe(200);
    const allKeys = (all.json() as Array<{ key: string }>).map((u) => u.key);
    expect(allKeys).toContain(keyA);
    expect(allKeys).toContain(keyB);
  });
});

describe("back-compat", () => {
  it("a user created with no org gets no DID (legacy POST /users still works)", async () => {
    const uca = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const res = await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(uca), payload: { email: `legacy.${Date.now()}@x.io`, password: "secret1", role: "Issuer" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().did ?? null).toBeNull();
  });
});
