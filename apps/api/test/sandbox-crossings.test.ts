import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/api-keys.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

/**
 * EN-D2, FINAL-REVIEW FINDINGS. Every one of these was found by walking the
 * surface by hand rather than by the coverage test, and they all share one
 * shape: **the route names no use case**, so `mode-coverage.test.ts` could not
 * see it, and the gate that was written for the door beside it was never
 * carried across.
 *
 *   HIGH-1  a `tl_test_` key APPROVED a live credential issuance and revocation
 *           — real writes to the platform's on-chain registry — because a
 *           proposal whose payload names no use case resolved to `null` and the
 *           gate read `null` as *allow* instead of as *live*. The listing had
 *           the same hole, so the key also read the proposal's `payload.claims`
 *           (the subject's KYC).
 *   HIGH-2  webhook REGISTRATION was mode-gated; PATCH, rotate, DELETE and the
 *           listing were not, so a sandbox key repointed a production
 *           endpoint's URL, rotated its signing secret, and deleted it.
 *   MED-3   `POST /verification-requests` was gated; reading, consenting,
 *           rejecting and verifying were not.
 *   MED-4   `POST /credentials/requests` had no gate at all, while a comment in
 *           `credential-kinds.ts` asserted that it did.
 *
 * Each test below pairs the refusal with a CONTROL — the same act, by a key of
 * the matching mode, succeeding. Without the control these would be satisfied
 * by a key that can do nothing at all.
 */

const TEST_ROUNDS = 4;
const HOOK = "https://203.0.113.10/hooks";

interface World {
  h: TestAppHandle;
  orgId: string;
  orgAdmin: string;
  liveKey: string;
  testKey: string;
}

/** An org with a legacy (null) envelope, its OrgAdmin, and one key of each mode. */
async function world(): Promise<World> {
  const h = await buildTestAppWithRepos();
  const tag = Math.random().toString(36).slice(2, 10);
  const org = await h.organizations.create({
    name: `XR Verifier ${tag}`, orgType: "verifier", registrationId: null, jurisdiction: null,
    did: `did:key:zXR${tag}`, didSeedEncrypted: "enc", status: "active", verified: true,
    verifiedAt: new Date().toISOString(), companyProfile: null, capabilities: null,
  });
  const email = `xr-admin-${tag}@tokenlayer.dev`;
  const password = `xr-admin-${tag}`;
  await h.users.create({
    email, passwordHash: bcrypt.hashSync(password, TEST_ROUNDS), role: "OrgAdmin",
    useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId: org.id, kind: "human",
  });
  return {
    h,
    orgId: org.id,
    orgAdmin: await loginAs(h.app, email, password),
    liveKey: await orgKey(h, org.id, "live"),
    testKey: await orgKey(h, org.id, "test"),
  };
}

async function orgKey(h: TestAppHandle, orgId: string, mode: "live" | "test"): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 10);
  const svc = await h.users.create({
    email: `svc-xr-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`unguessable-${tag}`, TEST_ROUNDS),
    role: "OrgAdmin", useCaseKey: null, accountId: null, active: true, kycStatus: "approved",
    kyc: null, orgId, kind: "service",
  });
  const minted = await mintSecret(TEST_ROUNDS, mode);
  await h.apiKeys.create({
    orgId, userId: svc.id, name: `key ${tag}`, prefix: minted.prefix, secretHash: minted.hash,
    scopes: ["*"], expiresAt: null, createdBy: "test", mode,
  });
  return minted.secret;
}

function endpoint(h: TestAppHandle, orgId: string, mode: "live" | "test") {
  return h.deps.webhookEndpoints.create({
    orgId, url: HOOK, description: null, eventTypes: ["*"],
    useCaseKey: null, secretEncrypted: "cipher", createdBy: "test", mode,
  });
}

describe("EN-D2 · HIGH-2 · every webhook route is mode-scoped, not only registration", () => {
  it("a tl_test_ key cannot list, repoint, rotate or delete a LIVE endpoint", async () => {
    const w = await world();
    const live = await endpoint(w.h, w.orgId, "live");

    // The listing is where the id came from, so it is the first thing to close.
    const listed = await w.h.app.inject({ method: "GET", url: `${V1}/orgs/${w.orgId}/webhooks`, headers: auth(w.testKey) });
    expect(listed.statusCode).toBe(200);
    expect((listed.json().endpoints as { id: string }[]).some((e) => e.id === live.id)).toBe(false);

    const base = `${V1}/orgs/${w.orgId}/webhooks/${live.id}`;
    // Repointing the URL is the crossing that matters: `mode` is deliberately
    // not patchable, so an attacker never touches it — they move where the
    // production stream is DELIVERED instead.
    const patched = await w.h.app.inject({ method: "PATCH", url: base, headers: auth(w.testKey), payload: { url: "https://203.0.113.99/collect" } });
    expect(patched.statusCode).toBe(404);
    const rotated = await w.h.app.inject({ method: "POST", url: `${base}/rotate`, headers: auth(w.testKey), payload: {} });
    expect(rotated.statusCode).toBe(404);
    const deleted = await w.h.app.inject({ method: "DELETE", url: base, headers: auth(w.testKey) });
    expect(deleted.statusCode).toBe(404);

    // NOTHING MOVED — the row is byte-for-byte what it was.
    const after = await w.h.deps.webhookEndpoints.findById(live.id);
    expect(after).toMatchObject({ url: HOOK, mode: "live", deletedAt: null });

    // CONTROL: the live key does all three, so the refusals above are about the
    // MODE and not about a broken route.
    const okPatch = await w.h.app.inject({ method: "PATCH", url: base, headers: auth(w.liveKey), payload: { url: "https://203.0.113.11/hooks" } });
    expect(okPatch.statusCode).toBe(200);
    const okRotate = await w.h.app.inject({ method: "POST", url: `${base}/rotate`, headers: auth(w.liveKey), payload: {} });
    expect(okRotate.statusCode).toBe(200);
    const okDelete = await w.h.app.inject({ method: "DELETE", url: base, headers: auth(w.liveKey) });
    expect(okDelete.statusCode).toBe(200);
  });

  it("…and the mirror: a tl_live_ key cannot reach a SANDBOX endpoint either", async () => {
    // The direction an implementation forgets. "Keep test keys out of
    // production" written as a one-way check leaves live keys free to rotate
    // the secret an integrator is verifying their own signatures against.
    const w = await world();
    const test = await endpoint(w.h, w.orgId, "test");
    const base = `${V1}/orgs/${w.orgId}/webhooks/${test.id}`;

    expect((await w.h.app.inject({ method: "POST", url: `${base}/rotate`, headers: auth(w.liveKey), payload: {} })).statusCode).toBe(404);
    const listed = await w.h.app.inject({ method: "GET", url: `${V1}/orgs/${w.orgId}/webhooks`, headers: auth(w.liveKey) });
    expect((listed.json().endpoints as { id: string }[]).some((e) => e.id === test.id)).toBe(false);

    // CONTROL: the test key owns it.
    expect((await w.h.app.inject({ method: "POST", url: `${base}/rotate`, headers: auth(w.testKey), payload: {} })).statusCode).toBe(200);
  });

  it("a human OrgAdmin still sees and manages both", async () => {
    // The session asymmetry, on this surface too: an OrgAdmin who could not
    // manage their own sandbox endpoints could not set the sandbox up.
    const w = await world();
    const live = await endpoint(w.h, w.orgId, "live");
    const test = await endpoint(w.h, w.orgId, "test");

    const listed = await w.h.app.inject({ method: "GET", url: `${V1}/orgs/${w.orgId}/webhooks`, headers: auth(w.orgAdmin) });
    const ids = (listed.json().endpoints as { id: string }[]).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([live.id, test.id]));
    for (const e of [live, test]) {
      const r = await w.h.app.inject({ method: "POST", url: `${V1}/orgs/${w.orgId}/webhooks/${e.id}/rotate`, headers: auth(w.orgAdmin), payload: {} });
      expect(r.statusCode, `${e.mode} rotate`).toBe(200);
    }
  });
});

describe("EN-D2 · HIGH-1 · a proposal that names no use case is LIVE, not unguarded", () => {
  /** A pending closed-catalog issuance for the org — `useCaseKey` null by design. */
  async function pendingIssue(w: World) {
    return w.h.deps.proposals.create({
      useCaseKey: null, orgId: w.orgId, assetId: null, kind: "issue-credential",
      payload: {
        type: "KycCredential", subjectDid: "did:key:zSubject1", subjectUserId: "user_subject_1",
        claims: { legalName: "Ada Lovelace", country: "IN", idType: "passport", idNumber: "P1234567" },
        issuerOrgId: w.orgId,
      },
      proposerId: "user_someone_else", proposerLabel: "someone@else.dev", required: 1,
    });
  }

  it("a tl_test_ key can neither see nor approve a live closed-catalog issuance", async () => {
    const w = await world();
    const p = await pendingIssue(w);

    // THE READ. `payload.claims` is the subject's KYC, and the listing was
    // handing it over: an "isolated" environment leaking production data by
    // reading is the quieter half of this finding.
    const listed = await w.h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(w.testKey) });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { id: string }[]).some((r) => r.id === p.id)).toBe(false);
    expect(listed.payload).not.toContain("Ada Lovelace");
    expect(listed.payload).not.toContain("P1234567");

    // THE WRITE. Approving EXECUTES the issuance — a real signature and a real
    // anchor on the platform registry — so this is the crossing itself.
    const approved = await w.h.app.inject({ method: "POST", url: `${V1}/proposals/${p.id}/approve`, headers: auth(w.testKey), payload: {} });
    expect(approved.statusCode).toBe(403);
    expect(approved.json()).toMatchObject({ error: "WRONG_MODE", details: { keyMode: "test", useCaseMode: "live" } });
    // Nothing ran: still pending, no approval recorded.
    expect(await w.h.deps.proposals.get(p.id)).toMatchObject({ status: "pending", approvals: [] });

    // CONTROL: the live key sees it and may decide it. (Rejecting rather than
    // approving — the subject here is the gate, not the executor.)
    const seen = await w.h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(w.liveKey) });
    expect((seen.json() as { id: string }[]).some((r) => r.id === p.id)).toBe(true);
    const decided = await w.h.app.inject({ method: "POST", url: `${V1}/proposals/${p.id}/reject`, headers: auth(w.liveKey), payload: {} });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().proposal.status).toBe("rejected");
  });

  it("MED-4: the DRAFT door is gated too, so the refusal names the real problem", async () => {
    // A proposal a test key can create but never approve is a trap — the 403
    // arrives one step later, on a route whose subject is a proposal id rather
    // than the thing the integrator actually asked for.
    const w = await world();
    const subject = await w.h.users.create({
      email: "xr-subject@tokenlayer.dev", passwordHash: bcrypt.hashSync("subject-secret", TEST_ROUNDS),
      role: "Auditor", useCaseKey: null, accountId: null, active: true, kycStatus: "approved",
      kyc: null, orgId: w.orgId, kind: "human", did: "did:key:zSubject2",
    });
    const body = { type: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Ada Lovelace", country: "IN" } };

    const drafted = await w.h.app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(w.testKey), payload: body });
    expect(drafted.statusCode).toBe(403);
    expect(drafted.json()).toMatchObject({ error: "WRONG_MODE", details: { keyMode: "test", useCaseMode: "live" } });

    // CONTROL: the live key drafts it.
    const ok = await w.h.app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(w.liveKey), payload: body });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().proposal.kind).toBe("issue-credential");
  });
});

describe("EN-D2 · MED-3 · a verification request carries its use case's mode", () => {
  /** A live verification request raised by the org. */
  function liveRequest(w: World) {
    return w.h.deps.verificationRequests.create({
      verifierOrgId: w.orgId, holderDid: "did:key:zHolder1",
      requestedTypes: ["KycCredential"], purpose: "onboarding",
      credentialUseCaseKey: null, // unbound — and therefore LIVE, not mode-less
      challenge: "chal-1", status: "pending", presentationVpJwt: null,
      consentedAt: null, consentedCredentialIds: null, verifierResult: null, verifiedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }

  it("a tl_test_ key can neither read nor verify a live request", async () => {
    const w = await world();
    const r = await liveRequest(w);

    const read = await w.h.app.inject({ method: "GET", url: `${V1}/verification-requests/${r.id}`, headers: auth(w.testKey) });
    expect(read.statusCode).toBe(404);
    // Nothing about the holder leaked with the refusal.
    expect(read.payload).not.toContain("did:key:zHolder1");

    // `/verify` is a ONE-WAY transition: it stamps verifierResult + verifiedAt
    // and appends to the audit log, so the mode check has to sit with the
    // authorization check rather than after the status check.
    const verified = await w.h.app.inject({ method: "GET", url: `${V1}/verification-requests/${r.id}/verify`, headers: auth(w.testKey) });
    expect(verified.statusCode).toBe(404);
    expect(await w.h.deps.verificationRequests.get(r.id)).toMatchObject({ status: "pending", verifierResult: null, verifiedAt: null });

    // CONTROL: the live key of the same org reads it.
    const ok = await w.h.app.inject({ method: "GET", url: `${V1}/verification-requests/${r.id}`, headers: auth(w.liveKey) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: r.id, holderDid: "did:key:zHolder1" });
  });
});
