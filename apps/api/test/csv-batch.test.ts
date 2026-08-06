import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, onboardUser, V1 } from "./helpers.js";

// ID-M / M1: Proposal gains a generic `result` field — a home for whatever
// report an executor wants to leave behind (e.g. a CSV batch's per-row
// outcomes). This pins that the field exists and defaults to null on a
// freshly created (still-pending) proposal, both on the create response and
// via GET /proposals.
describe("Proposal.result (ID-M task M1)", () => {
  it("a freshly created proposal has result: null on the create response", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const res = await app.inject({
      method: "POST",
      url: `${V1}/users`,
      headers: auth(admin),
      payload: {
        email: `m1-${Math.random().toString(36).slice(2)}@x.dev`,
        password: "secret1",
        role: "Buyer",
        useCaseKey: "invoice-tokenization",
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { proposal: { id: string; result: unknown } };
    expect(body.proposal).toHaveProperty("result");
    expect(body.proposal.result).toBeNull();
  });

  it("GET /proposals shows result: null on the pending row", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const created = await app.inject({
      method: "POST",
      url: `${V1}/users`,
      headers: auth(admin),
      payload: {
        email: `m1-${Math.random().toString(36).slice(2)}@x.dev`,
        password: "secret1",
        role: "Buyer",
        useCaseKey: "invoice-tokenization",
      },
    });
    expect(created.statusCode).toBe(202);
    const proposalId = created.json().proposal.id as string;

    const list = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(admin) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as { id: string; result: unknown }[];
    const row = rows.find((r) => r.id === proposalId);
    expect(row).toBeDefined();
    expect(row).toHaveProperty("result");
    expect(row!.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M2: onboard-user-batch kind + POST /users/batch
// ---------------------------------------------------------------------------

interface BatchResultRow { index: number; email: string; status: "ok" | "failed"; error?: string }
interface BatchResult { total: number; succeeded: number; failed: number; rows: BatchResultRow[] }
interface ProposalView { id: string; kind: string; status: string; result: BatchResult | null }

/** A minimal identity-domain credential use case, usable as `useCaseKey` for onboarding a Holder. */
async function seedIdentityUseCase(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, key: string): Promise<string> {
  const DEF = {
    key, name: "Batch Identity UC",
    credentialTypes: [{ name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["legalName", "country"], properties: { legalName: { type: "string" }, country: { type: "string" } } } }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
  };
  const r = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
  expect(r.statusCode).toBe(201);
  return key;
}

describe("onboard-user-batch (ID-M task M2)", () => {
  it("happy batch: 3 rows draft as one proposal → approve → executed 3/3 ok, each user can log in", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedIdentityUseCase(app, admin, `batch-happy-${Math.random().toString(36).slice(2)}`);
    const rows = [0, 1, 2].map((i) => ({
      email: `batch-happy-${i}-${Math.random().toString(36).slice(2)}@x.dev`,
      password: "secret123", role: "Holder", useCaseKey: key,
    }));

    const draft = await app.inject({ method: "POST", url: `${V1}/users/batch`, headers: auth(admin), payload: { rows } });
    expect(draft.statusCode).toBe(202);
    const drafted = draft.json().proposal as ProposalView;
    expect(drafted.kind).toBe("onboard-user-batch");
    expect(drafted.result).toBeNull();

    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${drafted.id}/approve`, headers: auth(admin2), payload: {} });
    expect(approve.statusCode).toBe(200);
    const executed = approve.json().proposal as ProposalView;
    expect(executed.status).toBe("executed");
    expect(executed.result).toMatchObject({ total: 3, succeeded: 3, failed: 0 });
    expect(executed.result!.rows).toHaveLength(3);
    expect(executed.result!.rows.every((r) => r.status === "ok")).toBe(true);

    for (const row of rows) {
      const tok = await loginAs(app, row.email, row.password);
      expect(typeof tok).toBe("string");
      expect(tok.length).toBeGreaterThan(0);
      const me = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(tok) });
      expect(me.statusCode).toBe(200);
    }
  });

  it("in-batch duplicate email → 400 BATCH_INVALID with per-row problems, no proposal created", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const key = await seedIdentityUseCase(app, admin, `batch-dup-${Math.random().toString(36).slice(2)}`);
    const dupEmail = `batch-dup-${Math.random().toString(36).slice(2)}@x.dev`;
    const rows = [
      { email: dupEmail, password: "secret123", role: "Holder", useCaseKey: key },
      { email: dupEmail, password: "secret123", role: "Holder", useCaseKey: key },
    ];

    const before = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(admin) });
    const beforeCount = (before.json() as { kind: string }[]).filter((p) => p.kind === "onboard-user-batch").length;

    const res = await app.inject({ method: "POST", url: `${V1}/users/batch`, headers: auth(admin), payload: { rows } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BATCH_INVALID");
    expect(res.json().problems).toEqual(expect.arrayContaining([expect.objectContaining({ index: 1 })]));

    const after = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(admin) });
    const afterCount = (after.json() as { kind: string }[]).filter((p) => p.kind === "onboard-user-batch").length;
    expect(afterCount).toBe(beforeCount);
  });

  it("a row whose email already exists → 400 BATCH_INVALID, no proposal created", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedIdentityUseCase(app, admin, `batch-taken-${Math.random().toString(36).slice(2)}`);
    const existing = await onboardUser(app, admin, admin2, {
      email: `batch-taken-${Math.random().toString(36).slice(2)}@x.dev`, password: "secret123", role: "Holder", useCaseKey: key,
    });

    const before = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(admin) });
    const beforeCount = (before.json() as { kind: string }[]).filter((p) => p.kind === "onboard-user-batch").length;

    const rows = [{ email: existing.email, password: "secret123", role: "Holder", useCaseKey: key }];
    const res = await app.inject({ method: "POST", url: `${V1}/users/batch`, headers: auth(admin), payload: { rows } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BATCH_INVALID");
    expect(res.json().problems).toEqual(expect.arrayContaining([expect.objectContaining({ index: 0 })]));

    const after = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(admin) });
    const afterCount = (after.json() as { kind: string }[]).filter((p) => p.kind === "onboard-user-batch").length;
    expect(afterCount).toBe(beforeCount);
  });

  it("rows: [] → 400 (schema minItems)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await app.inject({ method: "POST", url: `${V1}/users/batch`, headers: auth(admin), payload: { rows: [] } });
    expect(res.statusCode).toBe(400);
  });

  it("201 rows → 400 (schema maxItems)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const rows = Array.from({ length: 201 }, (_, i) => ({ email: `over-${i}@x.dev`, password: "secret123", role: "Holder" }));
    const res = await app.inject({ method: "POST", url: `${V1}/users/batch`, headers: auth(admin), payload: { rows } });
    expect(res.statusCode).toBe(400);
  });

  it("role-escalation row (UseCaseAdmin caller submitting role UseCaseAdmin) → 400 per-row problem, no proposal", async () => {
    const app = await buildTestApp();
    // m1.admin is a seeded UseCaseAdmin scoped to the "invoice-tokenization" use case.
    const ucAdmin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const rows = [{ email: `escalate-${Math.random().toString(36).slice(2)}@x.dev`, password: "secret123", role: "UseCaseAdmin" }];

    const res = await app.inject({ method: "POST", url: `${V1}/users/batch`, headers: auth(ucAdmin), payload: { rows } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BATCH_INVALID");
    expect(res.json().problems).toEqual(expect.arrayContaining([expect.objectContaining({ index: 0 })]));
  });

  it("execution-time row failure: a row's email is taken by the single path between draft and approve", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedIdentityUseCase(app, admin, `batch-race-${Math.random().toString(36).slice(2)}`);
    const raceEmail = `batch-race-${Math.random().toString(36).slice(2)}@x.dev`;
    const okEmail = `batch-race-ok-${Math.random().toString(36).slice(2)}@x.dev`;
    const rows = [
      { email: raceEmail, password: "secret123", role: "Holder", useCaseKey: key },
      { email: okEmail, password: "secret123", role: "Holder", useCaseKey: key },
    ];

    const draft = await app.inject({ method: "POST", url: `${V1}/users/batch`, headers: auth(admin), payload: { rows } });
    expect(draft.statusCode).toBe(202);
    const drafted = draft.json().proposal as ProposalView;

    // Onboard row[0]'s email via the SINGLE path before the batch is approved.
    await onboardUser(app, admin, admin2, { email: raceEmail, password: "secret123", role: "Holder", useCaseKey: key });

    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${drafted.id}/approve`, headers: auth(admin2), payload: {} });
    expect(approve.statusCode).toBe(200);
    const executed = approve.json().proposal as ProposalView;
    expect(executed.status).toBe("executed");
    expect(executed.result).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    const failedRow = executed.result!.rows.find((r) => r.email === raceEmail);
    const okRow = executed.result!.rows.find((r) => r.email === okEmail);
    expect(failedRow?.status).toBe("failed");
    expect(failedRow?.error).toMatch(/email/i);
    expect(okRow?.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// M3: issue-usecase-credential-batch kind + POST /credential-use-cases/:key/credentials/batch
// ---------------------------------------------------------------------------

interface CredBatchRowResult { index: number; subjectEmail: string; status: "ok" | "failed"; credentialId?: string; error?: string }
interface CredBatchResult { total: number; succeeded: number; failed: number; rows: CredBatchRowResult[] }
interface CredProposalView { id: string; kind: string; status: string; required: number; result: CredBatchResult | null }
interface HeldCredentialM3 { id: string; type: string[]; acceptance: "accepted" | "pending" | "rejected" | "changes_requested" }

/** A credential use case whose claim schema has a required string + a required number field. */
async function seedScoreUseCase(app: Awaited<ReturnType<typeof buildTestApp>>, admin: string, key: string, over: Record<string, unknown> = {}) {
  const DEF = {
    key, name: "Batch Score UC",
    credentialTypes: [{ name: "ScoreCredential", title: "Score", validityDays: 365, requiredApprovals: 1,
      claimSchema: { type: "object", required: ["legalName", "score"], properties: { legalName: { type: "string" }, score: { type: "number" } } } }],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    ...over,
  };
  const r = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(admin), payload: DEF });
  expect(r.statusCode).toBe(201);
  return key;
}

/** Onboard `n` Holders scoped to `key`, via the single onboard-user path (maker/checker), each minted a DID. */
async function onboardHolders(
  app: Awaited<ReturnType<typeof buildTestApp>>, maker: string, checker: string, key: string, n: number,
): Promise<{ email: string; password: string }[]> {
  const out: { email: string; password: string }[] = [];
  for (let i = 0; i < n; i++) {
    const email = `m3-holder-${i}-${Math.random().toString(36).slice(2)}@x.dev`;
    const password = "secret123";
    await onboardUser(app, maker, checker, { email, password, role: "Holder", useCaseKey: key });
    out.push({ email, password });
  }
  return out;
}

describe("issue-usecase-credential-batch (M3)", () => {
  it("happy batch: 3 rows draft as one proposal → approve → executed 3/3 ok, each holder holds the credential", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedScoreUseCase(app, admin, `m3-happy-${Math.random().toString(36).slice(2)}`);
    const holders = await onboardHolders(app, admin, admin2, key, 3);

    const rows = holders.map((h, i) => ({ subjectEmail: h.email, claims: { legalName: `Holder ${i}`, score: 10 + i } }));
    const draft = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/credentials/batch`, headers: auth(admin),
      payload: { credentialType: "ScoreCredential", rows },
    });
    expect(draft.statusCode).toBe(202);
    const drafted = draft.json().proposal as CredProposalView;
    expect(drafted.kind).toBe("issue-usecase-credential-batch");
    expect(drafted.required).toBe(1);
    expect(drafted.result).toBeNull();

    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${drafted.id}/approve`, headers: auth(admin2), payload: {} });
    expect(approve.statusCode).toBe(200);
    const executed = approve.json().proposal as CredProposalView;
    expect(executed.status).toBe("executed");
    expect(executed.result).toMatchObject({ total: 3, succeeded: 3, failed: 0 });
    expect(executed.result!.rows).toHaveLength(3);
    for (const row of executed.result!.rows) {
      expect(row.status).toBe("ok");
      expect(typeof row.credentialId).toBe("string");
    }

    for (const h of holders) {
      const tok = await loginAs(app, h.email, h.password);
      const me = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(tok) });
      expect(me.statusCode).toBe(200);
      const held = me.json() as HeldCredentialM3[];
      expect(held.some((c) => c.type.includes("ScoreCredential"))).toBe(true);
    }
  });

  it("a row whose subjectEmail is unknown fails at execution; others still succeed", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedScoreUseCase(app, admin, `m3-notfound-${Math.random().toString(36).slice(2)}`);
    const holders = await onboardHolders(app, admin, admin2, key, 2);
    const unknownEmail = `m3-unknown-${Math.random().toString(36).slice(2)}@x.dev`;

    const rows = [
      { subjectEmail: unknownEmail, claims: { legalName: "Nobody", score: 1 } },
      { subjectEmail: holders[0]!.email, claims: { legalName: "Holder 0", score: 2 } },
      { subjectEmail: holders[1]!.email, claims: { legalName: "Holder 1", score: 3 } },
    ];
    const draft = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/credentials/batch`, headers: auth(admin),
      payload: { credentialType: "ScoreCredential", rows },
    });
    expect(draft.statusCode).toBe(202);
    const drafted = draft.json().proposal as CredProposalView;

    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${drafted.id}/approve`, headers: auth(admin2), payload: {} });
    expect(approve.statusCode).toBe(200);
    const executed = approve.json().proposal as CredProposalView;
    expect(executed.status).toBe("executed");
    expect(executed.result).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
    const failedRow = executed.result!.rows.find((r) => r.subjectEmail === unknownEmail);
    expect(failedRow?.status).toBe("failed");
    expect(failedRow?.error).toMatch(/holder not found/i);
    const okRows = executed.result!.rows.filter((r) => r.subjectEmail !== unknownEmail);
    expect(okRows.every((r) => r.status === "ok")).toBe(true);
  });

  it("draft-time claim rejects: a row missing a required claim → 400 BATCH_INVALID with that row's index, no proposal", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedScoreUseCase(app, admin, `m3-invalid-${Math.random().toString(36).slice(2)}`);
    const holders = await onboardHolders(app, admin, admin2, key, 2);

    const before = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(admin) });
    const beforeCount = (before.json() as { kind: string }[]).filter((p) => p.kind === "issue-usecase-credential-batch").length;

    const rows = [
      { subjectEmail: holders[0]!.email, claims: { legalName: "Holder 0", score: 1 } },
      { subjectEmail: holders[1]!.email, claims: { legalName: "Holder 1" } }, // missing 'score'
    ];
    const res = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/credentials/batch`, headers: auth(admin),
      payload: { credentialType: "ScoreCredential", rows },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BATCH_INVALID");
    expect(res.json().problems).toEqual(expect.arrayContaining([expect.objectContaining({ index: 1 })]));

    const after = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(admin) });
    const afterCount = (after.json() as { kind: string }[]).filter((p) => p.kind === "issue-usecase-credential-batch").length;
    expect(afterCount).toBe(beforeCount);
  });

  it("ID-L composition: holderAcceptance: true use case → batch-issued credentials born pending", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedScoreUseCase(app, admin, `m3-pending-${Math.random().toString(36).slice(2)}`, { holderAcceptance: true });
    const holders = await onboardHolders(app, admin, admin2, key, 1);

    const rows = [{ subjectEmail: holders[0]!.email, claims: { legalName: "Holder 0", score: 5 } }];
    const draft = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/credentials/batch`, headers: auth(admin),
      payload: { credentialType: "ScoreCredential", rows },
    });
    expect(draft.statusCode).toBe(202);
    const proposalId = draft.json().proposal.id;
    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(admin2), payload: {} });
    expect(approve.statusCode).toBe(200);

    const tok = await loginAs(app, holders[0]!.email, holders[0]!.password);
    const me = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(tok) });
    const held = me.json() as HeldCredentialM3[];
    const score = held.find((c) => c.type.includes("ScoreCredential"));
    expect(score).toBeDefined();
    expect(score!.acceptance).toBe("pending");
  });

  it("gates: unknown credentialType → 400; a non-issuer role → 403; rows over 200 → 400 (schema)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await seedScoreUseCase(app, admin, `m3-gates-${Math.random().toString(36).slice(2)}`);
    const holders = await onboardHolders(app, admin, admin2, key, 1);

    const badType = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/credentials/batch`, headers: auth(admin),
      payload: { credentialType: "Nope", rows: [{ subjectEmail: holders[0]!.email, claims: {} }] },
    });
    expect(badType.statusCode).toBe(400);
    expect(badType.json().error).toBe("UNKNOWN_CREDENTIAL_TYPE");

    // m1.admin is a UseCaseAdmin — neither PlatformAdmin nor OrgAdmin nor a
    // scoped desk operator for this use case — same gate as the single route.
    const useCaseAdmin = await loginAs(app, "m1.admin@tokenlayer.dev", "m1admin123");
    const forbidden = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/credentials/batch`, headers: auth(useCaseAdmin),
      payload: { credentialType: "ScoreCredential", rows: [{ subjectEmail: holders[0]!.email, claims: { legalName: "X", score: 1 } }] },
    });
    expect(forbidden.statusCode).toBe(403);

    const tooMany = Array.from({ length: 201 }, (_, i) => ({ subjectEmail: `over-${i}@x.dev`, claims: { legalName: "X", score: 1 } }));
    const overLimit = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/credentials/batch`, headers: auth(admin),
      payload: { credentialType: "ScoreCredential", rows: tooMany },
    });
    expect(overLimit.statusCode).toBe(400);
  });
});
