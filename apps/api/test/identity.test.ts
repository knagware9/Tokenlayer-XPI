import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { didKeyFromSeed, generateDidKey, issueCredential, presentCredential } from "@tokenlayer/core";
import { buildTestApp, V1, loginAs, auth, onboardUser } from "./helpers.js";

// A deterministic trusted issuer shared by the test app + the test's credentials.
const issuer = generateDidKey();

// Mirrors the route's devKeyFromSeed: sha256(seed) → Ed25519 did:key.
const DEV_SEED = "dev-issuer-seed";
const devIssuerDid = didKeyFromSeed(createHash("sha256").update(DEV_SEED).digest()).did;

async function appWithIssuer() {
  return buildTestApp({ trustedKycIssuers: [issuer.did] });
}
async function pendingInvestor(app: import("fastify").FastifyInstance) {
  const admin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
  const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
  // Gated onboarding: the invoice-desk admin proposes, the platform admin checks.
  // The Buyer lands in the desk's use case (invoice-tokenization), KYC pending.
  const created = await onboardUser(app, admin, platform, { email: `inv.${Math.random().toString(36).slice(2)}@x.dev`, password: "secret1", role: "Buyer" });
  return { admin, userId: created.id };
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

  // ADVERSARIAL: scope must also gate /verify itself, not only /challenge.
  it("tenancy: /verify is 403 for a cross-tenant admin (no KYC touched)", async () => {
    const app = await appWithIssuer();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const { admin, userId } = await pendingInvestor(app); // invoice-tokenization tenant
    const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/verify`, headers: auth(carbon), payload: { presentation: "anything" } });
    expect(res.statusCode).toBe(403);
    // KYC unchanged (still pending) — proven via the owning admin's view.
    const users = await app.inject({ method: "GET", url: `${V1}/users`, headers: auth(admin) });
    expect(users.json().find((x: { id: string }) => x.id === userId).kycStatus).not.toBe("approved");
  });

  // ADVERSARIAL: malformed (non-JWT) presentation must fail closed as a coded
  // 400, never an uncaught 500. Nonce-parse + verifyPresentation both fail-safe.
  it("malformed presentation → coded 400, never 500", async () => {
    const app = await appWithIssuer();
    const { admin, userId } = await pendingInvestor(app);
    // A real, issued challenge exists — so we exercise the parse path, not just an absent challenge.
    await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/challenge`, headers: auth(admin) });
    for (const presentation of ["not-a-jwt", "", "a.b.c", "%%%.%%%.%%%"]) {
      const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/verify`, headers: auth(admin), payload: { presentation } });
      expect(res.statusCode).toBe(400);
      expect(res.statusCode).not.toBe(500);
      expect(typeof res.json().error).toBe("string");
    }
  });

  // ADVERSARIAL: extra body fields must NOT poison stored KYC — country comes
  // from the credential, and the route reads only `presentation`.
  it("client-supplied body fields cannot poison KYC (country from credential)", async () => {
    const app = await appWithIssuer();
    const { admin, userId } = await pendingInvestor(app);
    const holder = generateDidKey();
    const challenge = (await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/challenge`, headers: auth(admin) })).json().challenge;
    const now = Math.floor(Date.now() / 1000);
    const vc = issueCredential({ issuerDid: issuer.did, issuerKey: issuer.privateKey, subjectDid: holder.did, claims: { country: "IN" }, expiresAt: now + 3600, now });
    const vp = presentCredential({ holderDid: holder.did, holderKey: holder.privateKey, vcJwt: vc, challenge, now });
    const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/verify`, headers: auth(admin), payload: { presentation: vp, country: "US", kycStatus: "revoked", kyc: { country: "US" } } });
    expect(res.statusCode).toBe(200);
    const users = await app.inject({ method: "GET", url: `${V1}/users`, headers: auth(admin) });
    const u = users.json().find((x: { id: string }) => x.id === userId);
    expect(u.kycStatus).toBe("approved"); // NOT the injected "revoked"
    expect(u.kyc.country).toBe("IN");      // NOT the injected "US"
  });

  // The dev-seed is the explicit switch: present WITH a seed even under NODE_ENV=production
  // (demo stacks run production); a real deployment simply never sets DEV_KYC_ISSUER_SEED.
  it("dev mint → available when a seed is configured, regardless of isProduction", async () => {
    const app = await buildTestApp({ trustedKycIssuers: [devIssuerDid], devIssuerSeed: DEV_SEED, isProduction: true });
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "POST", url: `${V1}/identity/mint`, headers: auth(admin), payload: { claims: { country: "SG" }, challenge: "c" } });
    expect(res.statusCode).toBe(200);
  });

  // ADVERSARIAL: dev mint 404 when no dev issuer seed configured (fail closed — the real prod contract).
  it("dev mint → 404 when no dev issuer seed configured", async () => {
    const app = await buildTestApp({ trustedKycIssuers: [devIssuerDid] }); // devIssuerSeed absent
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "POST", url: `${V1}/identity/mint`, headers: auth(admin), payload: { claims: { country: "SG" }, challenge: "c" } });
    expect(res.statusCode).toBe(404);
  });

  // Dev mint is usable by any desk operator (user-manager) but not by a non-manager role.
  it("dev mint → 200 for a use-case admin (desk operator), 403 for a non-manager", async () => {
    const app = await buildTestApp({ trustedKycIssuers: [devIssuerDid], devIssuerSeed: DEV_SEED });
    const deskAdmin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123"); // UseCaseAdmin
    const okRes = await app.inject({ method: "POST", url: `${V1}/identity/mint`, headers: auth(deskAdmin), payload: { claims: { country: "SG" }, challenge: "c" } });
    expect(okRes.statusCode).toBe(200);
    const issuer = await loginAs(app, "m1.issuer@tokenlayer.dev", "m1issuer123"); // cannot manage users
    const forbidden = await app.inject({ method: "POST", url: `${V1}/identity/mint`, headers: auth(issuer), payload: { claims: { country: "SG" }, challenge: "c" } });
    expect(forbidden.statusCode).toBe(403);
  });

  // Positive path for the dev mint → verify round-trip (dev/demo enablement).
  // Platform admin mints (the only role allowed); the tenant admin drives the
  // user's challenge + verify.
  it("dev mint → verify round-trip approves KYC from the minted credential", async () => {
    const app = await buildTestApp({ trustedKycIssuers: [devIssuerDid], devIssuerSeed: DEV_SEED });
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const { admin, userId } = await pendingInvestor(app);
    const challenge = (await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/challenge`, headers: auth(admin) })).json().challenge;
    const mint = await app.inject({ method: "POST", url: `${V1}/identity/mint`, headers: auth(platform), payload: { claims: { country: "SG", legalName: "Dev User" }, challenge } });
    expect(mint.statusCode).toBe(200);
    const res = await app.inject({ method: "POST", url: `${V1}/users/${userId}/identity/verify`, headers: auth(admin), payload: { presentation: mint.json().presentation } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "approved", claims: { country: "SG" } });
  });
});
