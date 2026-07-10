import { describe, it, expect } from "vitest";
import { generateDidKey, issueCredential, presentCredential } from "@tokenlayer/core";
import { buildTestApp, V1, loginAs, auth } from "./helpers.js";

// A deterministic trusted issuer shared by the test app + the test's credentials.
const issuer = generateDidKey();

async function appWithIssuer() {
  return buildTestApp({ trustedKycIssuers: [issuer.did] });
}
async function pendingInvestor(app: import("fastify").FastifyInstance) {
  const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
  const created = await app.inject({ method: "POST", url: `${V1}/users`, headers: auth(admin), payload: { email: `inv.${Math.random().toString(36).slice(2)}@x.dev`, password: "secret1", role: "Buyer" } });
  return { admin, userId: created.json().id as string };
}

describe("identity verification", () => {
  it("verifies a valid VP → approves KYC + sets country + did", async () => {
    const app = await appWithIssuer();
    const { admin, userId } = await pendingInvestor(app);
    const holder = generateDidKey();
    const ch = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/challenge`, headers: auth(admin) });
    expect(ch.statusCode).toBe(200);
    const challenge = ch.json().challenge as string;
    const now = Math.floor(Date.now() / 1000);
    const vc = issueCredential({ issuerDid: issuer.did, issuerKey: issuer.privateKey, subjectDid: holder.did, claims: { country: "IN", legalName: "Asha Rao" }, expiresAt: now + 3600, now });
    const vp = presentCredential({ holderDid: holder.did, holderKey: holder.privateKey, vcJwt: vc, challenge, now });
    const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/verify`, headers: auth(admin), payload: { presentation: vp } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "approved", did: holder.did, claims: { country: "IN" } });
    const users = await app.inject({ method: "GET", url: `${V1}/users`, headers: auth(admin) });
    const u = users.json().find((x: { id: string }) => x.id === userId);
    expect(u.kycStatus).toBe("approved");
    expect(u.kyc.country).toBe("IN");
  });

  it("rejects an untrusted issuer with UNTRUSTED_ISSUER (no KYC change)", async () => {
    const app = await buildTestApp({ trustedKycIssuers: [] }); // nothing trusted
    const { admin, userId } = await pendingInvestor(app);
    const holder = generateDidKey();
    const challenge = (await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/challenge`, headers: auth(admin) })).json().challenge;
    const now = Math.floor(Date.now() / 1000);
    const vc = issueCredential({ issuerDid: issuer.did, issuerKey: issuer.privateKey, subjectDid: holder.did, claims: { country: "IN" }, expiresAt: now + 3600, now });
    const vp = presentCredential({ holderDid: holder.did, holderKey: holder.privateKey, vcJwt: vc, challenge, now });
    const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/verify`, headers: auth(admin), payload: { presentation: vp } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNTRUSTED_ISSUER");
  });

  it("rejects a replayed / unknown challenge", async () => {
    const app = await appWithIssuer();
    const { admin, userId } = await pendingInvestor(app);
    const holder = generateDidKey();
    const now = Math.floor(Date.now() / 1000);
    const vc = issueCredential({ issuerDid: issuer.did, issuerKey: issuer.privateKey, subjectDid: holder.did, claims: { country: "IN" }, expiresAt: now + 3600, now });
    const vp = presentCredential({ holderDid: holder.did, holderKey: holder.privateKey, vcJwt: vc, challenge: "never-issued", now });
    const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/verify`, headers: auth(admin), payload: { presentation: vp } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CHALLENGE_EXPIRED");
  });

  it("tenancy: an admin cannot verify a user outside their use case", async () => {
    const app = await appWithIssuer();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const { userId } = await pendingInvestor(app); // created under invoice-tokenization (m1.admin)
    const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/challenge`, headers: auth(carbon) });
    expect(res.statusCode).toBe(403);
  });
});
