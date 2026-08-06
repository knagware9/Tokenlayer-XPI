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
