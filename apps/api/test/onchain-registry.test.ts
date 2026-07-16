/**
 * Wiring tests for the ANCHORED path — the whole rest of the suite runs with
 * besu absent, so `deps.registry` is undefined and none of this is exercised.
 *
 * The anchor here is an in-memory test double that never leaves the test
 * process: it proves the API's ORDERING and BRANCHING (anchor-before-persist,
 * chain-first revoke, the three-way status), not EVM behaviour. Real chain
 * behaviour belongs to the hardhat contract tests and a live Besu E2E.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

let app: FastifyInstance;
let admin: string;
let anchor: FakeAnchor;

beforeAll(async () => {
  anchor = new FakeAnchor();
  app = await buildTestApp({ registry: fakeRegistry(anchor) });
  admin = await loginAs(app, "admin@tokenlayer.dev", "admin123");
});
afterAll(async () => { await app.close(); });

// Every org name / user email must be unique across the suite.
let seq = 0;
const tag = (): string => `${Date.now().toString(36)}-${++seq}`;

interface Org { id: string; did: string; orgType: string }
interface Member { id: string; did: string; email: string; token: string }

async function createOrg(orgType: string, label: string): Promise<Org> {
  const res = await app.inject({
    method: "POST", url: `${V1}/orgs`, headers: auth(admin),
    payload: { name: `${label} ${tag()}`, orgType },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Org;
}

async function addMember(org: Org, role: string): Promise<Member> {
  const email = `${role.toLowerCase()}.${tag()}@x.io`;
  const res = await app.inject({
    method: "POST", url: `${V1}/orgs/${org.id}/users`, headers: auth(admin),
    payload: { email, password: "secret1", role },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; did: string };
  return { id: body.id, did: body.did, email, token: await loginAs(app, email, "secret1") };
}

function requestCredential(token: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `${V1}/credentials/requests`, headers: auth(token), payload });
}
function approve(token: string, proposalId: string) {
  return app.inject({ method: "POST", url: `${V1}/proposals/${proposalId}/approve`, headers: auth(token), payload: {} });
}
function revoke(token: string, id: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `${V1}/credentials/${id}/revoke`, headers: auth(token), payload: body });
}
function status(id: string) {
  return app.inject({ method: "GET", url: `${V1}/credentials/${id}/status` });
}

interface MyCredential { id: string; type: string[]; vcJwt: string }
async function myCredentials(token: string): Promise<MyCredential[]> {
  const res = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json() as MyCredential[];
}

const KYC_CLAIMS = { legalName: "Ada Lovelace", country: "IN", idType: "passport", idNumber: "P1234567" };

/** verifier org + maker/checker OrgAdmins + an outside subject, then issue a KycCredential. */
async function issueKyc(label: string): Promise<{ org: Org; maker: Member; checker: Member; subject: Member; id: string }> {
  const org = await createOrg("verifier", label);
  const maker = await addMember(org, "OrgAdmin");
  const checker = await addMember(org, "OrgAdmin");
  const subject = await addMember(await createOrg("corporate", `${label} Subject Co`), "Issuer");
  const req = await requestCredential(maker.token, { type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS });
  expect(req.statusCode).toBe(202);
  const decided = await approve(checker.token, req.json().proposal.id);
  expect(decided.json().proposal.status).toBe("executed");
  const id = (await myCredentials(subject.token)).find((c) => c.type.includes("KycCredential"))!.id;
  return { org, maker, checker, subject, id };
}

// ---------------------------------------------------------------------------

describe("org DIDs on-chain", () => {
  it("registers the org's DID and reports it at the DID document", async () => {
    const org = await createOrg("verifier", "Anchored Verifier");
    expect(anchor.dids.get(org.did)).toBe(true);

    const res = await app.inject({ method: "GET", url: `${V1}/dids/${org.did}/document`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json().registration).toEqual({ registered: true, active: true, chainId: "besu", registry: "0xdid" });
  });

  it("a chain failure creates NO org (anchor-before-persist ⇒ nothing to roll back)", async () => {
    const name = `Doomed Org ${tag()}`;
    anchor.failNext = "registerDid";
    const res = await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(admin), payload: { name, orgType: "verifier" } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("REGISTRY_UNAVAILABLE");

    const list = await app.inject({ method: "GET", url: `${V1}/orgs`, headers: auth(admin) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ name: string }>).map((o) => o.name)).not.toContain(name);
  });

  it("member sub-DIDs are NOT registered on-chain (personal DIDs stay private)", async () => {
    const org = await createOrg("corporate", "Private Members Co");
    const member = await addMember(org, "Issuer");
    expect(anchor.dids.has(org.did)).toBe(true);   // the org's DID is public...
    expect(anchor.dids.has(member.did)).toBe(false); // ...its members' are not.
  });
});

describe("credential anchoring", () => {
  it("anchors on issue, and the public status is answered by the CHAIN", async () => {
    const { id, subject } = await issueKyc("Anchor Verifier");
    expect(anchor.credentials.has(id)).toBe(true);

    const res = await status(id);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id, revoked: false, revokedAt: null, anchored: true,
      source: "chain", chainId: "besu", registry: "0xvc",
    });
    expect(body.vcHash).toBeTruthy();

    // The anchored hash commits to the VC the holder actually got.
    const vcJwt = (await myCredentials(subject.token)).find((c) => c.id === id)!.vcJwt;
    expect(typeof vcJwt).toBe("string");
    expect(body.vcHash).toBe(anchor.credentials.get(id)!.vcHash);
  });

  it("a failed anchor fails the proposal and creates NO credential", async () => {
    const org = await createOrg("verifier", "Anchor Fail Verifier");
    const maker = await addMember(org, "OrgAdmin");
    const checker = await addMember(org, "OrgAdmin");
    const subject = await addMember(await createOrg("corporate", "Anchor Fail Subject Co"), "Issuer");

    const req = await requestCredential(maker.token, { type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS });
    expect(req.statusCode).toBe(202);

    anchor.failNext = "anchorCredential";
    const decided = await approve(checker.token, req.json().proposal.id);
    expect(decided.statusCode).toBe(200);
    expect(decided.json().proposal.status).toBe("failed");

    expect((await myCredentials(subject.token)).some((c) => c.type.includes("KycCredential"))).toBe(false);
  });
});

describe("revocation is chain-first", () => {
  it("an on-chain revoke flips the public status", async () => {
    const { id, maker, checker } = await issueKyc("Revoke Anchored");
    const reason = "document forged";
    const req = await revoke(maker.token, id, { reason });
    expect(req.statusCode).toBe(202);
    expect((await approve(checker.token, req.json().proposal.id)).json().proposal.status).toBe("executed");

    expect(anchor.credentials.get(id)!.revoked).toBe(true);
    const body = (await status(id)).json() as Record<string, unknown>;
    expect(body).toMatchObject({ id, revoked: true, anchored: true, source: "chain", reason });
    expect(typeof body.revokedAt).toBe("string"); // from the chain's revokedAt
  });

  it("a failed on-chain revoke leaves the DB untouched (chain FIRST, then the DB)", async () => {
    const { id, maker, checker } = await issueKyc("Revoke Fail");
    const req = await revoke(maker.token, id, { reason: "will not land" });
    expect(req.statusCode).toBe(202);

    anchor.failNext = "revokeCredential";
    const decided = await approve(checker.token, req.json().proposal.id);
    expect(decided.statusCode).toBe(200);
    expect(decided.json().proposal.status).toBe("failed");

    expect(anchor.credentials.get(id)!.revoked).toBe(false);
    expect((await status(id)).json()).toMatchObject({ revoked: false, anchored: true, source: "chain" });
  });
});

// ---------------------------------------------------------------------------
// THE THREE-WAY. `credentialStatusOf` returns revoked:false for a record the
// chain has never seen. Reading that as "the chain says not-revoked" is the
// fail-open bug the whole sub-project exists to avoid: an absent record is NOT
// a negative revocation.
// ---------------------------------------------------------------------------
describe("three-way status resolution", () => {
  it("a credential the chain has no record of falls back to the DATABASE, not a chain not-revoked", async () => {
    const { id } = await issueKyc("Predates Registry");
    anchor.credentials.delete(id); // as if it were issued before the registry existed
    expect((await anchor.credentialStatusOf("0xvc", id))).toMatchObject({ exists: false, revoked: false });

    const res = await status(id);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.source).toBe("database");
    expect(body.anchored).toBe(false);
    // ...and it must not dress a database answer up in chain provenance.
    expect(Object.keys(body).sort()).toEqual(["anchored", "id", "reason", "revoked", "revokedAt", "source"].sort());
    expect(body).not.toHaveProperty("vcHash");
    expect(body).not.toHaveProperty("chainId");
    expect(body).not.toHaveProperty("registry");
  });
});

describe("GET /registry", () => {
  it("reports the deployed registries", async () => {
    const res = await app.inject({ method: "GET", url: `${V1}/registry`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ chainId: "besu", didRegistry: "0xdid", vcRegistry: "0xvc", deployTxHash: "0xdeploy" });
  });
});
