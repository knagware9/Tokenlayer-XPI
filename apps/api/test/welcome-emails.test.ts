import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { auth, buildTestAppWithRepos, loginAs, onboardUser, PLATFORM_ADMIN_2, V1 } from "./helpers.js";

describe("welcome emails", () => {
  it("POST /orgs with an admin block emails the real password", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/orgs`, headers: auth(platform),
      payload: { name: `Welcome Org ${Date.now()}`, orgType: "corporate", admin: { name: "A Admin", email: `welcome-${Date.now()}@x.com`, password: "the-real-password-1" } },
    });
    expect(res.statusCode).toBe(201);
    const sent = h.mail.sent.find((m) => m.text.includes("the-real-password-1"));
    expect(sent).toBeDefined();
  });

  it("gated onboard-user (POST /users, approved) emails a set-password link, never the password", async () => {
    const h = await buildTestAppWithRepos();
    const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    const email = `gated-${Date.now()}@x.com`;
    await onboardUser(h.app, maker, checker, { email, password: "never-sent-anywhere", role: "Buyer", useCaseKey: "carbon-credit" });
    const sent = h.mail.sent.find((m) => m.to === email);
    expect(sent).toBeDefined();
    expect(sent!.text).not.toContain("never-sent-anywhere");
    expect(sent!.text).toMatch(/reset-password\?token=/);
  });
});
