import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { resolveDid } from "../src/did-resolver.js";
import { generateDidKey } from "@tokenlayer/core";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

describe("resolveDid", () => {
  const did = generateDidKey().did; // valid did:key ed25519

  it("resolves a valid did:key off-chain (no registry)", async () => {
    const res = await resolveDid(did, {});
    expect(res.didResolutionMetadata.error).toBeUndefined();
    expect(res.didDocument?.id).toBe(did);
    expect(res.didDocument?.verificationMethod[0]).toEqual({
      id: `${did}#0`, type: "Ed25519VerificationKey2020", controller: did,
      publicKeyMultibase: did.slice("did:key:".length),
    });
    expect(res.didDocument?.authentication).toEqual([`${did}#0`]);
    expect(res.didDocumentMetadata).toEqual({ source: "off-chain" });
  });

  it("returns invalidDid for a non-DID string and a malformed did:key", async () => {
    for (const bad of ["not-a-did", "did:key:zzz-bad-multibase"]) {
      const res = await resolveDid(bad, {});
      expect(res.didResolutionMetadata.error).toBe("invalidDid");
      expect(res.didDocument).toBeNull();
    }
  });

  it("returns methodNotSupported for another DID method", async () => {
    const res = await resolveDid("did:web:example.com", {});
    expect(res.didResolutionMetadata.error).toBe("methodNotSupported");
    expect(res.didDocument).toBeNull();
  });

  it("enriches from the registry: registered+active", async () => {
    const anchor = new FakeAnchor();
    const registry = fakeRegistry(anchor);
    await anchor.registerDid(registry.didRegistry, did);
    const res = await resolveDid(did, { registry });
    expect(res.didDocumentMetadata).toEqual({
      source: "chain", registered: true, active: true, deactivated: false,
      chainId: registry.chainId, registry: registry.didRegistry,
    });
  });

  it("reports deactivated for a deactivated DID", async () => {
    const anchor = new FakeAnchor();
    const registry = fakeRegistry(anchor);
    await anchor.registerDid(registry.didRegistry, did);
    await anchor.deactivateDid(registry.didRegistry, did);
    const res = await resolveDid(did, { registry });
    expect(res.didDocumentMetadata).toMatchObject({ source: "chain", registered: true, active: false, deactivated: true });
  });

  it("an unregistered DID resolves with registered:false (still source chain)", async () => {
    const res = await resolveDid(did, { registry: fakeRegistry(new FakeAnchor()) });
    expect(res.didDocumentMetadata).toMatchObject({ source: "chain", registered: false, active: false, deactivated: false });
  });

  it("falls back to off-chain when the registry read throws (no fabricated claims)", async () => {
    const anchor = new FakeAnchor();
    const registry = fakeRegistry(anchor);
    // FakeAnchor.didRegistration has no failNext hook — monkey-patch the instance:
    anchor.didRegistration = async () => { throw new Error("rpc down"); };
    let sawError: unknown = null;
    const res = await resolveDid(did, { registry, onChainError: (e) => { sawError = e; } });
    expect(res.didDocumentMetadata).toEqual({ source: "off-chain" });
    expect(sawError).toBeTruthy();
    expect(res.didDocument?.id).toBe(did); // document still resolves
  });
});

describe("GET /dids/:did/resolve", () => {
  const did = generateDidKey().did;

  it("resolves publicly (no auth) off-chain when the app has no registry", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: `${V1}/dids/${did}/resolve` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.didDocument.id).toBe(did);
    expect(body.didDocumentMetadata).toEqual({ source: "off-chain" });
  });

  it("resolves publicly (no auth) with on-chain registration metadata", async () => {
    const anchor = new FakeAnchor();
    const registry = fakeRegistry(anchor);
    await anchor.registerDid(registry.didRegistry, did);
    const app = await buildTestApp({ registry });
    const res = await app.inject({ method: "GET", url: `${V1}/dids/${did}/resolve` });
    expect(res.statusCode).toBe(200);
    expect(res.json().didDocumentMetadata).toEqual({
      source: "chain", registered: true, active: true, deactivated: false,
      chainId: "besu", registry: "0xdid",
    });
  });

  it("reports methodNotSupported for a non-did:key DID", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: `${V1}/dids/${encodeURIComponent("did:web:example.com")}/resolve`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.didResolutionMetadata.error).toBe("methodNotSupported");
    expect(body.didDocument).toBeNull();
  });

  it("reports invalidDid for garbage input", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: `${V1}/dids/garbage/resolve` });
    expect(res.statusCode).toBe(200);
    expect(res.json().didResolutionMetadata.error).toBe("invalidDid");
  });

  it("document route (back-compat): still returns the old shape, now authed via resolveDid", async () => {
    const anchor = new FakeAnchor();
    const registry = fakeRegistry(anchor);
    await anchor.registerDid(registry.didRegistry, did);
    const app = await buildTestApp({ registry });
    const token = await loginAs(app, "admin@tokenlayer.dev", "admin123");

    const res = await app.inject({
      method: "GET", url: `${V1}/dids/${did}/document`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(did);
    expect(Array.isArray(body.verificationMethod)).toBe(true);
    expect(body.registration).toEqual({ registered: true, active: true, chainId: "besu", registry: "0xdid" });

    const bad = await app.inject({
      method: "GET", url: `${V1}/dids/garbage/document`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("UNSUPPORTED_DID");
  });
});

// K3 — the verify route's per-credential `issuerResolution` enrichment. Reuses
// the request -> consent -> verify flow pattern from verification.test.ts, but
// self-contained (its own local helpers) since those are file-local there.
describe("GET /verification-requests/:id/verify — issuerResolution enrichment (K3)", () => {
  let seq = 0;
  const tag = (): string => `${Date.now().toString(36)}-${++seq}`;

  interface Org { id: string; did: string; orgType: string }
  interface Member { id: string; did: string; email: string; token: string }

  async function createOrg(app: FastifyInstance, admin: string, orgType: string, label: string): Promise<Org> {
    const res = await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name: `${label} ${tag()}`, orgType } });
    expect(res.statusCode).toBe(201);
    return res.json() as Org;
  }
  async function addMember(app: FastifyInstance, admin: string, org: Org, role: string): Promise<Member> {
    const email = `${role.toLowerCase()}.${tag()}@x.io`;
    const res = await app.inject({ method: "POST", url: `${V1}/orgs/${org.id}/users`, headers: auth(admin), payload: { email, password: "secret1", role } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; did: string };
    return { id: body.id, did: body.did, email, token: await loginAs(app, email, "secret1") };
  }
  async function myCredentials(app: FastifyInstance, token: string): Promise<{ id: string; type: string[] }[]> {
    const res = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
    return res.json() as { id: string; type: string[] }[];
  }
  const KYC_CLAIMS = { legalName: "Ada Lovelace", country: "IN", idType: "passport", idNumber: "P1234567" };
  async function issueKyc(app: FastifyInstance, admin: string, label: string) {
    const issuer = await createOrg(app, admin, "verifier", `${label} Issuer`);
    const maker = await addMember(app, admin, issuer, "OrgAdmin");
    const checker = await addMember(app, admin, issuer, "OrgAdmin");
    const subject = await addMember(app, admin, await createOrg(app, admin, "corporate", `${label} Holder Co`), "Issuer");
    const req = await app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(maker.token), payload: { type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS } });
    expect(req.statusCode).toBe(202);
    const approved = await app.inject({ method: "POST", url: `${V1}/proposals/${req.json().proposal.id}/approve`, headers: auth(checker.token), payload: {} });
    expect(approved.json().proposal.status).toBe("executed");
    const credentialId = (await myCredentials(app, subject.token)).find((c) => c.type.includes("KycCredential"))!.id;
    return { issuer, subject, credentialId };
  }
  async function verifierWithAdmin(app: FastifyInstance, admin: string, label: string) {
    const org = await createOrg(app, admin, "verifier", label);
    return { admin: await addMember(app, admin, org, "OrgAdmin") };
  }
  function createRequest(app: FastifyInstance, token: string, body: { holderDid: string; requestedTypes: string[]; purpose: string }) {
    return app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(token), payload: body });
  }
  function consent(app: FastifyInstance, token: string, id: string, credentialIds: string[]) {
    return app.inject({ method: "POST", url: `${V1}/verification-requests/${id}/consent`, headers: auth(token), payload: { credentialIds } });
  }
  function verify(app: FastifyInstance, token: string, id: string) {
    return app.inject({ method: "GET", url: `${V1}/verification-requests/${id}/verify`, headers: auth(token) });
  }

  it("registry present + issuer registered+active on-chain → issuerResolution mirrors the chain read", async () => {
    const anchor = new FakeAnchor();
    const app = await buildTestApp({ registry: fakeRegistry(anchor) });
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const { subject, credentialId } = await issueKyc(app, admin, "K3Chain");
    const { admin: vAdmin } = await verifierWithAdmin(app, admin, "K3Chain Verifier");

    const created = await createRequest(app, vAdmin.token, { holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "onboarding" });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().id as string;
    expect((await consent(app, subject.token, requestId, [credentialId])).statusCode).toBe(200);

    const result = (await verify(app, vAdmin.token, requestId)).json() as { credentials: Array<{ issuerResolution: unknown }> };
    expect(result.credentials[0].issuerResolution).toEqual({ registered: true, active: true, chainId: "besu" });
    await app.close();
  });

  it("no registry, issuer trusted only via the trustedKycIssuers allowlist → issuerResolution is null", async () => {
    // A randomly-minted org DID can't be known before buildTestApp() is called, so
    // pre-trust it by mutating the SAME array reference deps.trustedKycIssuers holds
    // (buildTestApp assigns opts.trustedKycIssuers as-is, no copy) — the only way to
    // allowlist an org's real DID without a registry.
    const allowlist: string[] = [];
    const app = await buildTestApp({ trustedKycIssuers: allowlist });
    const admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
    const { issuer, subject, credentialId } = await issueKyc(app, admin, "K3Chainless");
    allowlist.push(issuer.did);
    const { admin: vAdmin } = await verifierWithAdmin(app, admin, "K3Chainless Verifier");

    const created = await createRequest(app, vAdmin.token, { holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "onboarding" });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().id as string;
    expect((await consent(app, subject.token, requestId, [credentialId])).statusCode).toBe(200);

    const result = (await verify(app, vAdmin.token, requestId)).json() as {
      credentials: Array<{ issuer: string | null; checks: { trusted: boolean }; issuerResolution: unknown }>;
    };
    // Sanity: this credential IS trusted (via the allowlist), so the null below is
    // the "registry absent" branch, not a vacuous null from an unresolved issuer.
    expect(result.credentials[0].checks.trusted).toBe(true);
    expect(result.credentials[0].issuer).toBe(issuer.did);
    expect(result.credentials[0].issuerResolution).toBeNull();
    await app.close();
  });
});
