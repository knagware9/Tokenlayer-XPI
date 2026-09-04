import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, onboardUser, PLATFORM_ADMIN_2, V1 } from "./helpers.js";

describe("credential issue/revoke notification", () => {
  it("issuing a credential to a user (via onboarding's auto-KYC) emails the holder", async () => {
    const h = await buildTestAppWithRepos();
    const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    const email = `cred-${Date.now()}@x.com`;
    // onboardUser's `body.kyc` (already part of its signature — see helpers.ts)
    // triggers issueCredentialFor for a KycCredential inside onboardSingle.
    await onboardUser(h.app, maker, checker, {
      email, password: "whatever-123", role: "Buyer", useCaseKey: "carbon-credit",
      kyc: { legalName: "Cred Holder", country: "IN" },
    });
    const sent = h.mail.sent.find((m) => m.to === email && /credential/i.test(m.subject));
    expect(sent).toBeDefined();
  });
});
