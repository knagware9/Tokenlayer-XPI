/**
 * The verifier → consent → verify flow (sub-project #3).
 *
 * The whole suite is built ONCE with a fake on-chain registry. That matters:
 * `POST /orgs` registers every org's DID on-chain when a registry is present, and
 * every issued credential is anchored. So issuer orgs are "seen" by the fake —
 * their DIDs resolve `{registered:true, active:true}` — which is exactly the
 * on-chain trust path the verify route needs to mark an issuer TRUSTED. Without a
 * registry, trust falls back to `trustedKycIssuers` (empty ⇒ nothing trusted ⇒
 * every credential UNTRUSTED), so a passing verify is unreachable. Hence the fake.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeJwt, publicKeyFromDidKey, verifyJwtSignature } from "@tokenlayer/core";
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

interface MyCredential { id: string; type: string[]; issuerDid: string; vcJwt: string }
async function myCredentials(token: string): Promise<MyCredential[]> {
  const res = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json() as MyCredential[];
}

const KYC_CLAIMS = { legalName: "Ada Lovelace", country: "IN", idType: "passport", idNumber: "P1234567" };

interface IssuedKyc { issuer: Org; maker: Member; checker: Member; subject: Member; credentialId: string }
/**
 * A verifier org (maker + checker OrgAdmins) issues a KycCredential to a subject
 * who lives in a separate corporate org, and returns everyone plus the cred id.
 */
async function issueKyc(label: string): Promise<IssuedKyc> {
  const issuer = await createOrg("verifier", `${label} Issuer`);
  const maker = await addMember(issuer, "OrgAdmin");
  const checker = await addMember(issuer, "OrgAdmin");
  const subject = await addMember(await createOrg("corporate", `${label} Holder Co`), "Issuer");
  const req = await requestCredential(maker.token, { type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS });
  expect(req.statusCode).toBe(202);
  expect((await approve(checker.token, req.json().proposal.id)).json().proposal.status).toBe("executed");
  const credentialId = (await myCredentials(subject.token)).find((c) => c.type.includes("KycCredential"))!.id;
  return { issuer, maker, checker, subject, credentialId };
}

/** A verifier org and one OrgAdmin who may request presentations. */
async function verifierWithAdmin(label: string): Promise<{ org: Org; admin: Member }> {
  const org = await createOrg("verifier", label);
  return { org, admin: await addMember(org, "OrgAdmin") };
}

function createRequest(token: string, body: { holderDid: string; requestedTypes: string[]; purpose: string }) {
  return app.inject({ method: "POST", url: `${V1}/verification-requests`, headers: auth(token), payload: body });
}
function inbox(token: string) {
  return app.inject({ method: "GET", url: `${V1}/me/verification-requests`, headers: auth(token) });
}
function consent(token: string, id: string, credentialIds: string[]) {
  return app.inject({ method: "POST", url: `${V1}/verification-requests/${id}/consent`, headers: auth(token), payload: { credentialIds } });
}
function verify(token: string, id: string) {
  return app.inject({ method: "GET", url: `${V1}/verification-requests/${id}/verify`, headers: auth(token) });
}

interface Checks { signature: boolean; trusted: boolean; notExpired: boolean; subjectBound: boolean; notRevoked: boolean }
interface VerifyResult {
  valid: boolean; holderDid: string | null; reason: string | null; purpose: string; verifiedAt: string;
  credentials: Array<{ id: string | null; type: string | null; issuer: string | null; claims: Record<string, unknown> | null; reason: string | null; checks: Checks; valid: boolean }>;
}

// ---------------------------------------------------------------------------

describe("happy path — request → inbox → consent → verify", () => {
  it("a verifier verifies a KYC the holder consented to, all checks green", async () => {
    const { issuer, subject, credentialId } = await issueKyc("Happy");
    const { admin: vAdmin } = await verifierWithAdmin("Happy Verifier");

    const created = await createRequest(vAdmin.token, {
      holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "onboarding",
    });
    expect(created.statusCode).toBe(201);
    const reqBody = created.json() as { id: string; verifierOrgId: string; holderDid: string; requestedTypes: string[]; purpose: string; status: string };
    expect(reqBody.status).toBe("pending");
    expect(reqBody.holderDid).toBe(subject.did);
    expect(reqBody.requestedTypes).toEqual(["KycCredential"]);
    expect(reqBody.purpose).toBe("onboarding");
    const requestId = reqBody.id;

    // The holder's inbox lists the request with the KYC as an eligible credential.
    const inRes = await inbox(subject.token);
    expect(inRes.statusCode).toBe(200);
    const rows = inRes.json() as Array<{ id: string; eligibleCredentials: Array<{ id: string; type: string; issuerDid: string; issuedAt: string }> }>;
    const row = rows.find((r) => r.id === requestId)!;
    expect(row).toBeDefined();
    const eligible = row.eligibleCredentials.find((c) => c.id === credentialId)!;
    expect(eligible).toBeDefined();
    expect(eligible.type).toBe("KycCredential");
    expect(eligible.issuerDid).toBe(issuer.did);

    // Consent → status consented.
    const consented = await consent(subject.token, requestId, [credentialId]);
    expect(consented.statusCode).toBe(200);
    expect(consented.json().status).toBe("consented");

    // Verify → valid, one credential, every check true.
    const vRes = await verify(vAdmin.token, requestId);
    expect(vRes.statusCode).toBe(200);
    const result = vRes.json() as VerifyResult;
    expect(result.valid).toBe(true);
    expect(result.holderDid).toBe(subject.did);
    expect(result.purpose).toBe("onboarding");
    expect(result.credentials).toHaveLength(1);
    const cred = result.credentials[0];
    expect(cred.valid).toBe(true);
    expect(cred.type).toBe("KycCredential");
    expect(cred.issuer).toBe(issuer.did);
    expect(cred.checks).toEqual({ signature: true, trusted: true, notExpired: true, subjectBound: true, notRevoked: true });
    expect((cred.claims as { country?: string }).country).toBe("IN");
  });
});

describe("authorization", () => {
  it("NOT_A_VERIFIER — a corporate OrgAdmin may not request a presentation", async () => {
    const corp = await createOrg("corporate", "Not A Verifier Co");
    const corpAdmin = await addMember(corp, "OrgAdmin");
    const { subject } = await issueKyc("NAV");

    const res = await createRequest(corpAdmin.token, {
      holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "onboarding",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("NOT_A_VERIFIER");
  });

  it("only the holder may consent — the verifier's own admin is refused (403)", async () => {
    const { subject, credentialId } = await issueKyc("NonHolder");
    const { admin: vAdmin } = await verifierWithAdmin("NonHolder Verifier");
    const created = await createRequest(vAdmin.token, {
      holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "onboarding",
    });
    const requestId = created.json().id as string;

    const res = await consent(vAdmin.token, requestId, [credentialId]);
    expect(res.statusCode).toBe(403);
  });
});

describe("eligibility", () => {
  it("CREDENTIAL_NOT_ELIGIBLE — consenting with a KYC to an AccreditedInvestor request", async () => {
    const { subject, credentialId } = await issueKyc("Ineligible");
    const { admin: vAdmin } = await verifierWithAdmin("Ineligible Verifier");

    const created = await createRequest(vAdmin.token, {
      holderDid: subject.did, requestedTypes: ["AccreditedInvestor"], purpose: "accreditation",
    });
    const requestId = created.json().id as string;

    // The inbox surfaces NO eligible credentials for this request (holder has only a KYC).
    const rows = (await inbox(subject.token)).json() as Array<{ id: string; eligibleCredentials: unknown[] }>;
    expect(rows.find((r) => r.id === requestId)!.eligibleCredentials).toHaveLength(0);

    const res = await consent(subject.token, requestId, [credentialId]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("CREDENTIAL_NOT_ELIGIBLE");
  });
});

describe("verify guards", () => {
  it("NOT_CONSENTED — verifying a still-pending request is 409", async () => {
    const { subject } = await issueKyc("Pending");
    const { admin: vAdmin } = await verifierWithAdmin("Pending Verifier");
    const created = await createRequest(vAdmin.token, {
      holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "onboarding",
    });
    const requestId = created.json().id as string;

    const res = await verify(vAdmin.token, requestId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NOT_CONSENTED");
  });
});

describe("reject", () => {
  it("the holder rejects a request → status rejected", async () => {
    const { subject } = await issueKyc("Reject");
    const { admin: vAdmin } = await verifierWithAdmin("Reject Verifier");
    const created = await createRequest(vAdmin.token, {
      holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "onboarding",
    });
    const requestId = created.json().id as string;

    const res = await app.inject({ method: "POST", url: `${V1}/verification-requests/${requestId}/reject`, headers: auth(subject.token), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rejected");
  });
});

describe("live revocation flips notRevoked", () => {
  it("re-verifying after an on-chain revoke turns valid:false, only notRevoked changes", async () => {
    const { issuer, maker, checker, subject, credentialId } = await issueKyc("Revoke");
    const { admin: vAdmin } = await verifierWithAdmin("Revoke Verifier");
    const created = await createRequest(vAdmin.token, {
      holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "onboarding",
    });
    const requestId = created.json().id as string;
    expect((await consent(subject.token, requestId, [credentialId])).statusCode).toBe(200);

    // First verify — fully valid.
    const before = (await verify(vAdmin.token, requestId)).json() as VerifyResult;
    expect(before.valid).toBe(true);
    expect(before.credentials[0].checks.notRevoked).toBe(true);

    // Revoke via the ISSUING org's maker → checker (KycCredential = 1 approval).
    const rReq = await revoke(maker.token, credentialId, { reason: "document forged" });
    expect(rReq.statusCode).toBe(202);
    expect((await approve(checker.token, rReq.json().proposal.id)).json().proposal.status).toBe("executed");
    expect(anchor.credentials.get(credentialId)!.revoked).toBe(true);

    // Re-verify the SAME request — revocation is read fresh from the chain.
    const after = (await verify(vAdmin.token, requestId)).json() as VerifyResult;
    expect(after.credentials[0].checks.notRevoked).toBe(false);
    expect(after.credentials[0].checks.signature).toBe(true); // ONLY revocation changed
    expect(after.credentials[0].valid).toBe(false);
    expect(after.valid).toBe(false);
    // The issuer identity is untouched — still the same trusted issuer.
    expect(after.credentials[0].issuer).toBe(issuer.did);
    expect(after.credentials[0].checks.trusted).toBe(true);
  });
});

describe("independence of the verify result", () => {
  // The API deliberately never exposes the VP blob (vreqView omits it, and the
  // consent response is also a vreqView), so there is no API-returned VP to decode
  // and re-verify. Independence is instead shown two ways: (1) the verify route
  // recomputes holderDid and each issuer FROM the presented signatures — a passing
  // result the platform could not have forged; and (2) a raw-crypto check on the
  // holder's OWN credential (available via /me/credentials), verified against the
  // issuer org's DID key with no help from the verify route.
  it("verify recomputes holderDid + issuer, and the raw VC signature holds independently", async () => {
    const { issuer, subject, credentialId } = await issueKyc("Independent");
    const { admin: vAdmin } = await verifierWithAdmin("Independent Verifier");
    const created = await createRequest(vAdmin.token, {
      holderDid: subject.did, requestedTypes: ["KycCredential"], purpose: "onboarding",
    });
    const requestId = created.json().id as string;
    expect((await consent(subject.token, requestId, [credentialId])).statusCode).toBe(200);

    const result = (await verify(vAdmin.token, requestId)).json() as VerifyResult;
    expect(result.holderDid).toBe(subject.did);
    expect(result.credentials[0].issuer).toBe(issuer.did);

    // (2) Independent raw crypto: the holder's own VC verifies against the issuer's
    // DID key and NOT against an unrelated org's key — nothing here comes from the
    // verify route.
    const vcJwt = (await myCredentials(subject.token)).find((c) => c.id === credentialId)!.vcJwt;
    expect(verifyJwtSignature(vcJwt, publicKeyFromDidKey(issuer.did))).toBe(true);
    expect(verifyJwtSignature(vcJwt, publicKeyFromDidKey(subject.did))).toBe(false);
    const { payload } = decodeJwt(vcJwt) as { payload: { iss: string; sub: string } };
    expect(payload.iss).toBe(issuer.did);
    expect(payload.sub).toBe(subject.did);
  });
});
