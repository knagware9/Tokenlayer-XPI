import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, onboardUser, PLATFORM_ADMIN_2, V1 } from "./helpers.js";

describe("KYC decision notification", () => {
  it("PATCH /users/:id with kycStatus emails the affected user", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    const email = `kyc-${Date.now()}@x.com`;
    const created = await onboardUser(h.app, platform, checker, { email, password: "whatever-123", role: "Buyer", useCaseKey: "carbon-credit" });
    h.mail.sent.length = 0; // ignore the welcome + proposal-notify emails onboarding just sent
    const res = await h.app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: auth(platform), payload: { kycStatus: "approved" } });
    expect(res.statusCode).toBe(200);
    const sent = h.mail.sent.find((m) => m.to === email);
    expect(sent).toBeDefined();
    expect(sent!.subject).toMatch(/approved/i);
  });

  it("PATCH /users/:id without a kycStatus field sends no KYC email", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    const email = `no-kyc-${Date.now()}@x.com`;
    const created = await onboardUser(h.app, platform, checker, { email, password: "whatever-123", role: "Buyer", useCaseKey: "carbon-credit" });
    h.mail.sent.length = 0;
    await h.app.inject({ method: "PATCH", url: `${V1}/users/${created.id}`, headers: auth(platform), payload: { active: false } });
    expect(h.mail.sent).toHaveLength(0);
  });
});
