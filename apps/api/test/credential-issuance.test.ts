import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeJwt, publicKeyFromDidKey, verifyJwtSignature } from "@tokenlayer/core";
import { auth, buildTestApp, loginAs, V1 } from "./helpers.js";

let app: FastifyInstance;
let admin: string;

beforeAll(async () => {
  app = await buildTestApp();
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

/** Adds a member to `org` (as PlatformAdmin) and logs them in. */
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

interface MyCredential {
  id: string; type: string[]; issuerDid: string; holderDid: string;
  claims: Record<string, unknown>; revoked: boolean; revokedAt: string | null;
  revokedReason: string | null; vcJwt: string;
}
async function myCredentials(token: string): Promise<MyCredential[]> {
  const res = await app.inject({ method: "GET", url: `${V1}/me/credentials`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json() as MyCredential[];
}

const KYC_CLAIMS = { legalName: "Ada Lovelace", country: "IN", idType: "passport", idNumber: "P1234567" };

// ---------------------------------------------------------------------------

describe("GET /credential-types", () => {
  it("lists the whole catalog with schema + per-type approval depth", async () => {
    const res = await app.inject({ method: "GET", url: `${V1}/credential-types`, headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const types = res.json() as Array<{
      type: string; requiredApprovals: number; selfIssuedOnly: boolean;
      allowedIssuerOrgTypes: string[]; claimSchema: { required?: string[] };
    }>;
    expect(types.map((t) => t.type).sort()).toEqual(["AccreditedInvestor", "AuthorizedSignatory", "KycCredential"]);

    const byType = Object.fromEntries(types.map((t) => [t.type, t]));
    expect(byType.KycCredential.requiredApprovals).toBe(1);
    expect(byType.AccreditedInvestor.requiredApprovals).toBe(1);
    expect(byType.AuthorizedSignatory.requiredApprovals).toBe(2);

    expect(byType.KycCredential.selfIssuedOnly).toBe(false);
    expect(byType.AuthorizedSignatory.selfIssuedOnly).toBe(true);
    expect(byType.KycCredential.allowedIssuerOrgTypes).toContain("verifier");
    expect(byType.KycCredential.allowedIssuerOrgTypes).not.toContain("corporate");

    for (const t of types) {
      expect(t.claimSchema).toBeTruthy();
      expect(t.claimSchema.required?.length).toBeGreaterThan(0);
    }
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: `${V1}/credential-types` });
    expect(res.statusCode).toBe(401);
  });
});

describe("issue a KycCredential (happy path)", () => {
  it("gates on one approval, then signs a verifiable VC bound to the issuing org's DID", async () => {
    const verifier = await createOrg("verifier", "KYC Verifier");
    const maker = await addMember(verifier, "OrgAdmin");
    const checker = await addMember(verifier, "OrgAdmin");
    const holderOrg = await createOrg("corporate", "KYC Holder Co");
    const subject = await addMember(holderOrg, "Issuer");

    const req = await requestCredential(maker.token, {
      type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS,
    });
    expect(req.statusCode).toBe(202);
    const proposal = req.json().proposal as { id: string; kind: string; required: number; status: string; orgId: string };
    expect(proposal.kind).toBe("issue-credential");
    expect(proposal.required).toBe(1);
    expect(proposal.status).toBe("pending");
    expect(proposal.orgId).toBe(verifier.id);

    // Before approval nothing is issued.
    expect(await myCredentials(subject.token)).toHaveLength(1); // membership VC only

    const decided = await approve(checker.token, proposal.id);
    expect(decided.statusCode).toBe(200);
    expect(decided.json().proposal.status).toBe("executed");

    const creds = await myCredentials(subject.token);
    const kyc = creds.find((c) => c.type.includes("KycCredential"));
    expect(kyc).toBeDefined();
    expect(kyc!.revoked).toBe(false);
    expect(kyc!.revokedAt).toBeNull();
    expect(kyc!.issuerDid).toBe(verifier.did);
    expect(kyc!.holderDid).toBe(subject.did);

    // --- cryptographic assertions -----------------------------------------
    expect(verifyJwtSignature(kyc!.vcJwt, publicKeyFromDidKey(verifier.did))).toBe(true);
    // ...and NOT against an unrelated org's key.
    expect(verifyJwtSignature(kyc!.vcJwt, publicKeyFromDidKey(holderOrg.did))).toBe(false);

    const { payload } = decodeJwt(kyc!.vcJwt) as {
      payload: {
        iss: string; sub: string; jti: string;
        vc: {
          type: string[];
          credentialSubject: Record<string, unknown>;
          credentialStatus: { id: string; type: string };
        };
      };
    };
    expect(payload.iss).toBe(verifier.did);
    expect(payload.sub).toBe(subject.did);
    expect(payload.jti).toBe(kyc!.id);
    expect(payload.vc.type).toEqual(["VerifiableCredential", "KycCredential"]);
    expect(payload.vc.credentialSubject.id).toBe(subject.did);
    expect(payload.vc.credentialSubject).toMatchObject(KYC_CLAIMS);
    expect(payload.vc.credentialStatus.id).toContain(`/credentials/${kyc!.id}/status`);
    expect(payload.vc.credentialStatus.type).toBe("SimpleRevocationStatus2024");

    // The issuing org sees it in its own ledger of issued credentials.
    const issued = await app.inject({ method: "GET", url: `${V1}/orgs/${verifier.id}/credentials`, headers: auth(maker.token) });
    expect(issued.statusCode).toBe(200);
    const rows = issued.json() as Array<{ id: string; type: string; holderDid: string; revoked: boolean }>;
    const row = rows.find((r) => r.id === kyc!.id);
    expect(row).toBeDefined();
    expect(row!.type).toBe("KycCredential");
    expect(row!.holderDid).toBe(subject.did);
    expect(row!.revoked).toBe(false);
  });

  it("a PlatformAdmin must name the issuing org, and it is honoured", async () => {
    const verifier = await createOrg("verifier", "PA Issuer");
    const checker = await addMember(verifier, "OrgAdmin");
    const subject = await addMember(await createOrg("msme", "PA Subject Co"), "Issuer");

    const missing = await requestCredential(admin, { type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("ISSUER_ORG_REQUIRED");

    const req = await requestCredential(admin, {
      type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS, issuerOrgId: verifier.id,
    });
    expect(req.statusCode).toBe(202);
    expect(req.json().proposal.orgId).toBe(verifier.id);
    expect(await approve(checker.token, req.json().proposal.id)).toMatchObject({ statusCode: 200 });
    const cred = (await myCredentials(subject.token)).find((c) => c.type.includes("KycCredential"))!;
    expect(cred.issuerDid).toBe(verifier.did);
  });

  it("an OrgAdmin's issuerOrgId is IGNORED — they always issue as their own org", async () => {
    const mine = await createOrg("verifier", "Own Verifier");
    const other = await createOrg("verifier", "Other Verifier");
    const maker = await addMember(mine, "OrgAdmin");
    const subject = await addMember(await createOrg("corporate", "Ignore Subject Co"), "Issuer");

    const req = await requestCredential(maker.token, {
      type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS, issuerOrgId: other.id,
    });
    expect(req.statusCode).toBe(202);
    const proposal = req.json().proposal as { orgId: string; payload: { issuerOrgId: string } };
    expect(proposal.orgId).toBe(mine.id);
    expect(proposal.payload.issuerOrgId).toBe(mine.id);
    expect(proposal.payload.issuerOrgId).not.toBe(other.id);
  });

  it("rejects a subject that has no DID", async () => {
    const verifier = await createOrg("verifier", "NoDid Verifier");
    const maker = await addMember(verifier, "OrgAdmin");
    // A legacy user created without an org gets no DID.
    const uca = await loginAs(app, "carbon.admin@tokenlayer.dev", "carbon123");
    const legacy = await app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(uca),
      payload: { email: `nodid.${tag()}@x.io`, password: "secret1", role: "Issuer" },
    });
    expect(legacy.statusCode).toBe(201);
    expect(legacy.json().did ?? null).toBeNull();

    const res = await requestCredential(maker.token, { type: "KycCredential", subjectUserId: legacy.json().id, claims: KYC_CLAIMS });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("SUBJECT_HAS_NO_DID");
  });

  it("a non-admin role may not request a credential", async () => {
    const verifier = await createOrg("verifier", "NonAdmin Verifier");
    const issuer = await addMember(verifier, "Issuer");
    const subject = await addMember(verifier, "Auditor");
    const res = await requestCredential(issuer.token, { type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS });
    expect(res.statusCode).toBe(403);
  });
});

describe("per-type approval depth", () => {
  it("AuthorizedSignatory needs TWO distinct approvals", async () => {
    const org = await createOrg("corporate", "Signatory Co");
    const maker = await addMember(org, "OrgAdmin");
    const checker1 = await addMember(org, "OrgAdmin");
    const checker2 = await addMember(org, "OrgAdmin");
    const subject = await addMember(org, "Issuer"); // selfIssuedOnly → own member

    const req = await requestCredential(maker.token, {
      type: "AuthorizedSignatory", subjectUserId: subject.id, claims: { role: "CFO", scope: "treasury" },
    });
    expect(req.statusCode).toBe(202);
    const proposal = req.json().proposal as { id: string; required: number };
    expect(proposal.required).toBe(2);

    const first = await approve(checker1.token, proposal.id);
    expect(first.statusCode).toBe(200);
    expect(first.json().proposal.status).toBe("pending");
    expect(first.json().proposal.approvals).toHaveLength(1);
    expect((await myCredentials(subject.token)).some((c) => c.type.includes("AuthorizedSignatory"))).toBe(false);

    // The SAME approver may not double-count.
    const dup = await approve(checker1.token, proposal.id);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("ALREADY_APPROVED_BY_YOU");

    const second = await approve(checker2.token, proposal.id);
    expect(second.statusCode).toBe(200);
    expect(second.json().proposal.status).toBe("executed");

    const cred = (await myCredentials(subject.token)).find((c) => c.type.includes("AuthorizedSignatory"));
    expect(cred).toBeDefined();
    expect(cred!.claims).toMatchObject({ role: "CFO", scope: "treasury" });
    expect(verifyJwtSignature(cred!.vcJwt, publicKeyFromDidKey(org.did))).toBe(true);
  });
});

describe("segregation of duties", () => {
  it("the requester may not approve their own request", async () => {
    const verifier = await createOrg("verifier", "SoD Verifier");
    const maker = await addMember(verifier, "OrgAdmin");
    const subject = await addMember(await createOrg("corporate", "SoD Subject Co"), "Issuer");

    const req = await requestCredential(maker.token, { type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS });
    expect(req.statusCode).toBe(202);
    const res = await approve(maker.token, req.json().proposal.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("SELF_APPROVAL");
    // ...and nothing was issued.
    expect((await myCredentials(subject.token)).some((c) => c.type.includes("KycCredential"))).toBe(false);
  });
});

describe("issuer trust", () => {
  it("a corporate org may not issue a KycCredential", async () => {
    const corp = await createOrg("corporate", "Rogue Corp");
    const maker = await addMember(corp, "OrgAdmin");
    const subject = await addMember(await createOrg("msme", "Trust Subject Co"), "Issuer");

    const res = await requestCredential(maker.token, { type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("ISSUER_NOT_PERMITTED");
  });

  it("a government org may not issue an AccreditedInvestor credential", async () => {
    const gov = await createOrg("government", "Gov Body");
    const maker = await addMember(gov, "OrgAdmin");
    const subject = await addMember(await createOrg("msme", "Accred Subject Co"), "Issuer");

    const res = await requestCredential(maker.token, {
      type: "AccreditedInvestor", subjectUserId: subject.id, claims: { basis: "income", jurisdiction: "IN" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("ISSUER_NOT_PERMITTED");
  });
});

describe("claim validation", () => {
  let maker: Member;
  let subjectId: string;
  beforeAll(async () => {
    const verifier = await createOrg("verifier", "Claims Verifier");
    maker = await addMember(verifier, "OrgAdmin");
    subjectId = (await addMember(await createOrg("corporate", "Claims Subject Co"), "Issuer")).id;
  });

  it("rejects a missing required claim", async () => {
    const res = await requestCredential(maker.token, {
      type: "KycCredential", subjectUserId: subjectId, claims: { legalName: "Ada" }, // no country
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_METADATA");
  });

  it("rejects a country that fails the ISO-3166 pattern", async () => {
    const res = await requestCredential(maker.token, {
      type: "KycCredential", subjectUserId: subjectId, claims: { legalName: "Ada", country: "INDIA" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_METADATA");
  });

  it("rejects a value outside a claim's enum", async () => {
    const res = await requestCredential(maker.token, {
      type: "AccreditedInvestor", subjectUserId: subjectId, claims: { basis: "vibes", jurisdiction: "IN" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_METADATA");
  });

  it("accepts the same claims once corrected", async () => {
    const res = await requestCredential(maker.token, {
      type: "AccreditedInvestor", subjectUserId: subjectId, claims: { basis: "income", jurisdiction: "IN" },
    });
    expect(res.statusCode).toBe(202);
  });
});

describe("unknown credential type", () => {
  it("400s UNKNOWN_CREDENTIAL_TYPE", async () => {
    const verifier = await createOrg("verifier", "Unknown Verifier");
    const maker = await addMember(verifier, "OrgAdmin");
    const subject = await addMember(await createOrg("corporate", "Unknown Subject Co"), "Issuer");

    const res = await requestCredential(maker.token, {
      type: "SuperUserCredential", subjectUserId: subject.id, claims: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNKNOWN_CREDENTIAL_TYPE");
  });
});

describe("selfIssuedOnly", () => {
  it("an org may not issue an AuthorizedSignatory to an outsider", async () => {
    const org = await createOrg("corporate", "Insider Co");
    const maker = await addMember(org, "OrgAdmin");
    const outsider = await addMember(await createOrg("corporate", "Outsider Co"), "Issuer");

    const res = await requestCredential(maker.token, {
      type: "AuthorizedSignatory", subjectUserId: outsider.id, claims: { role: "CFO", scope: "all" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("SELF_ISSUED_ONLY");
  });
});

// ---------------------------------------------------------------------------
// THE CROSS-ORG TRAP. Org A's and org B's OrgAdmins BOTH carry useCaseKey: null,
// as does every credential proposal — a `scopedToCaller` that compares those
// would match null === null and leak org A's proposals into org B's view.
// ---------------------------------------------------------------------------
describe("cross-org isolation of credential proposals", () => {
  it("org B's OrgAdmin neither sees nor can approve org A's credential proposal", async () => {
    const orgA = await createOrg("verifier", "Isolation A");
    const orgB = await createOrg("verifier", "Isolation B");
    const makerA = await addMember(orgA, "OrgAdmin");
    const adminB = await addMember(orgB, "OrgAdmin");
    const subject = await addMember(await createOrg("corporate", "Isolation Subject Co"), "Issuer");

    // The precondition the trap depends on: both admins are unscoped by use case.
    for (const t of [makerA.token, adminB.token]) {
      const me = await app.inject({ method: "GET", url: `${V1}/me`, headers: auth(t) });
      expect(me.statusCode).toBe(200);
      expect(me.json().useCaseKey ?? null).toBeNull();
    }

    const req = await requestCredential(makerA.token, { type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS });
    expect(req.statusCode).toBe(202);
    const proposal = req.json().proposal as { id: string; useCaseKey: string | null };
    expect(proposal.useCaseKey ?? null).toBeNull();

    // (a) It must not appear in org B's proposal list...
    const listB = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(adminB.token) });
    expect(listB.statusCode).toBe(200);
    expect((listB.json() as Array<{ id: string }>).map((p) => p.id)).not.toContain(proposal.id);

    // ...while org A's own admin does see it.
    const listA = await app.inject({ method: "GET", url: `${V1}/proposals`, headers: auth(makerA.token) });
    expect(listA.statusCode).toBe(200);
    expect((listA.json() as Array<{ id: string }>).map((p) => p.id)).toContain(proposal.id);

    // (b) Approving it must 404 — not 403: an outsider learns nothing of its existence.
    const cross = await approve(adminB.token, proposal.id);
    expect(cross.statusCode).toBe(404);
    const rejectCross = await app.inject({ method: "POST", url: `${V1}/proposals/${proposal.id}/reject`, headers: auth(adminB.token), payload: {} });
    expect(rejectCross.statusCode).toBe(404);
    // Reading it directly is equally opaque.
    const readCross = await app.inject({ method: "GET", url: `${V1}/proposals/${proposal.id}`, headers: auth(adminB.token) });
    expect(readCross.statusCode).toBe(404);

    // The proposal is untouched and still executable by its own org.
    const checkerA = await addMember(orgA, "OrgAdmin");
    const ok = await approve(checkerA.token, proposal.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().proposal.status).toBe("executed");

    // Org B may not read org A's issued credentials either.
    const credsCross = await app.inject({ method: "GET", url: `${V1}/orgs/${orgA.id}/credentials`, headers: auth(adminB.token) });
    expect(credsCross.statusCode).toBe(403);
  });
});

describe("revocation", () => {
  let orgV: Org;
  let maker: Member;
  let checker: Member;
  let subject: Member;
  let credentialId: string;

  beforeAll(async () => {
    orgV = await createOrg("verifier", "Revoke Verifier");
    maker = await addMember(orgV, "OrgAdmin");
    checker = await addMember(orgV, "OrgAdmin");
    subject = await addMember(await createOrg("corporate", "Revoke Subject Co"), "Issuer");
    const req = await requestCredential(maker.token, { type: "KycCredential", subjectUserId: subject.id, claims: KYC_CLAIMS });
    expect(req.statusCode).toBe(202);
    expect((await approve(checker.token, req.json().proposal.id)).json().proposal.status).toBe("executed");
    credentialId = (await myCredentials(subject.token)).find((c) => c.type.includes("KycCredential"))!.id;
  });

  const revoke = (token: string, id: string, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `${V1}/credentials/${id}/revoke`, headers: auth(token), payload: body });

  it("404s an unknown credential id", async () => {
    const res = await revoke(maker.token, "no-such-credential", { reason: "x" });
    expect(res.statusCode).toBe(404);
  });

  it("400s without a reason", async () => {
    expect((await revoke(maker.token, credentialId, {})).statusCode).toBe(400);
    expect((await revoke(maker.token, credentialId, { reason: "" })).statusCode).toBe(400);
  });

  it("only the ISSUING org may revoke", async () => {
    const outsider = await addMember(await createOrg("verifier", "Meddler Verifier"), "OrgAdmin");
    const res = await revoke(outsider.token, credentialId, { reason: "not mine" });
    expect(res.statusCode).toBe(403);
  });

  it("the public status endpoint reports a live credential without auth", async () => {
    const res = await app.inject({ method: "GET", url: `${V1}/credentials/${credentialId}/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: credentialId, revoked: false, revokedAt: null, reason: null, anchored: false, source: "database" });
  });

  it("404s the public status of an unknown id", async () => {
    const res = await app.inject({ method: "GET", url: `${V1}/credentials/nope/status` });
    expect(res.statusCode).toBe(404);
  });

  it("revokes via maker-checker and flips the PUBLIC status, then 409s a re-revoke", async () => {
    const reason = "document forged";
    const req = await revoke(maker.token, credentialId, { reason });
    expect(req.statusCode).toBe(202);
    const proposal = req.json().proposal as { id: string; kind: string; required: number; orgId: string };
    expect(proposal.kind).toBe("revoke-credential");
    expect(proposal.required).toBe(1); // KycCredential's own depth
    expect(proposal.orgId).toBe(orgV.id);

    // Still live until the checker approves.
    const before = await app.inject({ method: "GET", url: `${V1}/credentials/${credentialId}/status` });
    expect(before.json().revoked).toBe(false);

    const decided = await approve(checker.token, proposal.id);
    expect(decided.statusCode).toBe(200);
    expect(decided.json().proposal.status).toBe("executed");

    // The PUBLIC endpoint — no auth header at all.
    const after = await app.inject({ method: "GET", url: `${V1}/credentials/${credentialId}/status` });
    expect(after.statusCode).toBe(200);
    const status = after.json() as Record<string, unknown>;
    expect(status.revoked).toBe(true);
    expect(status.reason).toBe(reason);
    expect(typeof status.revokedAt).toBe("string");

    // ...and it leaks NOTHING else: no claims, no VC, no holder. `anchored` and
    // `source` are the deliberate provenance fields — the point of the on-chain
    // registry sub-project: they say whether the chain or the database answered.
    // This suite runs with no registry, so the chain-only keys (chainId /
    // registry / vcHash) must NOT appear here.
    expect(Object.keys(status).sort()).toEqual(["anchored", "id", "reason", "revoked", "revokedAt", "source"].sort());
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("Ada Lovelace");
    expect(serialized).not.toContain("P1234567");
    expect(serialized).not.toContain("vcJwt");
    expect(serialized).not.toContain("did:key:");

    // The holder's view reflects the revocation.
    const held = (await myCredentials(subject.token)).find((c) => c.id === credentialId)!;
    expect(held.revoked).toBe(true);
    expect(held.revokedReason).toBe(reason);
    expect(typeof held.revokedAt).toBe("string");

    // Re-revoking is a 409.
    const again = await revoke(maker.token, credentialId, { reason: "again" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("ALREADY_REVOKED");
  });

  it("revoking an AuthorizedSignatory costs TWO approvals, like issuing it did", async () => {
    const org = await createOrg("corporate", "Deep Revoke Co");
    const m = await addMember(org, "OrgAdmin");
    const c1 = await addMember(org, "OrgAdmin");
    const c2 = await addMember(org, "OrgAdmin");
    const s = await addMember(org, "Issuer");

    const issue = await requestCredential(m.token, { type: "AuthorizedSignatory", subjectUserId: s.id, claims: { role: "CEO", scope: "all" } });
    await approve(c1.token, issue.json().proposal.id);
    await approve(c2.token, issue.json().proposal.id);
    const id = (await myCredentials(s.token)).find((x) => x.type.includes("AuthorizedSignatory"))!.id;

    const req = await revoke(m.token, id, { reason: "left the company" });
    expect(req.statusCode).toBe(202);
    expect(req.json().proposal.required).toBe(2);

    expect((await approve(c1.token, req.json().proposal.id)).json().proposal.status).toBe("pending");
    expect((await app.inject({ method: "GET", url: `${V1}/credentials/${id}/status` })).json().revoked).toBe(false);

    expect((await approve(c2.token, req.json().proposal.id)).json().proposal.status).toBe("executed");
    expect((await app.inject({ method: "GET", url: `${V1}/credentials/${id}/status` })).json().revoked).toBe(true);
  });
});
