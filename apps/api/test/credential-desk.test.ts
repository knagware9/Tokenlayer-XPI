import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";
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

  it("the LOGIN response (not just /me) carries useCaseDomain=identity for a credential-desk UseCaseAdmin", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await createCredUC(app, admin, "desk-login-domain");

    const res = await app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(admin),
      payload: { email: "desk.login@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: key },
    });
    expect(res.statusCode).toBe(202);
    const ap = await app.inject({ method: "POST", url: `${V1}/proposals/${res.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    expect(ap.statusCode).toBe(200);

    // The web app populates SessionUser from the login response, not /me — so the
    // domain must be on the login body's `user` too.
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "desk.login@x.dev", password: "secret1" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.useCaseDomain).toBe("identity");
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

describe("scoped verifier", () => {
  // A registry is required so the platform issuer's DID resolves as
  // registered+active on-chain (the trust path the verify route feeds), exactly
  // as in verification.test.ts / credential-usecase-verify.test.ts. Without it,
  // trust falls back to the empty trustedKycIssuers allowlist and no verify can
  // ever be positive.
  async function loginWithDid(app: FastifyInstance, email: string, password: string): Promise<{ token: string; did: string }> {
    const res = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email, password } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; user: { did: string | null } };
    return { token: body.token, did: body.user.did! };
  }

  it("a Verifier scoped to a credential use case drives request→consent→verify to a positive result", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const keyA = await createCredUC(app, admin, "verif-uc-a");

    // A Verifier scoped to uc-a (authorized purely by role + useCaseKey).
    await onboardUser(app, admin, admin2, { email: "verif.a@x.dev", password: "secret1", role: "Verifier", useCaseKey: keyA });
    const verifierA = await loginAs(app, "verif.a@x.dev", "secret1");

    // A Holder scoped to uc-a — onboarding mints a custodial DID so they can sign a VP.
    const holderSummary = await onboardUser(app, admin, admin2, { email: "verif.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: keyA });
    const holder = await loginWithDid(app, "verif.holder@x.dev", "secret1");

    // Issue+approve a uc-a credential to the holder (platform issuer; PlatformAdmin issues, second approves).
    const issued = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${keyA}/credentials`, headers: auth(admin),
      payload: { credentialType: "T", subjectUserId: holderSummary.id, claims: { a: "x" } },
    });
    expect(issued.statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: `${V1}/proposals/${issued.json().proposal.id}/approve`, headers: auth(admin2), payload: {} })).statusCode).toBe(200);
    const held = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holder.token) })).json() as { id: string; type: string[] }[];
    const credentialId = held.find((c) => c.type.includes("T"))!.id;

    // The scoped Verifier requests a presentation of the use case's type.
    const created = await app.inject({
      method: "POST", url: `${V1}/verification-requests`, headers: auth(verifierA),
      payload: { holderDid: holder.did, requestedTypes: ["T"], purpose: "desk check", credentialUseCaseKey: keyA },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().credentialUseCaseKey).toBe(keyA);
    const requestId = created.json().id as string;

    // Holder consents (signs their own VP).
    const consented = await app.inject({ method: "POST", url: `${V1}/verification-requests/${requestId}/consent`, headers: auth(holder.token), payload: { credentialIds: [credentialId] } });
    expect(consented.statusCode).toBe(200);

    // The scoped Verifier runs verify → positive.
    const verified = await app.inject({ method: "GET", url: `${V1}/verification-requests/${requestId}/verify`, headers: auth(verifierA) });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().valid).toBe(true);
    expect(verified.json().credentials[0].type).toBe("T");
    expect(verified.json().credentials[0].valid).toBe(true);
  });

  it("a Verifier scoped to a DIFFERENT use case may not request against another use case", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const keyA = await createCredUC(app, admin, "verif-uc-a2");
    const keyB = await createCredUC(app, admin, "verif-uc-b2");

    // A Verifier scoped to uc-b tries to request against uc-a.
    await onboardUser(app, admin, admin2, { email: "verif.b@x.dev", password: "secret1", role: "Verifier", useCaseKey: keyB });
    const verifierB = await loginAs(app, "verif.b@x.dev", "secret1");

    const denied = await app.inject({
      method: "POST", url: `${V1}/verification-requests`, headers: auth(verifierB),
      payload: { holderDid: "did:key:zHolder", requestedTypes: ["T"], purpose: "desk check", credentialUseCaseKey: keyA },
    });
    expect([403, 404]).toContain(denied.statusCode);
  });

  it("a scoped Verifier's outbound list holds its own use case's requests and no other desk's", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const keyA = await createCredUC(app, admin, "verif-uc-a3");
    const keyB = await createCredUC(app, admin, "verif-uc-b3");

    await onboardUser(app, admin, admin2, { email: "list.a@x.dev", password: "secret1", role: "Verifier", useCaseKey: keyA });
    await onboardUser(app, admin, admin2, { email: "list.b@x.dev", password: "secret1", role: "Verifier", useCaseKey: keyB });
    const deskA = await loginAs(app, "list.a@x.dev", "secret1");
    const deskB = await loginAs(app, "list.b@x.dev", "secret1");

    const created = await app.inject({
      method: "POST", url: `${V1}/verification-requests`, headers: auth(deskA),
      payload: { holderDid: "did:key:zHolder", requestedTypes: ["T"], purpose: "desk list", credentialUseCaseKey: keyA },
    });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().id as string;
    // An org-less desk stores verifierOrgId "" — the case that would collide if
    // the list were scoped by org id rather than by the use case binding.
    expect(created.json().verifierOrgId).toBe("");

    const list = (token: string) => app.inject({ method: "GET", url: `${V1}/verification-requests`, headers: auth(token) });
    // A fresh session, i.e. the desk operator has closed the tab and come back.
    const reloaded = await loginAs(app, "list.a@x.dev", "secret1");
    const mine = (await list(reloaded)).json() as { id: string; credentialUseCaseKey: string }[];
    expect(mine.some((r) => r.id === requestId)).toBe(true);
    expect(mine.every((r) => r.credentialUseCaseKey === keyA)).toBe(true);

    // The neighbouring desk sees nothing of it, in the list or per-id.
    expect(((await list(deskB)).json() as { id: string }[]).some((r) => r.id === requestId)).toBe(false);
    expect((await app.inject({ method: "GET", url: `${V1}/verification-requests/${requestId}`, headers: auth(deskB) })).statusCode).toBe(404);
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

  it("the proposing Issuer can now see their own issuance proposal, but still cannot decide it", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await createCredUC(app, admin, "uc-own-view");

    await onboardUser(app, admin, admin2, { email: "desk.ownview.issuer@x.dev", password: "secret1", role: "Issuer", useCaseKey: key });
    const issuerToken = await loginAs(app, "desk.ownview.issuer@x.dev", "secret1");
    await onboardUser(app, admin, admin2, { email: "desk.ownview.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: key });

    const holders = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/${key}/eligible-holders`, headers: auth(issuerToken) });
    const subject = (holders.json() as { kind: "user" | "org"; id: string }[])[0]!;

    const issue = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/credentials`, headers: auth(issuerToken),
      payload: { credentialType: "T", subjectUserId: subject.id, claims: { a: "x" } },
    });
    expect(issue.statusCode).toBe(202);
    const proposalId = issue.json().proposal.id as string;

    // Before this widening the Issuer's own proposal was silently absent from
    // this list — indistinguishable from one that never existed — because the
    // index narrowing (useCaseKey/orgId) never reached an org-scoped
    // credential proposal for a proposer who belongs to neither.
    const list = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(issuerToken) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { id: string }[]).map((p) => p.id)).toContain(proposalId);

    // Still cannot decide their own — SELF_APPROVAL, not the approve-audience
    // check, since visibility alone never granted decide rights.
    const selfApprove = await app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(issuerToken), payload: {} });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().error).toBe("SELF_APPROVAL");

    // A real checker still completes it normally.
    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(admin2), payload: {} });
    expect(approve.statusCode).toBe(200);
  });

  it("eligible-holders is scoped to holders onboarded under THIS use case, not every DID on the platform", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const keyA = await createCredUC(app, admin, "roster-uc-a");
    const keyB = await createCredUC(app, admin, "roster-uc-b");

    await onboardUser(app, admin, admin2, { email: "roster.a.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: keyA });
    await onboardUser(app, admin, admin2, { email: "roster.b.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: keyB });

    const rowsA = (await app.inject({ method: "GET", url: `${V1}/credential-use-cases/${keyA}/eligible-holders`, headers: auth(admin) }))
      .json() as { kind: string; label: string }[];
    const labelsA = rowsA.filter((r) => r.kind === "user").map((r) => r.label);
    expect(labelsA).toContain("roster.a.holder@x.dev");
    // The other use case's holder must NOT leak into this roster, even though
    // both use cases have "any-onboarded" — that policy means "any org type",
    // never "every DID-holding account regardless of which desk onboarded them".
    expect(labelsA).not.toContain("roster.b.holder@x.dev");
  });
});

describe("UseCaseAdmin adds a credential type to their own use case", () => {
  it("the UseCaseAdmin of THIS use case can append a new credential type, additively", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await createCredUC(app, admin, "addtype-uc");
    await onboardUser(app, admin, admin2, { email: "addtype.admin@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: key });
    const ucAdminToken = await loginAs(app, "addtype.admin@x.dev", "secret1");

    const add = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/credential-types`, headers: auth(ucAdminToken),
      payload: { name: "SecondType", title: "Second Type", validityDays: 180, requiredApprovals: 1,
        claimSchema: { type: "object", required: ["b"], properties: { b: { type: "string" } } } },
    });
    expect(add.statusCode).toBe(200);
    const types = (add.json() as { credentialTypes: { name: string }[] }).credentialTypes.map((t) => t.name);
    // Additive: the ORIGINAL type ("T", from createCredUC) survives untouched.
    expect(types).toEqual(["T", "SecondType"]);

    // Persisted, not just echoed back.
    const reread = await app.inject({ method: "GET", url: `${V1}/credential-use-cases/${key}`, headers: auth(admin) });
    expect((reread.json() as { credentialTypes: { name: string }[] }).credentialTypes.map((t) => t.name)).toEqual(["T", "SecondType"]);
  });

  it("rejects a duplicate name (409), and refuses a UseCaseAdmin scoped to a DIFFERENT use case (403)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const keyA = await createCredUC(app, admin, "addtype-uc-a");
    const keyB = await createCredUC(app, admin, "addtype-uc-b");
    await onboardUser(app, admin, admin2, { email: "addtype.a.admin@x.dev", password: "secret1", role: "UseCaseAdmin", useCaseKey: keyA });
    const ucAdminA = await loginAs(app, "addtype.a.admin@x.dev", "secret1");

    const dup = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${keyA}/credential-types`, headers: auth(ucAdminA),
      payload: { name: "T", title: "dup", validityDays: 180, requiredApprovals: 1,
        claimSchema: { type: "object", required: [], properties: {} } },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("TYPE_EXISTS");

    const wrongDesk = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${keyB}/credential-types`, headers: auth(ucAdminA),
      payload: { name: "NewType", title: "new", validityDays: 180, requiredApprovals: 1,
        claimSchema: { type: "object", required: [], properties: {} } },
    });
    expect(wrongDesk.statusCode).toBe(403);
  });

  it("an Issuer (not UseCaseAdmin) at the same desk cannot add a credential type", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const key = await createCredUC(app, admin, "addtype-issuer-uc");
    await onboardUser(app, admin, admin2, { email: "addtype.issuer@x.dev", password: "secret1", role: "Issuer", useCaseKey: key });
    const issuerToken = await loginAs(app, "addtype.issuer@x.dev", "secret1");

    const res = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${key}/credential-types`, headers: auth(issuerToken),
      payload: { name: "NewType", title: "new", validityDays: 180, requiredApprovals: 1,
        claimSchema: { type: "object", required: [], properties: {} } },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("scoped desk revoke", () => {
  it("a scoped Issuer for a credential use case CAN revoke a credential of that use case", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const keyA = await createCredUC(app, admin, "revoke-uc-a");

    // Onboard an Issuer scoped to uc-a only.
    await onboardUser(app, admin, admin2, { email: "desk.revoke.issuer@x.dev", password: "secret1", role: "Issuer", useCaseKey: keyA });
    const issuerToken = await loginAs(app, "desk.revoke.issuer@x.dev", "secret1");

    // Onboard a holder eligible for uc-a (onboarding mints a custodial DID).
    const holder = await onboardUser(app, admin, admin2, { email: "desk.revoke.holder@x.dev", password: "secret1", role: "Holder", useCaseKey: keyA });

    // Issue + approve a uc-a credential to the holder (scoped Issuer proposes, a PlatformAdmin approves).
    const issue = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${keyA}/credentials`, headers: auth(issuerToken),
      payload: { credentialType: "T", subjectUserId: holder.id, claims: { a: "x" } },
    });
    expect(issue.statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: `${V1}/proposals/${issue.json().proposal.id}/approve`, headers: auth(admin2), payload: {} })).statusCode).toBe(200);

    const holderToken = await loginAs(app, "desk.revoke.holder@x.dev", "secret1");
    const held = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holderToken) })).json() as { id: string; type: string[] }[];
    const credentialId = held.find((c) => c.type.includes("T"))!.id;

    // The scoped Issuer (not the signing platform org's OrgAdmin) revokes the
    // credential of THEIR OWN use case — same 202-proposal / approve-200 contract
    // as the platform-org revoke path in credential-usecase-verify.test.ts.
    const revoke = await app.inject({
      method: "POST", url: `${V1}/credentials/${credentialId}/revoke`, headers: auth(issuerToken),
      payload: { reason: "scoped desk revoke" },
    });
    expect(revoke.statusCode).toBe(202);
    const approve = await app.inject({ method: "POST", url: `${V1}/proposals/${revoke.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    expect(approve.statusCode).toBe(200);

    const status = await app.inject({ method: "GET", url: `${V1}/credentials/${credentialId}/status` });
    expect(status.json().revoked).toBe(true);
  });

  it("a desk user scoped to a DIFFERENT credential use case CANNOT revoke it (403)", async () => {
    const app = await buildTestApp();
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const keyA = await createCredUC(app, admin, "revoke-uc-a2");
    const keyB = await createCredUC(app, admin, "revoke-uc-b2");

    // Onboard a holder eligible for uc-a and issue+approve a uc-a credential (platform admin issues).
    const holder = await onboardUser(app, admin, admin2, { email: "desk.revoke.holder2@x.dev", password: "secret1", role: "Holder", useCaseKey: keyA });
    const issue = await app.inject({
      method: "POST", url: `${V1}/credential-use-cases/${keyA}/credentials`, headers: auth(admin),
      payload: { credentialType: "T", subjectUserId: holder.id, claims: { a: "x" } },
    });
    expect(issue.statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: `${V1}/proposals/${issue.json().proposal.id}/approve`, headers: auth(admin2), payload: {} })).statusCode).toBe(200);

    const holderToken = await loginAs(app, "desk.revoke.holder2@x.dev", "secret1");
    const held = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(holderToken) })).json() as { id: string; type: string[] }[];
    const credentialId = held.find((c) => c.type.includes("T"))!.id;

    // A desk operator scoped to uc-b (a different credential use case) must not
    // be admitted as a revoker of a uc-a credential.
    await onboardUser(app, admin, admin2, { email: "desk.revoke.issuer.b@x.dev", password: "secret1", role: "Issuer", useCaseKey: keyB });
    const issuerBToken = await loginAs(app, "desk.revoke.issuer.b@x.dev", "secret1");

    const revoke = await app.inject({
      method: "POST", url: `${V1}/credentials/${credentialId}/revoke`, headers: auth(issuerBToken),
      payload: { reason: "should be forbidden" },
    });
    expect(revoke.statusCode).toBe(403);
  });
});
