import { describe, expect, it } from "vitest";
import { buildTestAppWithRepos, V1 } from "./helpers.js";

describe("password reset", () => {
  it("forgot-password always returns 202, and emails a reset link for a real user", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } });
    expect(res.statusCode).toBe(202);
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0]!.to).toBe("admin@tokenlayer.dev");
    expect(h.mail.sent[0]!.text).toMatch(/reset-password\?token=/);
  });

  it("forgot-password returns 202 and sends nothing for an unknown email (no enumeration)", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "nobody@nowhere.test" } });
    expect(res.statusCode).toBe(202);
    expect(h.mail.sent).toHaveLength(0);
  });

  it("reset-password with the emailed token sets the new password and logs in with it", async () => {
    const h = await buildTestAppWithRepos();
    await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } });
    const link = h.mail.sent[0]!.text.match(/token=(\S+)/)![1]!;
    const reset = await h.app.inject({ method: "POST", url: `${V1}/auth/reset-password`, payload: { token: link, newPassword: "brand-new-pw-123" } });
    expect(reset.statusCode).toBe(200);
    const login = await h.app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "admin@tokenlayer.dev", password: "brand-new-pw-123" } });
    expect(login.statusCode).toBe(200);
  });

  it("reset-password rejects an unknown token", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/reset-password`, payload: { token: "not-a-real-token-aaaaaaaaaaaaaaaaaaaaaaaa", newPassword: "whatever123" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_TOKEN");
  });

  it("reset-password rejects a token that was already used", async () => {
    const h = await buildTestAppWithRepos();
    await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } });
    const link = h.mail.sent[0]!.text.match(/token=(\S+)/)![1]!;
    await h.app.inject({ method: "POST", url: `${V1}/auth/reset-password`, payload: { token: link, newPassword: "first-reset-123" } });
    const second = await h.app.inject({ method: "POST", url: `${V1}/auth/reset-password`, payload: { token: link, newPassword: "second-reset-456" } });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe("INVALID_TOKEN");
  });

  it("a fresh forgot-password request invalidates the previous token", async () => {
    const h = await buildTestAppWithRepos();
    await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } });
    const firstLink = h.mail.sent[0]!.text.match(/token=(\S+)/)![1]!;
    await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } });
    const reset = await h.app.inject({ method: "POST", url: `${V1}/auth/reset-password`, payload: { token: firstLink, newPassword: "whatever-123" } });
    expect(reset.statusCode).toBe(400);
  });
});
