import { describe, expect, it } from "vitest";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";
import { buildTestApp, loginAs, V1, auth } from "./helpers.js";

/** Mint a genuine OrgAdmin login inside a fresh org (seeded desk operators are
 *  NOT OrgAdmins, so the use-case-aware verifier gate needs a real one). */
async function mintOrgAdmin(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, orgName: string): Promise<{ token: string; orgId: string }> {
  const org = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: orgName, orgType: "corporate" } })).json();
  const email = `orgadmin.${org.id}@x.io`;
  const mk = await app.inject({ method: "POST", url: `${V1}/orgs/${org.id}/users`, headers: auth(admin), payload: { email, password: "secret1", role: "OrgAdmin" } });
  expect(mk.statusCode).toBe(201);
  const token = await loginAs(app, email, "secret1");
  return { token, orgId: org.id };
}

// Seed a use case whose verifier binding is restricted to a specific org, then
// confirm an allowed verifier can create a request and a disallowed one cannot.
describe("use-case-aware verification requests", () => {
  it("gates the requesting org by the verifier binding", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    // Discover a real org id to bind as verifier (the platform issuer org is
    // seeded with orgType "verifier" in every test app).
    const orgs = await app.inject({ method: "GET", url: `${V1}/orgs`, headers: auth(admin) });
    const verifierOrg = (orgs.json() as { id: string; orgType: string }[]).find((o) => o.orgType === "verifier");
    expect(verifierOrg).toBeTruthy();
    const DEF = {
      key: "vc-bound", name: "Bound",
      credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
      issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" },
      verifier: { kind: "orgs", orgIds: [verifierOrg!.id] },
    };
    expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF })).statusCode).toBe(201);

    // A genuine OrgAdmin whose org is NOT on the verifier list is rejected.
    const outsider = await mintOrgAdmin(app, admin, "Outsider Org");
    const denied = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(outsider.token),
      payload: { holderDid: "did:key:zHolder", requestedTypes: ["KycCredential"], purpose: "check", credentialUseCaseKey: "vc-bound" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("VERIFIER_NOT_PERMITTED");
  });

  it("rejects requested types not in the use case", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const DEF = {
      key: "vc-any", name: "Any",
      credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
      issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    };
    expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF })).statusCode).toBe(201);
    // With verifier:any, any genuine OrgAdmin may request; but a type outside the use case is rejected.
    const someOrgAdmin = await mintOrgAdmin(app, admin, "Any Verifier Org");
    const res = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(someOrgAdmin.token),
      payload: { holderDid: "did:key:zHolder", requestedTypes: ["NotAType"], purpose: "check", credentialUseCaseKey: "vc-any" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("TYPES_NOT_IN_USECASE");
  });
});

// Full runtime: a use-case-scoped credential is issued to a holder, a bound
// verifier requests it, the holder consents, and verify() returns valid:true —
// then a revoke flips it to valid:false. A fake on-chain registry is used (as
// in verification.test.ts) so issuer-trust resolves on-chain instead of via
// the static trustedKycIssuers allowlist.
describe("full runtime: issue (use case) -> request -> consent -> verify -> revoke", () => {
  it("verifies a use-case-scoped credential end to end, then invalidates it on revoke", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");

    const DEF = {
      key: "vc-full", name: "Full Runtime",
      credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["legalName", "country"], properties: { legalName: { type: "string" }, country: { type: "string", pattern: "^[A-Z]{2}$" } } } }],
      issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    };
    expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF })).statusCode).toBe(201);

    // A holder org + member with a real DID (POST /orgs/:id/users mints one directly).
    const holderOrg = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: "Full Runtime Holder Co", orgType: "corporate" } })).json();
    const holderMk = await app.inject({ method: "POST", url: `${V1}/orgs/${holderOrg.id}/users`, headers: auth(admin), payload: { email: "full.holder@x.io", password: "secret1", role: "Issuer" } });
    expect(holderMk.statusCode).toBe(201);
    const holder = holderMk.json() as { id: string; did: string };
    const holderToken = await loginAs(app, "full.holder@x.io", "secret1");

    // Issue the use-case KycCredential to the holder (platform-bound issuer, admin issues).
    const issued = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/vc-full/credentials`, headers: auth(admin),
      payload: { credentialType: "KycCredential", subjectUserId: holder.id, claims: { legalName: "Ada Lovelace", country: "IN" } } });
    expect(issued.statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: `${V1}/proposals/${issued.json().proposal.id}/approve`, headers: auth(admin2), payload: {} })).statusCode).toBe(200);
    const held = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holderToken) });
    const credentialId = (held.json() as { id: string; type: string[] }[]).find((c) => c.type.includes("KycCredential"))!.id;

    // A verifier org (verifier:any admits any genuine OrgAdmin) requests the use-case type.
    const verifierOrg = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: "Full Runtime Verifier Co", orgType: "corporate" } })).json();
    const vMk = await app.inject({ method: "POST", url: `${V1}/orgs/${verifierOrg.id}/users`, headers: auth(admin), payload: { email: "full.verifier@x.io", password: "secret1", role: "OrgAdmin" } });
    expect(vMk.statusCode).toBe(201);
    const verifierToken = await loginAs(app, "full.verifier@x.io", "secret1");

    const created = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(verifierToken),
      payload: { holderDid: holder.did, requestedTypes: ["KycCredential"], purpose: "onboarding", credentialUseCaseKey: "vc-full" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().credentialUseCaseKey).toBe("vc-full");
    const requestId = created.json().id as string;

    // Holder consents.
    const consented = await app.inject({ method: "POST", url: `${V1}/verification-requests/${requestId}/consent`, headers: auth(holderToken), payload: { credentialIds: [credentialId] } });
    expect(consented.statusCode).toBe(200);

    // Verify — valid.
    const before = await app.inject({ method: "GET", url: `${V1}/verification-requests/${requestId}/verify`, headers: auth(verifierToken) });
    expect(before.statusCode).toBe(200);
    expect(before.json().valid).toBe(true);

    // Revoke via the issuing (platform) org — PlatformAdmin proposes, a second PlatformAdmin approves.
    const rReq = await app.inject({ method: "POST", url: `${V1}/credentials/${credentialId}/revoke`, headers: auth(admin), payload: { reason: "test revoke" } });
    expect(rReq.statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: `${V1}/proposals/${rReq.json().proposal.id}/approve`, headers: auth(admin2), payload: {} })).statusCode).toBe(200);

    // Re-verify the same request — now invalid.
    const after = await app.inject({ method: "GET", url: `${V1}/verification-requests/${requestId}/verify`, headers: auth(verifierToken) });
    expect(after.json().valid).toBe(false);
  });
});
