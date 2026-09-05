import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, V1 } from "./helpers.js";

describe("kycStatus on the session (login + /me)", () => {
  it("POST /auth/login includes the caller's kycStatus", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "carbon.buyer@tokenlayer.dev", password: "carbon123" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.kycStatus).toBeTruthy();
  });

  it("GET /me includes the caller's CURRENT kycStatus, refreshed from the DB (not the stale JWT)", async () => {
    const h = await buildTestAppWithRepos();
    const token = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    const before = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(token) });
    expect(before.json().kycStatus).toBe(user!.kycStatus);
    // Change kycStatus directly (simulating a decision made mid-session) —
    // /me must reflect it without a fresh login, proving it re-reads the DB.
    await h.users.update(user!.id, { kycStatus: "approved" });
    const after = await h.app.inject({ method: "GET", url: `${V1}/me`, headers: auth(token) });
    expect(after.json().kycStatus).toBe("approved");
  });
});
