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

  // Regression for the double-email bug: provisionDeskUser (identity.ts) creates
  // an "onboard-user" proposal and auto-approves it in-process via
  // onboardUserKind.execute (onboardSingle) in the SAME request, then sends its
  // own welcomeCredentialsEmail. Before the fix, onboardSingle unconditionally
  // sent its own welcomeSetPasswordEmail too — every desk user got BOTH a
  // "here is your password" email and a contradictory "no password yet, click
  // this link" email. skipWelcomeEmail on the proposal payload (set only by
  // provisionDeskUser) suppresses onboardSingle's send for this path.
  it("provisionDeskUser (POST /credential-use-cases/provision, createDeskUsers) sends exactly ONE email per desk user — the real-password variant, never a set-password link", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const domain = `desk-${Date.now()}.edu`;
    const res = await h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/provision`, headers: auth(admin),
      payload: {
        templateKey: "education-certificate",
        params: { issuerOrgName: `Desk University ${Date.now()}`, jurisdiction: "IN" },
        provisioning: { issuerOrgType: "government", createDeskUsers: true, deskEmailDomain: domain },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { deskUsers: Array<{ email: string; password: string; role: string }> };
    expect(body.deskUsers).toHaveLength(3);

    for (const du of body.deskUsers) {
      const toThisUser = h.mail.sent.filter((m) => m.to === du.email);
      expect(toThisUser).toHaveLength(1); // not two — the double-send bug
      expect(toThisUser[0]!.text).toContain(du.password); // welcomeCredentialsEmail, the real password
      expect(toThisUser[0]!.text).not.toMatch(/reset-password\?token=/); // never welcomeSetPasswordEmail
    }
  });
});
