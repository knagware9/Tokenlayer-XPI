import { describe, expect, it } from "vitest";
import { MemoryCredentialRepository, MemoryVerificationRequestRepository } from "../src/persistence/memory.js";
import type { CredentialRecord } from "../src/persistence/types.js";
import { auth, buildTestApp, loginAs, onboardUser, V1 } from "./helpers.js";

const cred = (id: string, over: Partial<CredentialRecord> = {}): CredentialRecord => ({
  id, holderDid: `did:key:h-${id}`, issuerDid: "did:key:issuer", type: "ScoreCredential",
  vcJwt: "jwt", subjectClaims: {}, issuedAt: "2026-08-01T00:00:00.000Z", expiresAt: null,
  revoked: false, revokedAt: null, revokedReason: null, revokedBy: null, proposalId: null,
  credentialUseCaseKey: "uc-a", acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
  ...over,
});

describe("repo list() (ID-N task N1)", () => {
  it("MemoryCredentialRepository.list returns every stored credential", async () => {
    const repo = new MemoryCredentialRepository();
    await repo.create(cred("c1"));
    await repo.create(cred("c2", { credentialUseCaseKey: null }));
    const all = await repo.list();
    expect(all.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("MemoryVerificationRequestRepository.list returns every request", async () => {
    const repo = new MemoryVerificationRequestRepository();
    await repo.create({
      verifierOrgId: "org-1", holderDid: "did:key:h", requestedTypes: ["ScoreCredential"],
      purpose: "p", credentialUseCaseKey: "uc-a", challenge: "ch", status: "pending",
      presentationVpJwt: null, consentedAt: null, consentedCredentialIds: null,
      verifierResult: null, verifiedAt: null, expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect((await repo.list())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// N3: GET /identity/dashboard — scope resolution + fold wiring over the runtime
// ---------------------------------------------------------------------------

interface DashTotals { issued: number; accepted: number; pendingAcceptance: number; changesRequested: number; rejectedByHolder: number; revoked: number; expired: number }
interface Dash {
  totals: DashTotals;
  byUseCase: { key: string; name: string; counts: DashTotals; byType: { type: string; counts: DashTotals }[] }[];
  board: { credentialId: string; holderLabel: string; status: string; acceptanceNote: string | null }[];
  boardTotal: number;
  activity: { date: string; issued: number }[];
  verification: { pending: number; consented: number; rejected: number; expired: number; verifiedValid: number; verifiedInvalid: number };
}

/** Identity use case with one Score type; `over` may flip holderAcceptance or rebind the issuer. */
async function seedDashUseCase(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, key: string, over: Record<string, unknown> = {}) {
  const DEF = {
    key, name: `Dash UC ${key}`,
    credentialTypes: [{ name: "ScoreCredential", title: "Score", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["legalName"], properties: { legalName: { type: "string" } } } }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    ...over,
  };
  const r = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
  expect(r.statusCode).toBe(201);
  return key;
}

/** Issue one credential to `email` under `key` (maker admin, checker admin2). */
async function issueTo(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, admin2: string, key: string, email: string) {
  const users = (await app.inject({ method: "GET", url: `${V1}/users`, headers: auth(admin) })).json() as { id: string; email: string }[];
  const subjectUserId = users.find((u) => u.email === email)!.id;
  const draft = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/${key}/credentials`, headers: auth(admin),
    payload: { credentialType: "ScoreCredential", subjectUserId, claims: { legalName: email } } });
  expect(draft.statusCode).toBe(202);
  const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
  expect(approve.statusCode).toBe(200);
}

const dash = async (app: Awaited<ReturnType<typeof buildTestApp>>, token: string) => {
  const res = await app.inject({ method: "GET", url: `${V1}/identity/dashboard`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json() as Dash;
};

/** Login returning the token AND the custodial DID (the login body's `user.did`
 *  — GET /me does not expose the DID, mirrors credential-desk's loginWithDid). */
async function loginWithDid(app: Awaited<ReturnType<typeof buildTestApp>>, email: string, password: string): Promise<{ token: string; did: string }> {
  const res = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email, password } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { token: string; user: { did: string | null } };
  expect(body.user.did).toBeTruthy();
  return { token: body.token, did: body.user.did! };
}

describe("GET /identity/dashboard (ID-N task N3)", () => {
  it("lifecycle counts move: pending → accepted → revoked; catalog (null-key) credentials never counted", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedDashUseCase(app, admin, "dash-uc-life", { holderAcceptance: true });

    // Onboarding mints a null-key onboarding KYC credential — it must never count.
    await onboardUser(app, admin, admin2, { email: "dash.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: key });
    const baseline = await dash(app, admin);
    const baseRow = baseline.byUseCase.find((u) => u.key === key)!;
    expect(baseRow).toBeDefined();
    expect(baseRow.counts.issued).toBe(0);

    await issueTo(app, admin, admin2, key, "dash.holder@x.dev");
    const afterIssue = await dash(app, admin);
    const issuedRow = afterIssue.byUseCase.find((u) => u.key === key)!;
    expect(issuedRow.counts.issued).toBe(1);
    expect(issuedRow.counts.pendingAcceptance).toBe(1);
    const boardRow = afterIssue.board.find((b) => b.holderLabel === "dash.holder@x.dev")!;
    expect(boardRow).toBeDefined();
    expect(boardRow.status).toBe("pending");

    // Holder accepts.
    const holderToken = await loginAs(app, "dash.holder@x.dev", "secret1");
    const held = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holderToken) })).json() as { id: string; type: string[] }[];
    const credentialId = held.find((c) => c.type.includes("ScoreCredential"))!.id;
    const accept = await app.inject({ method: "POST", url: `${V1}/me/credentials/${credentialId}/accept`, headers: auth(holderToken), payload: {} });
    expect(accept.statusCode).toBe(200);
    const afterAccept = await dash(app, admin);
    const acceptedRow = afterAccept.byUseCase.find((u) => u.key === key)!;
    expect(acceptedRow.counts.accepted).toBe(1);
    expect(acceptedRow.counts.pendingAcceptance).toBe(0);

    // Revoke via the real flow: 202 proposal from the platform admin, second admin approves.
    const revoke = await app.inject({ method: "POST", url: `${V1}/credentials/${credentialId}/revoke`, headers: auth(admin), payload: { reason: "dash revoke" } });
    expect(revoke.statusCode).toBe(202);
    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${revoke.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    expect(approve.statusCode).toBe(200);
    const afterRevoke = await dash(app, admin);
    const revokedRow = afterRevoke.byUseCase.find((u) => u.key === key)!;
    expect(revokedRow.counts.revoked).toBe(1);
    expect(revokedRow.counts.accepted).toBe(0);
  });

  it("scope isolation: an identity desk sees only its own use case; PlatformAdmin sees both", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const keyA = await seedDashUseCase(app, admin, "dash-uc-scope-a");
    const keyB = await seedDashUseCase(app, admin, "dash-uc-scope-b");

    await onboardUser(app, admin, admin2, { email: "dash.scope.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: keyA });
    await issueTo(app, admin, admin2, keyA, "dash.scope.holder@x.dev");
    await issueTo(app, admin, admin2, keyB, "dash.scope.holder@x.dev");

    await onboardUser(app, admin, admin2, { email: "dash.scope.issuer@x.dev", password: "secret1", role: "Issuer", useCaseKey: keyA });
    const issuerToken = await loginAs(app, "dash.scope.issuer@x.dev", "secret1");

    const deskDash = await dash(app, issuerToken);
    expect(deskDash.byUseCase.map((u) => u.key)).toEqual([keyA]);
    expect(deskDash.totals.issued).toBe(1);

    const adminDash = await dash(app, admin);
    const adminKeys = adminDash.byUseCase.map((u) => u.key);
    expect(adminKeys).toContain(keyA);
    expect(adminKeys).toContain(keyB);
  });

  it("OrgAdmin sees own-org-issuer use cases only; an OrgAdmin with none gets a zeroed dashboard", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const orgA = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: "Dash Org A", orgType: "corporate" } })).json() as { id: string };
    const orgB = (await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: "Dash Org B", orgType: "corporate" } })).json() as { id: string };
    const mkA = await app.inject({ method: "POST", url: `${V1}/orgs/${orgA.id}/users`, headers: auth(admin), payload: { email: "dash.orgadmin.a@x.io", password: "secret1", role: "OrgAdmin" } });
    expect(mkA.statusCode).toBe(201);
    const mkB = await app.inject({ method: "POST", url: `${V1}/orgs/${orgB.id}/users`, headers: auth(admin), payload: { email: "dash.orgadmin.b@x.io", password: "secret1", role: "OrgAdmin" } });
    expect(mkB.statusCode).toBe(201);
    const orgAdminA = await loginAs(app, "dash.orgadmin.a@x.io", "secret1");
    const orgAdminB = await loginAs(app, "dash.orgadmin.b@x.io", "secret1");

    const keyA = await seedDashUseCase(app, admin, "dash-uc-org-a", { issuer: { kind: "org", orgId: orgA.id } });

    const dashA = await dash(app, orgAdminA);
    expect(dashA.byUseCase.map((u) => u.key)).toEqual([keyA]);

    // Org B issues nothing: a zeroed dashboard (200), NOT a 403.
    const dashB = await dash(app, orgAdminB);
    expect(dashB.byUseCase).toEqual([]);
    expect(dashB.totals.issued).toBe(0);
  });

  it("verification requests count toward the scope's verification card", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedDashUseCase(app, admin, "dash-uc-verif");

    await onboardUser(app, admin, admin2, { email: "dash.verif.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: key });
    await issueTo(app, admin, admin2, key, "dash.verif.holder@x.dev");
    const holder = await loginWithDid(app, "dash.verif.holder@x.dev", "secret1");

    // PlatformAdmin may not create verification requests (403 NOT_A_VERIFIER) —
    // a scoped Verifier desk user creates it; the admin dashboard counts it.
    await onboardUser(app, admin, admin2, { email: "dash.verif.verifier@x.dev", password: "secret1", role: "Verifier", useCaseKey: key });
    const verifierToken = await loginAs(app, "dash.verif.verifier@x.dev", "secret1");
    const created = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(verifierToken),
      payload: { holderDid: holder.did, requestedTypes: ["ScoreCredential"], purpose: "dash test", credentialUseCaseKey: key } });
    expect(created.statusCode).toBe(201);

    const adminDash = await dash(app, admin);
    expect(adminDash.verification.pending).toBeGreaterThanOrEqual(1);
  });

  it("403 outside the scope: Holder, scoped Verifier, and a tokenization desk admin", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedDashUseCase(app, admin, "dash-uc-403");

    await onboardUser(app, admin, admin2, { email: "dash.403.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: key });
    await onboardUser(app, admin, admin2, { email: "dash.403.verifier@x.dev", password: "secret1", role: "Verifier", useCaseKey: key });
    const holderToken = await loginAs(app, "dash.403.holder@x.dev", "secret1");
    const verifierToken = await loginAs(app, "dash.403.verifier@x.dev", "secret1");
    // A tokenization-scoped UseCaseAdmin: their useCaseKey is NOT in the credential catalog.
    const tokenizationAdmin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");

    for (const token of [holderToken, verifierToken, tokenizationAdmin]) {
      const res = await app.inject({ method: "GET", url: `${V1}/identity/dashboard`, headers: auth(token) });
      expect(res.statusCode).toBe(403);
    }
  });
});
