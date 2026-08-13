/**
 * THE ONE QUESTION TOKENIZATION ASKS IDENTITY, OVER HTTP.
 *
 * `POST /identity/assertions` is what a separately-deployed Tokenization
 * instance calls before letting an account receive a token from a use case with
 * `compliance.requireVerifiedIdentity`. In a single deployment the
 * LifecycleEngine asks the same question in-process. The tests below pin the
 * three things that make that safe:
 *
 *   1. SAME ANSWER. The route and `ComplianceProvider.hasVerifiedIdentity` run
 *      one shared predicate, so splitting the deployment cannot change who may
 *      hold a token. A drifting second implementation is the one bug in this
 *      area that would be invisible until an auditor asked why the same account
 *      passed on one topology and failed on the other.
 *   2. MACHINE-ONLY. `requireScope` short-circuits for human sessions — scopes
 *      are a property of API keys — so the scope alone leaves the route open to
 *      every signed-in user. Without the explicit refusal, a Buyer could
 *      enumerate who is KYC'd. This is the "both halves of the gate" failure
 *      wearing a new hat, so it gets its own test.
 *   3. YES/NO ONLY. No claims, no issuer, no credential id. Those stay behind
 *      the holder's consent in the presentation exchange; an assertion that
 *      leaked contents would be a back door around it.
 */
import { describe, expect, it } from "vitest";
import { holdsValidCredential, IDENTITY_CREDENTIAL_TYPE, isValidHeldCredential } from "../src/identity-assertions.js";
import { MemoryCredentialRepository } from "../src/persistence/memory.js";
import type { CredentialRecord } from "../src/persistence/types.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

const HOLDER = "did:key:z6MkHolderUnderTest";

function credential(over: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: `cred_${Math.random().toString(36).slice(2, 10)}`,
    holderDid: HOLDER, issuerDid: "did:key:z6MkIssuer", type: IDENTITY_CREDENTIAL_TYPE,
    vcJwt: "header.payload.sig", subjectClaims: { legalName: "Ada", country: "IN" },
    issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: null,
    revoked: false, revokedAt: null, revokedReason: null, revokedBy: null,
    proposalId: null, credentialUseCaseKey: null,
    acceptance: "accepted", acceptanceAt: null, acceptanceNote: null,
    anchorTxHash: null, anchorChainId: null,
    ...over,
  } as CredentialRecord;
}

/** A peer key holding `identity:assert`, minted through the real route. */
async function peerKey(h: TestAppHandle, admin: string, scopes: string[]): Promise<string> {
  const org = await h.app.inject({
    method: "POST", url: `${V1}/orgs`, headers: auth(admin),
    payload: { name: `Peer ${Math.random().toString(36).slice(2, 8)}`, orgType: "corporate" },
  });
  expect(org.statusCode).toBe(201);
  const key = await h.app.inject({
    method: "POST", url: `${V1}/orgs/${org.json().id}/api-keys`, headers: auth(admin),
    payload: { name: "tokenization peer", role: "Auditor", scopes },
  });
  expect(key.statusCode).toBe(201);
  return key.json().secret as string;
}

const assert = (h: TestAppHandle, cred: string, body: Record<string, unknown>) =>
  h.app.inject({ method: "POST", url: `${V1}/identity/assertions`, headers: auth(cred), payload: body });

describe("POST /identity/assertions", () => {
  it("answers yes for a held credential and no for one the subject does not have", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await h.deps.credentials.create(credential());
    const key = await peerKey(h, admin, ["identity:assert"]);

    const yes = await assert(h, key, { subject: HOLDER });
    expect(yes.statusCode).toBe(200);
    expect(yes.json().holds).toBe(true);
    expect(yes.json().credentialType).toBe(IDENTITY_CREDENTIAL_TYPE);

    expect((await assert(h, key, { subject: HOLDER, credentialType: "AccreditedInvestor" })).json().holds).toBe(false);
    expect((await assert(h, key, { subject: "did:key:z6MkNobody" })).json().holds).toBe(false);
    await h.app.close();
  });

  it("says no once the credential is revoked", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const c = await h.deps.credentials.create(credential());
    const key = await peerKey(h, admin, ["identity:assert"]);
    expect((await assert(h, key, { subject: HOLDER })).json().holds).toBe(true);

    await h.deps.credentials.revoke(c.id, { reason: "lapsed", by: "admin", at: new Date().toISOString() });
    expect((await assert(h, key, { subject: HOLDER })).json().holds).toBe(false);
    await h.app.close();
  });

  it("says no while the holder has not accepted it", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await h.deps.credentials.create(credential({ acceptance: "pending" }));
    const key = await peerKey(h, admin, ["identity:assert"]);
    expect((await assert(h, key, { subject: HOLDER })).json().holds).toBe(false);
    await h.app.close();
  });

  it("returns a verdict and nothing else — no claims, issuer or credential id", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await h.deps.credentials.create(credential());
    const key = await peerKey(h, admin, ["identity:assert"]);

    const body = (await assert(h, key, { subject: HOLDER })).json();
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "credentialType", "holds", "subject"]);
    const serialised = JSON.stringify(body);
    for (const leak of ["Ada", "did:key:z6MkIssuer", "header.payload.sig", "cred_"]) {
      expect(serialised, `must not disclose ${leak}`).not.toContain(leak);
    }
    await h.app.close();
  });
});

describe("who may ask", () => {
  it("REFUSES A HUMAN SESSION — even a platform admin's", async () => {
    // The trap: `requireScope` passes every human session, so `authScoped`
    // alone would make this route readable by anyone with a login.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const res = await assert(h, admin, { subject: HOLDER });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("SESSION_PRINCIPAL");
    await h.app.close();
  });

  it("refuses a key without the scope", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const key = await peerKey(h, admin, ["credentials:read"]);
    expect((await assert(h, key, { subject: HOLDER })).statusCode).toBe(403);
    await h.app.close();
  });

  it("refuses an anonymous caller", async () => {
    const h = await buildTestAppWithRepos();
    const res = await h.app.inject({ method: "POST", url: `${V1}/identity/assertions`, payload: { subject: HOLDER } });
    expect(res.statusCode).toBe(401);
    await h.app.close();
  });
});

describe("every assertion is audited", () => {
  it("records who asked, about whom, and the answer given", async () => {
    // A key with this scope may ask about ANY subject — there is no tenant
    // boundary on "is this DID KYC'd" when the caller is a peer platform. The
    // compensating control is that asking is never silent.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await h.deps.credentials.create(credential());
    const key = await peerKey(h, admin, ["identity:assert"]);
    await assert(h, key, { subject: HOLDER });

    const entries = await h.audit.list();
    const asserted = entries.filter((e) => e.action === "identity-asserted");
    expect(asserted).toHaveLength(1);
    expect(asserted[0].payload).toMatchObject({ subject: HOLDER, credentialType: IDENTITY_CREDENTIAL_TYPE, holds: true });
    expect(asserted[0].actorId).toBeTruthy();
    await h.app.close();
  });
});

describe("the predicate the engine and the route share", () => {
  it("is one function, so an in-process answer and a remote one cannot diverge", async () => {
    // Same inputs, same verdict — asserted directly on the shared predicate
    // that `hasVerifiedIdentity` and the route both call.
    const repo = new MemoryCredentialRepository();
    await repo.create(credential());
    expect(await holdsValidCredential(repo, HOLDER, IDENTITY_CREDENTIAL_TYPE)).toBe(true);
    expect(await holdsValidCredential(repo, HOLDER, "SomethingElse")).toBe(false);
    expect(await holdsValidCredential(repo, "did:key:z6MkOther", IDENTITY_CREDENTIAL_TYPE)).toBe(false);
  });

  it.each([
    ["accepted + unrevoked", {}, true],
    ["revoked", { revoked: true }, false],
    ["pending acceptance", { acceptance: "pending" as const }, false],
    ["rejected by holder", { acceptance: "rejected" as const }, false],
  ])("%s → %s", (_label, over, expected) => {
    expect(isValidHeldCredential(credential(over), IDENTITY_CREDENTIAL_TYPE)).toBe(expected);
  });

  it("DOES NOT check expiry — a known gap, pinned so the fix is a deliberate change", () => {
    // The certificate renderer stamps EXPIRED and the identity dashboard counts
    // an expired credential as expired, while this predicate still says yes.
    // That inconsistency predates the split and was preserved on purpose so the
    // extraction changed no behaviour. This test is the reminder, and it is the
    // test that will fail — loudly, in one place — when expiry is added.
    const expired = credential({ expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(isValidHeldCredential(expired, IDENTITY_CREDENTIAL_TYPE)).toBe(true);
  });
});
