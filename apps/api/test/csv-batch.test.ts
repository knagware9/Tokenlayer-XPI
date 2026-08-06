import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

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
