import { describe, expect, it } from "vitest";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

describe("GET /config", () => {
  it("returns the enabled domains (default: both)", async () => {
    const app = await buildTestApp();
    const token = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}/config`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json().domains).toEqual(["tokenization", "identity"]);
  });
  it("requires auth", async () => {
    const app = await buildTestApp();
    expect((await app.inject({ method: "GET", url: `${V1}/config` })).statusCode).toBe(401);
  });
  it("reflects a single-domain deployment", async () => {
    const app = await buildTestApp({ enabledDomains: ["identity"] });
    const token = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}/config`, headers: auth(token) });
    expect(res.json().domains).toEqual(["identity"]);
  });
});
