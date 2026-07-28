import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { auth, buildTestApp, loginAs, onboardUser, V1 } from "./helpers.js";

/** Create a fresh credential use case (unique key) and return its key. */
async function createCredUC(app: FastifyInstance, token: string, key: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: `${V1}/credential-use-cases`,
    headers: auth(token),
    payload: {
      key,
      name: key,
      description: "d",
      credentialTypes: [{ name: "T", title: "T", validityDays: 365, claimSchema: { type: "object", required: ["a"], properties: { a: { type: "string" } } }, requiredApprovals: 1 }],
      issuer: { kind: "platform" },
      holderPolicy: { who: "any-onboarded" },
      verifier: { kind: "any" },
    },
  });
  if (r.statusCode !== 201) throw new Error(`createCredUC(${key}) failed: ${r.statusCode} ${r.body}`);
  return key;
}

describe("cross-type use-case key uniqueness", () => {
  it("rejects a credential use case whose key is an existing tokenization use case", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const list = await app.inject({ method: "GET", url: `${V1}/use-cases`, headers: auth(admin) });
    expect(list.statusCode).toBe(200);
    const seeded = (list.json() as { key: string }[])[0];
    expect(seeded?.key).toBeTruthy();

    const r = await app.inject({
      method: "POST",
      url: `${V1}/credential-use-cases`,
      headers: auth(admin),
      payload: {
        key: seeded.key,
        name: "clash",
        description: "d",
        credentialTypes: [{ name: "T", title: "T", claimSchema: { type: "object", required: ["a"], properties: { a: { type: "string" } } }, requiredApprovals: 1 }],
        issuer: { kind: "platform" },
        holderPolicy: { who: "any-onboarded" },
        verifier: { kind: "any" },
      },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("KEY_TAKEN");
  });
});

describe("GET /me reports useCaseDomain", () => {
  it("has a useCaseDomain property for a platform admin (unscoped -> null)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const me = await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(admin) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toHaveProperty("useCaseDomain");
    expect(me.json().useCaseDomain).toBeNull();
  });
});

describe("onboarding credential-desk users", () => {
  it("onboards a UseCaseAdmin scoped to a fresh credential use case; GET /me reports role + identity domain", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await createCredUC(app, admin, "desk-uca");

    const res = await app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(admin),
      payload: { email: "desk.uca@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: key },
    });
    expect(res.statusCode).toBe(202);
    const proposalId = res.json().proposal.id;
    const ap = await app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(admin2), payload: {} });
    expect(ap.statusCode).toBe(200);

    const login = await loginAs(app, "desk.uca@x.dev", "secret1");
    const me = await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(login) });
    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe("UseCaseAdmin");
    expect(me.json().useCaseDomain).toBe("identity");
  });

  it("rejects onboarding a Buyer into a credential use case (400 ROLE_DOMAIN_MISMATCH)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const key = await createCredUC(app, admin, "desk-buyer-reject");

    const res = await app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(admin),
      payload: { email: "desk.buyer@x.dev", password: "secret1", role: "Buyer", useCaseKey: key },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("ROLE_DOMAIN_MISMATCH");
  });

  it("a SCOPED identity UseCaseAdmin (no useCaseKey in body) onboards a Holder into their own credential use case", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await createCredUC(app, admin, "desk-scoped-uca");

    // Onboard the identity UseCaseAdmin themselves first.
    const ucaRes = await app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(admin),
      payload: { email: "desk.scoped.uca@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: key },
    });
    expect(ucaRes.statusCode).toBe(202);
    const ucaApprove = await app.inject({ method: "POST", url: `${V1}/proposals/${ucaRes.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    expect(ucaApprove.statusCode).toBe(200);
    const ucaToken = await loginAs(app, "desk.scoped.uca@x.dev", "secret1");

    // The scoped UseCaseAdmin onboards a Holder WITHOUT passing useCaseKey — the
    // route resolves targetUseCaseKey = claims.useCaseKey (their own identity UC),
    // so the domain must resolve from that effective key, not the (absent) body field.
    const holder = await onboardUser(app, ucaToken, admin, { email: "desk.holder@x.dev", password: "secret1", role: "Holder" });
    expect(holder.useCaseKey).toBe(key);

    const holderLogin = await loginAs(app, "desk.holder@x.dev", "secret1");
    const me = await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(holderLogin) });
    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe("Holder");
    expect(me.json().useCaseDomain).toBe("identity");
  });

  it("(sanity) accepts onboarding an Issuer into a credential use case (202, not rejected)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const key = await createCredUC(app, admin, "desk-issuer-ok");

    const res = await app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(admin),
      payload: { email: "desk.issuer@x.dev", password: "secret1", role: "Issuer", useCaseKey: key },
    });
    expect(res.statusCode).toBe(202);
  });
});

describe("scoped desk issuance", () => {
  it("a scoped Issuer may read eligible-holders and issue in their own use case, but is 403 in another", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const keyA = await createCredUC(app, admin, "uc-a");
    const keyB = await createCredUC(app, admin, "uc-b");

    // Onboard an Issuer scoped to uc-a only.
    await onboardUser(app, admin, admin2, { email: "desk.scoped.issuer@x.dev", password: "secret1", role: "Issuer", useCaseKey: keyA });
    const issuerToken = await loginAs(app, "desk.scoped.issuer@x.dev", "secret1");

    // Onboard a holder eligible for uc-a so eligible-holders returns a subject.
    await onboardUser(app, admin, admin2, { email: "desk.uc-a.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: keyA });

    const holders = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/${keyA}/eligible-holders`, headers: auth(issuerToken) });
    expect(holders.statusCode).toBe(200);
    const subject = (holders.json() as { kind: "user" | "org"; id: string }[])[0];
    expect(subject).toBeTruthy();
    const subjectRef = subject.kind === "user" ? { subjectUserId: subject.id } : { subjectOrgId: subject.id };

    const issue = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${keyA}/credentials`, headers: auth(issuerToken),
      payload: { credentialType: "T", ...subjectRef, claims: { a: "x" } },
    });
    expect(issue.statusCode).toBe(202);

    // Not scoped to uc-b: issuing there must be forbidden.
    const issueOther = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${keyB}/credentials`, headers: auth(issuerToken),
      payload: { credentialType: "T", ...subjectRef, claims: { a: "x" } },
    });
    expect(issueOther.statusCode).toBe(403);
  });
});
