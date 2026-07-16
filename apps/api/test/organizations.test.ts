import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicKeyFromDidKey } from "@tokenlayer/core";
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
