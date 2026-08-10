import { describe, expect, it } from "vitest";
import { auth, buildTestAppWithRepos, loginAs, PLATFORM_ADMIN_2, V1 } from "./helpers.js";

/**
 * `ProposalRecord.useCaseKey` is `string | null` — credential and governance
 * kinds belong to an org rather than to a use case, and a MIXED onboard batch
 * (rows targeting different desks) names no single one either. The wire must
 * say so.
 *
 * It did not. `Proposal#` declared the field as a plain non-nullable string, and
 * fast-json-stringify COERCES null to `""` for one of those, while the 202
 * envelope spells its own properties out with `nullable: true` and emitted
 * `null`. So one proposal reported `null` from the route that created it and
 * `""` from every route that read it back.
 *
 * That is worse than cosmetic here. This codebase has been bitten twice by
 * ""-vs-null in a tenancy gate (a binding check skipped because `""` is falsy,
 * and a member-binding check bypassed the same way), and an API that
 * manufactures the empty string hands the same trap to every integrator who
 * writes `if (p.useCaseKey)`.
 *
 * These tests are about the SERIALIZER, so each reads the stored row through
 * the repository and asserts every surface agrees with it.
 */
describe("a proposal's null useCaseKey survives serialization", () => {
  /**
   * A mixed-desk batch: two rows on two different seeded use cases, so
   * `uniformUseCaseKey` is null. PlatformAdmin-only by construction, which is
   * exactly why this shape exists.
   */
  async function mixedBatch(h: Awaited<ReturnType<typeof buildTestAppWithRepos>>, maker: string, tag: string) {
    const rows = [
      { email: `mixed-${tag}-a@tokenlayer.dev`, password: "secret123", role: "Issuer", useCaseKey: "carbon-credit" },
      { email: `mixed-${tag}-b@tokenlayer.dev`, password: "secret123", role: "Issuer", useCaseKey: "gold-loan" },
    ];
    const res = await h.app.inject({ method: "POST", url: `${V1}/users/batch`, headers: auth(maker), payload: { rows } });
    expect(res.statusCode).toBe(202);
    return res.json().proposal as { id: string; useCaseKey: string | null; orgId: string | null };
  }

  it("all three surfaces agree: 202 envelope, GET /proposals, and the decide response", async () => {
    const h = await buildTestAppWithRepos();
    const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);

    const envelope = await mixedBatch(h, maker, "surfaces");
    const id = envelope.id;

    // The stored row — the oracle every surface is compared against.
    expect((await h.deps.proposals.get(id))?.useCaseKey).toBeNull();

    // Surface 1: the 202 body (ProposalEnvelope).
    expect(envelope.useCaseKey).toBeNull();

    // Surface 2: the read route (Proposal#). This is the one that said "".
    const listed = (await h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(checker) })).json();
    const row = listed.find((p: { id: string }) => p.id === id);
    expect(row).toBeDefined();
    // REQUIRED as well as nullable: present and null, never absent.
    expect(Object.prototype.hasOwnProperty.call(row, "useCaseKey")).toBe(true);
    expect(row.useCaseKey).toBeNull();

    // Surface 3: the decide response (also Proposal#). Reject rather than
    // approve — the subject is the projection, not the executor.
    const decided = await h.app.inject({ method: "POST", url: `${V1}/proposals/${id}/reject`, headers: auth(checker), payload: {} });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().proposal.status).toBe("rejected");
    expect(decided.json().proposal.useCaseKey).toBeNull();
  });

  it("a use-case-scoped proposal still carries its key as a string", async () => {
    const h = await buildTestAppWithRepos();
    const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);

    const proposed = await h.app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(maker),
      payload: { email: "carbon-issuer@tokenlayer.dev", password: "issuer-secret-1", role: "Issuer", useCaseKey: "carbon-credit" },
    });
    expect(proposed.statusCode).toBe(202);
    const id = proposed.json().proposal.id as string;
    expect(proposed.json().proposal.useCaseKey).toBe("carbon-credit");

    const listed = (await h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(checker) })).json();
    expect(listed.find((p: { id: string }) => p.id === id).useCaseKey).toBe("carbon-credit");
  });

  it("orgId is nullable on the read route too — it reached the wire only via additionalProperties", async () => {
    const h = await buildTestAppWithRepos();
    const maker = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);

    const { id } = await mixedBatch(h, maker, "orgid");
    expect((await h.deps.proposals.get(id))?.orgId).toBeNull();

    const listed = (await h.app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(checker) })).json();
    const row = listed.find((p: { id: string }) => p.id === id);
    expect(Object.prototype.hasOwnProperty.call(row, "orgId")).toBe(true);
    expect(row.orgId).toBeNull();
  });
});
