import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, onboardUser, PLATFORM_ADMIN_2, V1 } from "./helpers.js";

/**
 * resolveIssuerOrg (apps/api/src/shared/user-kinds.ts) picks which org signs
 * a KycCredential at onboarding time. It used to only ever consult the
 * TOKENIZATION use-case table (`deps.useCases`) — an identity-domain key like
 * a provisioned credential use case's was never found there, so onboarding
 * under one silently fell back to signing as the Platform org instead of the
 * use case's actual bound issuer. This is the root cause behind
 * personas-e2e.mjs's "onboard a Holder under the education-certificate
 * programme" step failing deep inside proposal execution.
 */
describe("resolveIssuerOrg — identity-domain onboarding", () => {
  it("a Holder onboarded with kyc under a provisioned credential use case is signed by that use case's bound issuer org, not the Platform org", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);

    const prov = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/provision`, headers: auth(admin),
      payload: {
        templateKey: "education-certificate",
        params: { issuerOrgName: "University Registrar (Test)", jurisdiction: "IN" },
        provisioning: { issuerOrgType: "government", createDeskUsers: false },
      },
    });
    expect(prov.statusCode).toBe(201);
    const { org, useCase } = prov.json() as { org: { id: string; did: string; name: string }; useCase: { key: string } };

    const user = await onboardUser(app, admin, admin2, {
      email: "issuer-org-holder@x.dev", password: "secret1", role: "Holder",
      useCaseKey: useCase.key, kyc: { legalName: "Test Holder", country: "IN" },
    });

    expect(user.kycStatus).toBe("approved");
    expect(user.kyc?.issuerDid).toBe(org.did);
  });
});
