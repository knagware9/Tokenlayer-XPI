import { describe, it, expect } from "vitest";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

describe("documents", () => {
  it("uploads a document (base64) and serves it back with content-type + sha", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const dataBase64 = Buffer.from("hello invoice").toString("base64");
    const up = await app.inject({ method: "POST", url: `${V1}/documents`, headers: auth(admin), payload: { contentType: "text/plain", dataBase64 } });
    expect(up.statusCode).toBe(201);
    const { id, url, sha256 } = up.json();
    expect(url).toBe(`/api/v1/documents/${id}`);
    expect(sha256).toMatch(/^0x[0-9a-f]{64}$/);
    const get = await app.inject({ method: "GET", url: `${V1}/documents/${id}`, headers: auth(admin) });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toContain("text/plain");
    expect(get.body).toBe("hello invoice");
  });

  it("404 for an unknown document", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    expect((await app.inject({ method: "GET", url: `${V1}/documents/nope`, headers: auth(admin) })).statusCode).toBe(404);
  });
});
