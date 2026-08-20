import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { auth, buildTestApp, issueAsset, loginAs, onboardUser, PLATFORM_ADMIN_2, V1 } from "./helpers.js";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";
import { PLATFORM_ORG_NAME } from "../src/shared/platform-org.js";

describe("platform issuer org", () => {
  it("is seeded at boot: verifier type, verified, has a did:key", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "GET", url: `${V1}/orgs`, headers: { authorization: `Bearer ${platform}` } });
    const org = (res.json() as Array<{ name: string; orgType: string; verified: boolean; did: string }>).find((o) => o.name === PLATFORM_ORG_NAME);
    expect(org).toBeDefined();
    expect(org!.orgType).toBe("verifier");
    expect(org!.verified).toBe(true);
    expect(org!.did.startsWith("did:key:z")).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Gated onboarding behavioural suite (Task 6). POST /users by a non-org
// user-manager parks an `onboard-user` proposal; a second manager approves →
// user + custodial DID + (KYC ⇒) anchored KycCredential. Revocation is gated
// and chain-first.
// --------------------------------------------------------------------------

interface Cred { id: string; type: string[]; issuerDid: string; holderDid: string; claims: Record<string, unknown>; revoked: boolean }
interface Proposal { id: string; kind: string; status: string; error: string | null }

/** POST /users as `maker`; returns the raw inject response (202 + proposal). */
const propose = (app: FastifyInstance, maker: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `${V1}/users`, headers: auth(maker), payload: body });
const approve = (app: FastifyInstance, checker: string, id: string) =>
  app.inject({ method: "POST", url: `${V1}/proposals/${id}/approve`, headers: auth(checker), payload: {} });
const listUsers = async (app: FastifyInstance, mgr: string) =>
  (await app.inject({ method: "GET", url: `${V1}/users`, headers: auth(mgr) })).json() as Array<{ id: string; email: string; kycStatus: string; kyc: Record<string, unknown> | null }>;
const myCredentials = async (app: FastifyInstance, token: string) =>
  (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(token) })).json() as Cred[];

describe("gated onboarding — happy path", () => {
  it("proposes → approves → KYC-approved user with a DID + one KycCredential", async () => {
    const app = await buildTestApp();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const res = await propose(app, carbon, {
      email: "asha.buyer@x.dev", password: "secret1", role: "Buyer",
      walletAddress: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", kyc: { legalName: "Asha", country: "IN" },
    });
    expect(res.statusCode).toBe(202);
    const proposal = res.json().proposal as Proposal;
    expect(proposal.kind).toBe("onboard-user");

    const ap = await approve(app, admin, proposal.id);
    expect(ap.statusCode).toBe(200);
    expect((ap.json().proposal as Proposal).status).toBe("executed");

    const user = (await listUsers(app, admin)).find((u) => u.email === "asha.buyer@x.dev");
    expect(user).toBeDefined();
    expect(user!.kycStatus).toBe("approved");
    expect(typeof user!.kyc!.credentialId).toBe("string");

    // The user can log in — and the login exposes their custodial did:key.
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "asha.buyer@x.dev", password: "secret1" } });
    expect(login.statusCode).toBe(200);
    const did = login.json().user.did as string;
    expect(did.startsWith("did:key:z")).toBe(true);

    const creds = await myCredentials(app, login.json().token);
    expect(creds).toHaveLength(1);
    expect(creds[0].type).toContain("KycCredential");
    expect(creds[0].holderDid).toBe(did);
    expect(creds[0].claims.id).toBe(did); // subject id is the holder's did:key
    expect(creds[0].claims).toMatchObject({ legalName: "Asha", country: "IN" });
  });
});

describe("gated onboarding — segregation of duties", () => {
  it("proposer cannot self-approve; a second in-scope manager can; a foreign-use-case admin cannot see or approve it", async () => {
    const app = await buildTestApp();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const gold = await loginAs(app, "gold.admin@tokenlayer.dev", "gold123");

    const res = await propose(app, carbon, { email: "sod.buyer@x.dev", password: "secret1", role: "Buyer", kyc: { legalName: "Sod", country: "IN" } });
    expect(res.statusCode).toBe(202);
    const id = (res.json().proposal as Proposal).id;

    // Proposer approving their own proposal → 403 SELF_APPROVAL, nothing executed.
    const self = await approve(app, carbon, id);
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe("SELF_APPROVAL");

    // A DIFFERENT use case's admin cannot even see it (scoped list) and gets 404 on approve.
    const goldList = (await app.inject({ method: "GET", url: `${V1}/proposals?status=pending`, headers: auth(gold) })).json() as Proposal[];
    expect(goldList.some((p) => p.id === id)).toBe(false);
    const goldApprove = await approve(app, gold, id);
    expect(goldApprove.statusCode).toBe(404);

    // The PlatformAdmin (in scope, not the proposer) can approve.
    const ok = await approve(app, admin, id);
    expect(ok.statusCode).toBe(200);
    expect((ok.json().proposal as Proposal).status).toBe("executed");
  });
});

describe("gated onboarding — reject", () => {
  it("rejecting the proposal creates no user and login fails", async () => {
    const app = await buildTestApp();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const res = await propose(app, carbon, { email: "rejected.buyer@x.dev", password: "secret1", role: "Buyer", kyc: { legalName: "Rej", country: "IN" } });
    const id = (res.json().proposal as Proposal).id;
    const rej = await app.inject({ method: "POST", url: `${V1}/proposals/${id}/reject`, headers: auth(admin), payload: {} });
    expect(rej.statusCode).toBe(200);
    expect((rej.json().proposal as Proposal).status).toBe("rejected");

    expect((await listUsers(app, admin)).some((u) => u.email === "rejected.buyer@x.dev")).toBe(false);
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "rejected.buyer@x.dev", password: "secret1" } });
    expect(login.statusCode).toBe(401);
  });
});

describe("gated onboarding — duplicate email", () => {
  it("rejects a proposal for an already-existing email at propose time", async () => {
    const app = await buildTestApp();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    // carbon.admin@tokenlayer.dev is already seeded.
    const res = await propose(app, carbon, { email: "carbon.admin@tokenlayer.dev", password: "secret1", role: "Buyer", kyc: { legalName: "Dup", country: "IN" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("EMAIL_TAKEN");
  });

  it("race: two proposals for the same NEW email → first executes, second fails EMAIL_TAKEN; exactly one user", async () => {
    const app = await buildTestApp();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const body = { email: "race.buyer@x.dev", password: "secret1", role: "Buyer", kyc: { legalName: "Race", country: "IN" } };

    // Both proposals are created BEFORE either executes (email not yet taken).
    const a = await propose(app, carbon, body);
    const b = await propose(app, carbon, body);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);

    const okA = await approve(app, admin, (a.json().proposal as Proposal).id);
    expect((okA.json().proposal as Proposal).status).toBe("executed");

    const okB = await approve(app, admin, (b.json().proposal as Proposal).id);
    const pB = okB.json().proposal as Proposal;
    expect(pB.status).toBe("failed");
    expect(pB.error).toContain("EMAIL_TAKEN");

    expect((await listUsers(app, admin)).filter((u) => u.email === "race.buyer@x.dev")).toHaveLength(1);
  });
});

describe("gated onboarding — no KYC", () => {
  it("onboards a pending user with a DID and no credential when the kyc block is omitted", async () => {
    const app = await buildTestApp();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const res = await propose(app, carbon, { email: "nokyc.buyer@x.dev", password: "secret1", role: "Buyer" });
    expect(res.statusCode).toBe(202);
    const ok = await approve(app, admin, (res.json().proposal as Proposal).id);
    expect((ok.json().proposal as Proposal).status).toBe("executed");

    const user = (await listUsers(app, admin)).find((u) => u.email === "nokyc.buyer@x.dev");
    expect(user!.kycStatus).toBe("pending");

    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "nokyc.buyer@x.dev", password: "secret1" } });
    expect((login.json().user.did as string).startsWith("did:key:z")).toBe(true);
    expect(await myCredentials(app, login.json().token)).toHaveLength(0);
  });
});

describe("gated onboarding — wallet auto-assignment", () => {
  it("a Buyer onboarded with no walletAddress gets one auto-assigned", async () => {
    const app = await buildTestApp();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const res = await propose(app, carbon, { email: "autowallet.buyer@x.dev", password: "secret1", role: "Buyer" });
    await approve(app, admin, (res.json().proposal as Proposal).id);

    const user = (await listUsers(app, admin)).find((u) => u.email === "autowallet.buyer@x.dev") as { accountId: string | null };
    expect(user.accountId).not.toBeNull();
  });

  it("an Auditor onboarded with no walletAddress stays without one", async () => {
    const app = await buildTestApp();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const res = await propose(app, carbon, { email: "noaudit.wallet@x.dev", password: "secret1", role: "Auditor" });
    await approve(app, admin, (res.json().proposal as Proposal).id);

    const user = (await listUsers(app, admin)).find((u) => u.email === "noaudit.wallet@x.dev") as { accountId: string | null };
    expect(user.accountId).toBeNull();
  });
});

describe("gated identity revocation — chain-backed", () => {
  it("revokes the credential on-chain, flips kycStatus, keeps login, and blocks allowlisting", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const wallet = "0x976EA74026E726554dB657fA54763abd0C3a0aa9"; // unlinked seeded account

    const user = await onboardUser(app, carbon, admin, {
      email: "revoke.buyer@x.dev", password: "secret1", role: "Buyer", walletAddress: wallet, kyc: { legalName: "Rev", country: "IN" },
    });
    expect(user.kycStatus).toBe("approved");
    const credentialId = user.kyc!.credentialId as string;

    // The VC was anchored on-chain at issuance and is not revoked.
    expect((await anchor.credentialStatusOf("0xvc", credentialId)).revoked).toBe(false);

    // An asset to allowlist against — succeeds while KYC is approved.
    const assetId = await issueAsset(app, carbon, "carbon-credit");
    const allowOk = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(carbon), payload: { account: wallet } });
    expect(allowOk.statusCode).toBe(200);

    // Propose + approve the revoke (chain-first).
    const rev = await app.inject({ method: "POST", url: `${V1}/users/${user.id}/revoke-identity`, headers: auth(carbon), payload: { reason: "exit" } });
    expect(rev.statusCode).toBe(202);
    const revId = (rev.json().proposal as Proposal).id;

    // A duplicate pending revoke → 409 ALREADY_PENDING.
    const dup = await app.inject({ method: "POST", url: `${V1}/users/${user.id}/revoke-identity`, headers: auth(carbon), payload: { reason: "again" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("ALREADY_PENDING");

    const ok = await approve(app, admin, revId);
    expect((ok.json().proposal as Proposal).status).toBe("executed");

    // Revoked on-chain, and the public status endpoint reports it.
    expect((await anchor.credentialStatusOf("0xvc", credentialId)).revoked).toBe(true);
    const status = (await app.inject({ method: "GET", url: `${V1}/credentials/${credentialId}/status` })).json();
    expect(status.revoked).toBe(true);

    // kycStatus flipped, login still works, allowlisting now blocked.
    const after = (await listUsers(app, admin)).find((u) => u.email === "revoke.buyer@x.dev");
    expect(after!.kycStatus).toBe("rejected");
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "revoke.buyer@x.dev", password: "secret1" } });
    expect(login.statusCode).toBe(200);
    const allowBlocked = await app.inject({ method: "POST", url: `${V1}/assets/${assetId}/actions/allow`, headers: auth(carbon), payload: { account: wallet } });
    expect(allowBlocked.statusCode).toBe(400);
    expect(allowBlocked.json().error).toBe("KYC_NOT_APPROVED");
  });
});

describe("gated identity revocation — chain-first fail-closed", () => {
  it("an on-chain revoke failure leaves the proposal failed and the DB untouched", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const user = await onboardUser(app, carbon, admin, {
      email: "failclosed.buyer@x.dev", password: "secret1", role: "Buyer",
      walletAddress: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", kyc: { legalName: "FC", country: "IN" },
    });
    const credentialId = user.kyc!.credentialId as string;

    const rev = await app.inject({ method: "POST", url: `${V1}/users/${user.id}/revoke-identity`, headers: auth(carbon), payload: { reason: "exit" } });
    const revId = (rev.json().proposal as Proposal).id;

    // The next on-chain revoke throws → the DB flip must never happen.
    anchor.failNext = "revokeCredential";
    const ok = await approve(app, admin, revId);
    expect((ok.json().proposal as Proposal).status).toBe("failed");

    // Credential still live (chain + DB) and the user's KYC is NOT flipped.
    expect((await anchor.credentialStatusOf("0xvc", credentialId)).revoked).toBe(false);
    const status = (await app.inject({ method: "GET", url: `${V1}/credentials/${credentialId}/status` })).json();
    expect(status.revoked).toBe(false);
    const after = (await listUsers(app, admin)).find((u) => u.email === "failclosed.buyer@x.dev");
    expect(after!.kycStatus).toBe("approved");
  });
});

describe("gated onboarding — issuer resolution", () => {
  it("(b) a use case with no owner org issues the KycCredential as the platform issuer org", async () => {
    const app = await buildTestApp();
    const carbon = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const orgs = (await app.inject({ method: "GET", url: `${V1}/orgs`, headers: auth(admin) })).json() as Array<{ name: string; did: string }>;
    const platformDid = orgs.find((o) => o.name === PLATFORM_ORG_NAME)!.did;

    const user = await onboardUser(app, carbon, admin, { email: "platissuer.buyer@x.dev", password: "secret1", role: "Buyer", kyc: { legalName: "Plat", country: "IN" } });
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: user.email, password: "secret1" } });
    const creds = await myCredentials(app, login.json().token);
    expect(creds[0].issuerDid).toBe(platformDid);
  });

  it("(a) a use case owned by an org issues the KycCredential as that org", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);

    // Create an owner org (its DID is minted at creation).
    const orgRes = await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: "Issuer Bank Co", orgType: "bank" } });
    expect(orgRes.statusCode).toBe(201);
    const orgDid = orgRes.json().did as string;
    const orgId = orgRes.json().id as string;

    // Create a use case owned by that org.
    const key = `owned-uc-${Date.now()}`;
    const ucRes = await app.inject({
      method: "POST", url: `${V1}/use-cases`, headers: auth(admin),
      payload: {
        key, name: "Owned UC", tokenStandard: "ERC-20", symbol: "OUC",
        allowedChainIds: ["fabric"], defaultChainId: "fabric",
        metadataSchema: { type: "object", properties: {} },
        lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
        compliance: { allowlist: false, transferRestrictions: false },
        roles: ["UseCaseAdmin", "Issuer"], ownerOrgId: orgId,
      },
    });
    expect(ucRes.statusCode).toBe(201);

    // PlatformAdmin proposes a user in that use case; the second PlatformAdmin approves.
    const user = await onboardUser(app, admin, admin2, { email: "owned.buyer@x.dev", password: "secret1", role: "Buyer", useCaseKey: key, kyc: { legalName: "Owned", country: "IN" } });
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: user.email, password: "secret1" } });
    const creds = await myCredentials(app, login.json().token);
    expect(creds[0].issuerDid).toBe(orgDid);
  });
});
