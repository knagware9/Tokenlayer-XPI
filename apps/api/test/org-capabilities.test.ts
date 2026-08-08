import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { MemoryOrganizationRepository } from "../src/persistence/memory.js";
import { auth, buildTestApp, loginAs, onboardUser, V1 } from "./helpers.js";

describe("Organization.capabilities persistence (EN-A task A2)", () => {
  it("create stores an explicit envelope; setCapabilities replaces it; null round-trips", async () => {
    const repo = new MemoryOrganizationRepository();
    const base = {
      name: "Caps Org",
      orgType: "corporate" as const,
      registrationId: null,
      jurisdiction: null,
      did: "did:key:zCaps",
      didSeedEncrypted: "enc",
      status: "active" as const,
      verified: false,
      verifiedAt: null,
      companyProfile: null,
      capabilities: { domains: ["identity" as const], roles: ["Issuer" as const] },
    };
    const o = await repo.create(base);
    expect(o.capabilities).toEqual({ domains: ["identity"], roles: ["Issuer"] });

    // Replace with an all-empty envelope — "everything off" is distinct from null.
    const tightened = await repo.setCapabilities(o.id, { domains: [], roles: [] });
    expect(tightened.capabilities).toEqual({ domains: [], roles: [] });

    // Clearing back to null restores the unrestricted-legacy sentinel.
    const cleared = await repo.setCapabilities(o.id, null);
    expect(cleared.capabilities).toBeNull();
  });
});

// --- shared corporate-signup fixtures (used by the A3 + A4 describes) -------

const PDF = Buffer.from("%PDF-1.4 fake cin certificate").toString("base64");

interface RegOpts { name: string; cin: string; email: string; capabilities?: unknown }

/** Upload a KYB doc then self-register an org (optionally with a capability envelope). */
async function registerOrg(app: FastifyInstance, opts: RegOpts) {
  const up = await app.inject({ method: "POST", url: `${V1}/orgs/register/documents`, payload: { contentType: "application/pdf", dataBase64: PDF } });
  expect(up.statusCode).toBe(201);
  return app.inject({
    method: "POST", url: `${V1}/orgs/register`,
    payload: {
      company: {
        name: opts.name, orgType: "corporate", cin: opts.cin, pan: "AABCU9603R",
        state: "Maharashtra", pincode: "400001", dateOfIncorporation: "2020-06-15",
        category: "private-limited", companyStatus: "active",
        documents: { cinCertificate: { id: (up.json() as { id: string }).id } },
      },
      admin: { name: "Caps Admin", email: opts.email, password: "corp-secret-1" },
      ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    },
  });
}

/** register → PlatformAdmin approve → OrgAdmin login. */
async function approvedOrg(app: FastifyInstance, platform: string, opts: RegOpts) {
  const res = await registerOrg(app, opts);
  expect(res.statusCode).toBe(202);
  const orgId = res.json().organizationId as string;
  const appr = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
  expect(appr.statusCode).toBe(200);
  return { orgId, adminTok: await loginAs(app, opts.email, "corp-secret-1") };
}

const getOrg = async (app: FastifyInstance, token: string, id: string) =>
  (await app.inject({ method: "GET", url: `${V1}/orgs/${id}`, headers: { authorization: `Bearer ${token}` } })).json();

describe("capability acquisition (EN-A task A3)", () => {
  const ENVELOPE = { domains: ["identity"], roles: ["Issuer", "Verifier"] };

  it("register WITH capabilities → pending org stores them; approval carries them into the active org", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await registerOrg(app, { name: "Caps One", cin: "U11111MH2020PTC111111", email: "caps1@x.dev", capabilities: ENVELOPE });
    expect(res.statusCode).toBe(202);
    const orgId = res.json().organizationId as string;
    // The requested envelope is part of what the reviewer sees on the pending org.
    const pending = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json()
      .find((o: { id: string }) => o.id === orgId);
    expect(pending.capabilities).toEqual(ENVELOPE);
    const appr = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.statusCode).toBe(200);
    // Active org still carries the envelope, in both the get and list views.
    expect((await getOrg(app, platform, orgId)).capabilities).toEqual(ENVELOPE);
    const listed = (await app.inject({ method: "GET", url: `${V1}/orgs`, headers: { authorization: `Bearer ${platform}` } })).json()
      .find((o: { id: string }) => o.id === orgId);
    expect(listed.capabilities).toEqual(ENVELOPE);
  });

  it("register WITHOUT capabilities → null (unrestricted legacy; old clients unaffected)", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const res = await registerOrg(app, { name: "Legacy One", cin: "U22222MH2020PTC222222", email: "legacy1@x.dev" });
    expect(res.statusCode).toBe(202);
    const pending = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json()
      .find((o: { id: string }) => o.id === res.json().organizationId);
    expect(pending.capabilities).toBeNull();
  });

  it("register with an unknown domain → 400 INVALID_CAPABILITIES (nothing created)", async () => {
    const app = await buildTestApp();
    const res = await registerOrg(app, {
      name: "Bad Caps", cin: "U33333MH2020PTC333333", email: "bad@x.dev",
      capabilities: { domains: ["defi"], roles: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_CAPABILITIES");
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const pending = (await app.inject({ method: "GET", url: `${V1}/orgs?status=pending`, headers: { authorization: `Bearer ${platform}` } })).json();
    expect(pending.some((o: { name: string }) => o.name === "Bad Caps")).toBe(false);
  });

  it("PATCH /orgs/:id/capabilities: PlatformAdmin sets (and clears) directly; an OrgAdmin gets 403", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const { orgId, adminTok } = await approvedOrg(app, platform, { name: "Patch Co", cin: "U44444MH2020PTC444444", email: "patch@x.dev" });
    const set = await app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/capabilities`, headers: { authorization: `Bearer ${platform}` }, payload: { capabilities: ENVELOPE } });
    expect(set.statusCode).toBe(200);
    expect(set.json().capabilities).toEqual(ENVELOPE);
    expect((await getOrg(app, platform, orgId)).capabilities).toEqual(ENVELOPE);
    // null clears back to the unrestricted legacy envelope (PlatformAdmin only, deliberate).
    const clear = await app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/capabilities`, headers: { authorization: `Bearer ${platform}` }, payload: { capabilities: null } });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().capabilities).toBeNull();
    const asOrgAdmin = await app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/capabilities`, headers: { authorization: `Bearer ${adminTok}` }, payload: { capabilities: ENVELOPE } });
    expect(asOrgAdmin.statusCode).toBe(403);
  });

  it("change request: own OrgAdmin 202 → PlatformAdmin approves → applied; foreign OrgAdmin 403; proposer cannot approve", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const a = await approvedOrg(app, platform, { name: "Req A", cin: "U55555MH2020PTC555555", email: "req-a@x.dev" });
    const b = await approvedOrg(app, platform, { name: "Req B", cin: "U66666MH2020PTC666666", email: "req-b@x.dev" });
    const wanted = { domains: ["identity", "tokenization"], roles: ["Issuer", "Holder"] };
    // A foreign OrgAdmin may not request changes for org A.
    const foreign = await app.inject({ method: "POST", url: `${V1}/orgs/${a.orgId}/capabilities/request`, headers: { authorization: `Bearer ${b.adminTok}` }, payload: { capabilities: wanted } });
    expect(foreign.statusCode).toBe(403);
    // A's own OrgAdmin: 202 with the new proposal kind.
    const req = await app.inject({ method: "POST", url: `${V1}/orgs/${a.orgId}/capabilities/request`, headers: { authorization: `Bearer ${a.adminTok}` }, payload: { capabilities: wanted } });
    expect(req.statusCode).toBe(202);
    expect(req.json().proposal.kind).toBe("org-capability-change");
    const pid = req.json().proposal.id as string;
    // The proposing OrgAdmin cannot decide their own request.
    const self = await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: { authorization: `Bearer ${a.adminTok}` }, payload: {} });
    expect(self.statusCode).toBe(403);
    // Envelope unchanged until the platform decides.
    expect((await getOrg(app, platform, a.orgId)).capabilities).toBeNull();
    const appr = await app.inject({ method: "POST", url: `${V1}/proposals/${pid}/approve`, headers: { authorization: `Bearer ${platform}` }, payload: {} });
    expect(appr.statusCode).toBe(200);
    expect(appr.json().proposal.status).toBe("executed");
    expect((await getOrg(app, platform, a.orgId)).capabilities).toEqual(wanted);
  });

  it("login threads orgCapabilities: an enveloped org's OrgAdmin carries it; a PlatformAdmin gets null", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    await approvedOrg(app, platform, { name: "Sess Co", cin: "U77777MH2020PTC777777", email: "sess@x.dev", capabilities: ENVELOPE });
    const login = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "sess@x.dev", password: "corp-secret-1" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.orgCapabilities).toEqual(ENVELOPE);
    const adminLogin = await app.inject({ method: "POST", url: `${V1}/auth/login`, payload: { email: "admin@tokenlayer.dev", password: "admin123" } });
    expect(adminLogin.json().user.orgCapabilities).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A4 — the envelope BITES: enforcement at the eight org-action gates. Every
// check is null-tolerant (a legacy org passes everything), so each negative
// 403 ORG_CAPABILITY_MISSING is paired with a positive (in-envelope or legacy).
// ---------------------------------------------------------------------------
describe("capability enforcement (EN-A task A4)", () => {
  /** Identity-domain envelope with ONLY the Issuer role. */
  const ID_ISSUER = { domains: ["identity"], roles: ["Issuer"] };
  /** Tokenization-only envelope with every operating role. */
  const TOK_FULL = { domains: ["tokenization"], roles: ["Issuer", "Holder", "Verifier"] };

  const KYC_TYPE = {
    name: "KycCredential", title: "KYC", validityDays: 365, requiredApprovals: 1,
    claimSchema: { type: "object", required: ["legalName", "country"], properties: { legalName: { type: "string" }, country: { type: "string", pattern: "^[A-Z]{2}$" } } },
  };
  /** A minimal valid credential-use-case definition (platform issuer, open holder/verifier). */
  const CUC = (key: string, over: Record<string, unknown> = {}) => ({
    key, name: `UC ${key}`, credentialTypes: [KYC_TYPE],
    issuer: { kind: "platform" }, holderPolicy: { who: "any-onboarded" }, verifier: { kind: "any" },
    ...over,
  });
  /** A complete, schema-valid TOKENIZATION definition deployable in the test app (fabric). */
  const TOK_DEF = (key: string) => ({
    key, name: `Notes ${key}`, symbol: "NTS", tokenStandard: "ERC-20",
    allowedChainIds: ["fabric"], defaultChainId: "fabric",
    metadataSchema: { type: "object", properties: {} },
    lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
    compliance: { allowlist: true, transferRestrictions: false },
    roles: ["UseCaseAdmin", "Issuer"],
  });

  let n = 0;
  /** register+approve an org with the given envelope (omit for a legacy null org). */
  async function envOrg(app: FastifyInstance, platform: string, capabilities?: unknown) {
    n += 1;
    const made = await approvedOrg(app, platform, {
      name: `Enforce Co ${n}`, cin: `ENF-CIN-${n}`, email: `enf-${n}@x.dev`,
      ...(capabilities !== undefined ? { capabilities } : {}),
    });
    return { ...made, name: `Enforce Co ${n}` };
  }

  function expectMissing(res: { statusCode: number; json: () => { error: string; details?: unknown } }, orgId: string, missing: string) {
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("ORG_CAPABILITY_MISSING");
    expect(res.json().details).toEqual({ orgId, missing });
  }

  it("gate 1 — issuer binding at config time: identity Issuer binds ok; tokenization-only org 403 (identity); role-less identity org 403 (Issuer)", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const good = await envOrg(app, platform, ID_ISSUER);
    const tok = await envOrg(app, platform, TOK_FULL);
    const holderOnly = await envOrg(app, platform, { domains: ["identity"], roles: ["Holder"] });

    const ok = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("bind-ok", { issuer: { kind: "org", orgId: good.orgId } }) });
    expect(ok.statusCode).toBe(201);

    const wrongDomain = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("bind-dom", { issuer: { kind: "org", orgId: tok.orgId } }) });
    expectMissing(wrongDomain, tok.orgId, "identity");

    const wrongRole = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("bind-role", { issuer: { kind: "org", orgId: holderOnly.orgId } }) });
    expectMissing(wrongRole, holderOnly.orgId, "Issuer");
  });

  it("gate 2 — issue-time defense in depth: bind while allowed → platform tightens → issuing now 403", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const capped = await envOrg(app, platform, ID_ISSUER);

    const made = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("did-uc", { issuer: { kind: "org", orgId: capped.orgId } }) });
    expect(made.statusCode).toBe(201);
    const subject = await onboardUser(app, platform, checker, {
      email: "did-subj@x.dev", password: "secret1", role: "Buyer", useCaseKey: "invoice-tokenization",
      walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    });
    const issueBody = { credentialType: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Acme Ltd", country: "IN" } };

    // In-envelope: the bound org's OrgAdmin issues (202 proposal).
    const before = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/did-uc/credentials`, headers: auth(capped.adminTok), payload: issueBody });
    expect(before.statusCode).toBe(202);

    // The platform tightens the envelope (Issuer removed) — the binding predates it.
    const tighten = await app.inject({ method: "PATCH", url: `${V1}/orgs/${capped.orgId}/capabilities`, headers: auth(platform), payload: { capabilities: { domains: ["identity"], roles: [] } } });
    expect(tighten.statusCode).toBe(200);

    const after = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/did-uc/credentials`, headers: auth(capped.adminTok), payload: issueBody });
    expectMissing(after, capped.orgId, "Issuer");
  });

  it("gate 3 — verification request: org without Verifier 403; a capability change granting Verifier makes it succeed", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const capped = await envOrg(app, platform, ID_ISSUER);
    expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("verify-uc") })).statusCode).toBe(201);
    const reqBody = { holderDid: "did:key:z6MkExampleHolder", requestedTypes: ["KycCredential"], purpose: "kyc check", credentialUseCaseKey: "verify-uc" };

    const denied = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(capped.adminTok), payload: reqBody });
    expectMissing(denied, capped.orgId, "Verifier");

    // The org REQUESTS Verifier; the platform approves the org-capability-change.
    const ask = await app.inject({ method: "POST", url: `${V1}/orgs/${capped.orgId}/capabilities/request`, headers: auth(capped.adminTok), payload: { capabilities: { domains: ["identity"], roles: ["Issuer", "Verifier"] } } });
    expect(ask.statusCode).toBe(202);
    const appr = await app.inject({ method: "POST", url: `${V1}/proposals/${ask.json().proposal.id}/approve`, headers: auth(platform), payload: {} });
    expect(appr.statusCode).toBe(200);

    const granted = await app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(capped.adminTok), payload: reqBody });
    expect(granted.statusCode).toBe(201);
  });

  it("gate 4 — verifier binding at config time: listing a no-Verifier org 403; a legacy org lists fine", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const capped = await envOrg(app, platform, ID_ISSUER); // no Verifier role
    const legacy = await envOrg(app, platform);            // null envelope

    const denied = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("vb-bad", { verifier: { kind: "orgs", orgIds: [legacy.orgId, capped.orgId] } }) });
    expectMissing(denied, capped.orgId, "Verifier");

    const ok = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("vb-ok", { verifier: { kind: "orgs", orgIds: [legacy.orgId] } }) });
    expect(ok.statusCode).toBe(201);
  });

  it("gate 5 — org as holder (subjectOrgId): no-Holder org 403; legacy org 202", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const capped = await envOrg(app, platform, ID_ISSUER); // no Holder role
    const legacy = await envOrg(app, platform);
    expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("hold-uc") })).statusCode).toBe(201);
    const claims = { legalName: "Holdco", country: "IN" };

    const denied = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/hold-uc/credentials`, headers: auth(platform), payload: { credentialType: "KycCredential", subjectOrgId: capped.orgId, claims } });
    expectMissing(denied, capped.orgId, "Holder");

    const ok = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/hold-uc/credentials`, headers: auth(platform), payload: { credentialType: "KycCredential", subjectOrgId: legacy.orgId, claims } });
    expect(ok.statusCode).toBe(202);
  });

  it("gate 6 — org-owned tokenization use case: identity-only org 403 at draft; tokenization org drafts; tightening fails the pending proposal at execute", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const idOnly = await envOrg(app, platform, ID_ISSUER);
    const denied = await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(idOnly.adminTok), payload: TOK_DEF("cap-notes") });
    expectMissing(denied, idOnly.orgId, "tokenization");

    // In-envelope + legacy positives, then the executor's defense in depth:
    const tokOrg = await envOrg(app, platform, TOK_FULL);
    expect((await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(tokOrg.adminTok), payload: TOK_DEF("tok-notes") })).statusCode).toBe(202);
    const legacy = await envOrg(app, platform);
    const draft = await app.inject({ method: "POST", url: `${V1}/use-cases`, headers: auth(legacy.adminTok), payload: TOK_DEF("legacy-notes") });
    expect(draft.statusCode).toBe(202);
    // The envelope tightens while the proposal is pending — approval must FAIL it, not deploy.
    await app.inject({ method: "PATCH", url: `${V1}/orgs/${legacy.orgId}/capabilities`, headers: auth(platform), payload: { capabilities: ID_ISSUER } });
    const appr = await app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(platform), payload: {} });
    expect(appr.json().proposal.status).toBe("failed");
    const list = (await app.inject({ method: "GET", url: `${V1}/use-cases`, headers: auth(platform) })).json() as { key: string }[];
    expect(list.some((u) => u.key === "legacy-notes")).toBe(false);
  });

  it("gate 7 — org-owned identity use case: tokenization-only owner 403 (create AND provision); identity owner 201", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const tok = await envOrg(app, platform, TOK_FULL);
    const idOrg = await envOrg(app, platform, ID_ISSUER);

    const denied = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("own-bad", { ownerOrgId: tok.orgId }) });
    expectMissing(denied, tok.orgId, "identity");

    const ok = await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("own-ok", { ownerOrgId: idOrg.orgId }) });
    expect(ok.statusCode).toBe(201);

    // Provisioning binds the org as owner + issuer of an IDENTITY use case.
    const prov = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/provision`, headers: auth(tok.adminTok), payload: { templateKey: "education-certificate", params: { issuerOrgName: tok.name }, provisioning: { createDeskUsers: false } } });
    expectMissing(prov, tok.orgId, "identity");
  });

  it("gate 8 — member-add filter: in-envelope 201; out-of-role 403; out-of-domain 403; PlatformAdmin bypass 201; legacy org unrestricted 201", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("desk-uc") })).statusCode).toBe(201);
    const capped = await envOrg(app, platform, ID_ISSUER); // identity domain, Issuer role only
    const legacy = await envOrg(app, platform);
    const member = (over: Record<string, unknown>) => ({ email: `m-${++n}@x.dev`, password: "secret1", ...over });

    // In-envelope: an Issuer member scoped to an identity use case.
    const inEnv = await app.inject({ method: "POST", url: `${V1}/orgs/${capped.orgId}/users`, headers: auth(capped.adminTok), payload: member({ role: "Issuer", useCaseKey: "desk-uc" }) });
    expect(inEnv.statusCode).toBe(201);

    // Out-of-role: the envelope has no Verifier.
    const outRole = await app.inject({ method: "POST", url: `${V1}/orgs/${capped.orgId}/users`, headers: auth(capped.adminTok), payload: member({ role: "Verifier" }) });
    expectMissing(outRole, capped.orgId, "Verifier");

    // Out-of-domain: an in-envelope role scoped to a TOKENIZATION use case.
    const outDomain = await app.inject({ method: "POST", url: `${V1}/orgs/${capped.orgId}/users`, headers: auth(capped.adminTok), payload: member({ role: "Issuer", useCaseKey: "invoice-tokenization" }) });
    expectMissing(outDomain, capped.orgId, "tokenization");

    // PlatformAdmin bypasses the envelope entirely (platform override).
    const bypass = await app.inject({ method: "POST", url: `${V1}/orgs/${capped.orgId}/users`, headers: auth(platform), payload: member({ role: "Verifier" }) });
    expect(bypass.statusCode).toBe(201);

    // A legacy (null-envelope) org is unrestricted.
    const legacyAdd = await app.inject({ method: "POST", url: `${V1}/orgs/${legacy.orgId}/users`, headers: auth(legacy.adminTok), payload: member({ role: "Verifier", useCaseKey: "invoice-tokenization" }) });
    expect(legacyAdd.statusCode).toBe(201);
  });

  // --- gate 9 (review find): legacy closed-catalog issuance ----------------

  /** Add a Trader member (NOT an operating role, no use-case key — in-envelope
   *  even for a roles:[] org) so the org has a DID-bearing subject to name as
   *  its AuthorizedSignatory. */
  async function traderMember(app: FastifyInstance, orgId: string, adminTok: string): Promise<string> {
    const r = await app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/users`, headers: auth(adminTok), payload: { email: `sig-${++n}@x.dev`, password: "secret1", role: "Trader" } });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }
  const SIGNATORY = (subjectUserId: string) => ({ type: "AuthorizedSignatory", subjectUserId, claims: { role: "CFO", scope: "all" } });

  it("gate 9 — legacy catalog issuance (POST /credentials/requests): roles:[] org 403; legacy org 202", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const bare = await envOrg(app, platform, { domains: ["identity"], roles: [] });
    const legacy = await envOrg(app, platform);

    const denied = await app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(bare.adminTok), payload: SIGNATORY(await traderMember(app, bare.orgId, bare.adminTok)) });
    expectMissing(denied, bare.orgId, "Issuer");

    const ok = await app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(legacy.adminTok), payload: SIGNATORY(await traderMember(app, legacy.orgId, legacy.adminTok)) });
    expect(ok.statusCode).toBe(202);
  });

  it("gate 9 executor — catalog propose → tighten → the EXECUTING approval fails the proposal", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const admin2 = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const org = await envOrg(app, platform); // legacy (unrestricted) at propose time

    const prop = await app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(org.adminTok), payload: SIGNATORY(await traderMember(app, org.orgId, org.adminTok)) });
    expect(prop.statusCode).toBe(202); // AuthorizedSignatory: requiredApprovals 2

    await app.inject({ method: "PATCH", url: `${V1}/orgs/${org.orgId}/capabilities`, headers: auth(platform), payload: { capabilities: { domains: ["identity"], roles: [] } } });

    const first = await app.inject({ method: "POST", url: `${V1}/proposals/${prop.json().proposal.id}/approve`, headers: auth(platform), payload: {} });
    expect(first.json().proposal.status).toBe("pending"); // 1 of 2 — nothing executed yet
    const second = await app.inject({ method: "POST", url: `${V1}/proposals/${prop.json().proposal.id}/approve`, headers: auth(admin2), payload: {} });
    expect(second.json().proposal.status).toBe("failed"); // executor re-check bites
  });

  it("gate 2 executor — use-case issuance propose → tighten → approval fails instead of issuing", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const capped = await envOrg(app, platform, ID_ISSUER);
    expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("exec-uc", { issuer: { kind: "org", orgId: capped.orgId } }) })).statusCode).toBe(201);
    const subject = await onboardUser(app, platform, checker, { email: `exec-subj-${++n}@x.dev`, password: "secret1", role: "Buyer", useCaseKey: "invoice-tokenization", walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });

    const prop = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/exec-uc/credentials`, headers: auth(capped.adminTok), payload: { credentialType: "KycCredential", subjectUserId: subject.id, claims: { legalName: "Acme Ltd", country: "IN" } } });
    expect(prop.statusCode).toBe(202);

    await app.inject({ method: "PATCH", url: `${V1}/orgs/${capped.orgId}/capabilities`, headers: auth(platform), payload: { capabilities: { domains: ["identity"], roles: [] } } });

    const appr = await app.inject({ method: "POST", url: `${V1}/proposals/${prop.json().proposal.id}/approve`, headers: auth(platform), payload: {} });
    expect(appr.json().proposal.status).toBe("failed");
  });

  it("gate 2 executor (batch) — batch draft → tighten → approval fails the WHOLE batch (config-level, no per-row rows)", async () => {
    const app = await buildTestApp();
    const platform = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const checker = await loginAs(app, "admin2@tokenlayer.dev", "admin123");
    const capped = await envOrg(app, platform, ID_ISSUER);
    expect((await app.inject({ method: "POST", url: `${V1}/credential-use-cases`, headers: auth(platform), payload: CUC("batch-uc", { issuer: { kind: "org", orgId: capped.orgId } }) })).statusCode).toBe(201);
    const subject = await onboardUser(app, platform, checker, { email: `batch-subj-${++n}@x.dev`, password: "secret1", role: "Buyer", useCaseKey: "invoice-tokenization", walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" });

    const draft = await app.inject({ method: "POST", url: `${V1}/credential-use-cases/batch-uc/credentials/batch`, headers: auth(capped.adminTok), payload: { credentialType: "KycCredential", rows: [{ subjectEmail: subject.email, claims: { legalName: "Acme Ltd", country: "IN" } }] } });
    expect(draft.statusCode).toBe(202);

    await app.inject({ method: "PATCH", url: `${V1}/orgs/${capped.orgId}/capabilities`, headers: auth(platform), payload: { capabilities: { domains: ["identity"], roles: [] } } });

    const appr = await app.inject({ method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(platform), payload: {} });
    expect(appr.json().proposal.status).toBe("failed"); // thrown BEFORE the row loop — no partial issuance
    // The subject holds nothing from the failed batch.
    const subjTok = await loginAs(app, subject.email, "secret1");
    const held = (await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(subjTok) })).json() as { type: string[] }[];
    expect(held.some((c) => c.type.includes("KycCredential"))).toBe(false);
  });
});
