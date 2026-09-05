import { describe, expect, it } from "vitest";
import { buildTestAppWithRepos, V1 } from "./helpers.js";
import type { Mailer } from "../src/mail/mailer.js";

describe("password reset", () => {
  it("forgot-password always returns 202, and emails a reset link for a real user", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } });
    expect(res.statusCode).toBe(202);
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0]!.to).toBe("admin@tokenlayer.dev");
    expect(h.mail.sent[0]!.text).toMatch(/reset-password\?token=/);
  });

  it("forgot-password does not await the mail send before responding (anti-enumeration timing)", async () => {
    // The whole point of the uniform-202 response is that a real account and a
    // non-existent one are indistinguishable BY TIMING, not just by body. A
    // mailer whose send() never resolves proves the route isn't gated on it:
    // if `deps.mail.send(...)` were awaited (the bug this guards against), this
    // request would hang forever and the race below would time out.
    const stubMailer: Mailer = { send: () => new Promise<void>(() => {}) }; // never resolves
    const h = await buildTestAppWithRepos({ mail: stubMailer });
    const start = Date.now();
    const res = await Promise.race([
      h.app.inject({ method: "POST", url: `${V1}/auth/forgot-password`, payload: { email: "admin@tokenlayer.dev" } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("forgot-password did not respond within 3000ms — looks like it's awaiting mail.send()")), 3000)),
    ]);
    expect(res.statusCode).toBe(202);
    expect(Date.now() - start).toBeLessThan(3000);
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

  it("reset-password rejects an expired token", async () => {
    const h = await buildTestAppWithRepos();
    const user = await h.users.findByEmail("admin@tokenlayer.dev");
    const { mintResetToken } = await import("../src/mail/reset-tokens.js");
    const minted = await mintResetToken();
    await h.deps.passwordResetTokens.create({
      userId: user!.id, tokenPrefix: minted.prefix, tokenHash: minted.hash,
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    });
    const res = await h.app.inject({ method: "POST", url: `${V1}/auth/reset-password`, payload: { token: minted.token, newPassword: "whatever-12345" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_TOKEN");
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
