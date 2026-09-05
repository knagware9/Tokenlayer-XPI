import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, PLATFORM_ADMIN_2, V1 } from "./helpers.js";

async function submitPendingKyc(app: import("fastify").FastifyInstance, token: string): Promise<void> {
  const up1 = await app.inject({ method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(token), payload: { contentType: "application/pdf", dataBase64: Buffer.from("id").toString("base64") } });
  const up2 = await app.inject({ method: "POST", url: `${V1}/users/me/kyc/documents`, headers: auth(token), payload: { contentType: "application/pdf", dataBase64: Buffer.from("addr").toString("base64") } });
  const res = await app.inject({
    method: "POST", url: `${V1}/users/me/kyc/submit`, headers: auth(token),
    payload: { legalName: "T H", country: "IN", idType: "passport", idNumber: "P1", idDocumentId: up1.json().id, addressDocumentId: up2.json().id },
  });
  expect(res.statusCode).toBe(200);
}

describe("kyc-decision proposal kind", () => {
  it("propose approve, then a second PlatformAdmin approves: sets approved + riskTier + a ~1-year expiresAt", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    await submitPendingKyc(h.app, buyer);
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    const draft = await h.app.inject({
      method: "POST", url: `${V1}/users/${user!.id}/kyc/decision`, headers: auth(platform),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(draft.statusCode).toBe(202);
    const approve = await h.app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(checker), payload: {} });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().proposal.status).toBe("executed");
    const updated = await h.users.findById(user!.id);
    expect(updated!.kycStatus).toBe("approved");
    expect(updated!.kyc!.riskTier).toBe("low");
    const expiresAt = new Date(updated!.kyc!.expiresAt!);
    const daysOut = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(daysOut).toBeGreaterThan(360);
    expect(daysOut).toBeLessThan(370);
  });

  it("propose reject with a reason: sets rejected + rejectionReason, no expiresAt", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    await submitPendingKyc(h.app, buyer);
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    const draft = await h.app.inject({
      method: "POST", url: `${V1}/users/${user!.id}/kyc/decision`, headers: auth(platform),
      payload: { decision: "rejected", rejectionReason: "ID document illegible" },
    });
    expect(draft.statusCode).toBe(202);
    await h.app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(checker), payload: {} });
    const updated = await h.users.findById(user!.id);
    expect(updated!.kycStatus).toBe("rejected");
    expect(updated!.kyc!.rejectionReason).toBe("ID document illegible");
    expect(updated!.kyc!.expiresAt).toBeFalsy();
  });

  it("proposing an approval without a riskTier is refused with RISK_TIER_REQUIRED", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await submitPendingKyc(h.app, buyer);
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/${user!.id}/kyc/decision`, headers: auth(platform),
      payload: { decision: "approved" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("RISK_TIER_REQUIRED");
  });

  it("a PlatformAdmin cannot propose a KYC decision about themselves", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await submitPendingKyc(h.app, platform);
    const self = await h.users.findByEmail("admin@tokenlayer.dev");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/${self!.id}/kyc/decision`, headers: auth(platform),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a PlatformAdmin who is the KYC subject cannot approve a decision proposed by someone else about them", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);
    await submitPendingKyc(h.app, checker);
    const subject = await h.users.findByEmail(PLATFORM_ADMIN_2.email);
    // `platform` (admin@tokenlayer.dev) proposes a decision about `subject`
    // (admin2@tokenlayer.dev, the checker) — someone else's subject, fine so far.
    const draft = await h.app.inject({
      method: "POST", url: `${V1}/users/${subject!.id}/kyc/decision`, headers: auth(platform),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(draft.statusCode).toBe(202);
    // Now the SUBJECT tries to approve the decision about themselves.
    const selfSubjectApprove = await h.app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(checker), payload: {} });
    expect(selfSubjectApprove.statusCode).toBe(403);
    expect(selfSubjectApprove.json().error).toBe("NOT_ELIGIBLE");
  });

  it("a non-PlatformAdmin cannot propose a KYC decision", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const nonAdmin = await loginAs(h.app, "carbon.issuer@tokenlayer.dev", "carbon123");
    await submitPendingKyc(h.app, buyer);
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    const res = await h.app.inject({
      method: "POST", url: `${V1}/users/${user!.id}/kyc/decision`, headers: auth(nonAdmin),
      payload: { decision: "approved", riskTier: "low" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("the proposing admin cannot also approve their own proposal (SELF_APPROVAL)", async () => {
    const h = await buildTestAppWithRepos();
    const buyer = await loginAs(h.app, "carbon.buyer@tokenlayer.dev", "carbon123");
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await submitPendingKyc(h.app, buyer);
    const user = await h.users.findByEmail("carbon.buyer@tokenlayer.dev");
    const draft = await h.app.inject({
      method: "POST", url: `${V1}/users/${user!.id}/kyc/decision`, headers: auth(platform),
      payload: { decision: "approved", riskTier: "low" },
    });
    const selfApprove = await h.app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(platform), payload: {} });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().error).toBe("SELF_APPROVAL");
  });
});
