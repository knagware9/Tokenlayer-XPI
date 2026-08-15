/**
 * EN-D2 · A SANDBOX ACT MUST NEVER WRITE TO A REAL CHAIN.
 *
 * A live walkthrough against real Besu disproved the feature's central promise:
 * a sandbox credential issuance moved the operator's transaction count by one
 * and left a real record in `VcRegistry.statusOf`. Every HTTP response along the
 * way was a 2xx. The gap was structural — `sandboxChainsValid` governs a use
 * case's CHAINS and `modeGate` governs its PRINCIPALS, but credential anchoring
 * goes through neither: it writes to the platform registry on
 * `REGISTRY_CHAIN_ID` via `deps.registry`, which is resolved once at boot and
 * consults no use case at all.
 *
 * SO THIS FILE DOES NOT ASSERT "WE DID NOT CALL THE ANCHOR". A unit test shaped
 * like that passes happily while a second code path — revocation, org DID
 * registration, the audit anchor, a mint — reaches the same chain by another
 * door, which is exactly how the defect survived a whole task's worth of
 * review. Instead it ARMS THE CHAIN-FACING SURFACE ITSELF:
 *
 *   * `TrapAnchor` replaces the identity registry's `CredentialAnchor`. Every
 *     write method records the attempt and throws.
 *   * `trapNonSandboxChains` replaces `ChainRegistry.resolveAdapter`, so ANY
 *     ledger call for a chain other than `sandbox` records and throws.
 *
 * Once armed, nothing the sandbox does can reach a chain without being caught,
 * whether or not this file thought to assert about that particular door. A
 * missed door shows up as a 500 and a non-empty `attempts` list, not as a green
 * test.
 *
 * The positive control runs FIRST, on the same instruments: the live flows must
 * still anchor, mint and register. A no-write assertion is worthless without it
 * — "no writes reached the chain" is trivially true of a harness that does
 * nothing at all, which is precisely why the walkthrough measured
 * `eth_getTransactionCount` on both halves.
 */
import type { CredentialAnchor, DidRegistration, OnChainCredentialStatus } from "@tokenlayer/adapters";
import { SANDBOX_CHAIN_ID, type UseCaseDefinition } from "@tokenlayer/core";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { mintSecret } from "../src/shared/api-keys.js";
import type { AppDeps } from "../src/context.js";
import type { IdentityRegistry } from "../src/identity/registry.js";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";
import { auth, buildTestAppWithRepos, loginAs, PLATFORM_ADMIN_2, V1, type TestAppHandle } from "./helpers.js";

const ROUNDS = 4;

/**
 * A `CredentialAnchor` that cannot be written to. Reads answer "absent" (the
 * honest answer for a chain that holds nothing) so a status route still works;
 * every WRITE records its name and throws, so a sandbox act that reaches one
 * fails loudly instead of passing quietly.
 */
class TrapAnchor implements CredentialAnchor {
  readonly attempts: string[] = [];
  private trap(op: string): never {
    this.attempts.push(op);
    throw new Error(`TRAP: a sandbox act reached the real chain via ${op}`);
  }
  async deployRegistries(): Promise<{ didRegistry: string; vcRegistry: string; txHash: string }> { return this.trap("deployRegistries"); }
  async registerDid(): Promise<never> { return this.trap("registerDid"); }
  async deactivateDid(): Promise<never> { return this.trap("deactivateDid"); }
  async anchorCredential(): Promise<never> { return this.trap("anchorCredential"); }
  async revokeCredential(): Promise<never> { return this.trap("revokeCredential"); }
  // Reads are permitted and unrecorded — this file is about WRITES. (Reads are
  // still narrowed in the product: `/status` short-circuits a sandbox
  // credential before it asks a chain anything.)
  async didRegistration(): Promise<DidRegistration> { return { registered: false, active: false }; }
  async credentialStatusOf(): Promise<OnChainCredentialStatus> {
    return { exists: false, revoked: false, revokedAt: null, vcHash: `0x${"0".repeat(64)}` };
  }
}

/**
 * Swap `resolveAdapter` in place so every ledger call for a non-sandbox chain
 * records and throws.
 *
 * IN PLACE, not a new registry object: `createEngine` closes over the SAME
 * `ChainRegistry` and calls `chains.resolveAdapter(...)` late, so mutating the
 * property re-points the lifecycle engine, the audit anchor route and the
 * deploy path together. Handing the app a different object would have left the
 * engine — the thing that actually mints — pointing at the untrapped one, and
 * the test would prove nothing while looking thorough.
 */
function trapNonSandboxChains(deps: AppDeps, attempts: string[]): void {
  const inner = deps.chains.resolveAdapter.bind(deps.chains);
  deps.chains.resolveAdapter = (chainId: string) => {
    const real = inner(chainId);
    if (chainId === SANDBOX_CHAIN_ID) return real;
    return new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          void args;
          attempts.push(`chain:${chainId}.${String(prop)}`);
          throw new Error(`TRAP: a sandbox act reached chain '${chainId}' via ${String(prop)}`);
        };
      },
    });
  };
}

const sandboxUseCaseDef = (key: string): UseCaseDefinition => ({
  key, name: key, tokenStandard: "ERC-20", tokenType: "fungible", symbol: "SBX",
  allowedChainIds: [SANDBOX_CHAIN_ID], defaultChainId: SANDBOX_CHAIN_ID,
  metadataSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  lifecycle: { mint: true, transfer: true, burn: true, freeze: false },
  compliance: { allowlist: false, transferRestrictions: false },
  roles: ["Issuer"], sandbox: true,
});

const liveUseCaseDef = (key: string): UseCaseDefinition => ({
  ...sandboxUseCaseDef(key), key, name: key,
  allowedChainIds: ["fabric"], defaultChainId: "fabric", sandbox: false,
});

const eduParams = (org: string) => ({ issuerOrgName: org, programmeName: "BSc" });

/** A test/live API key bound to `orgId`, minted straight through the repos. */
async function seedOrgKey(h: TestAppHandle, orgId: string, mode: "live" | "test", role = "OrgAdmin") {
  const tag = Math.random().toString(36).slice(2, 10);
  const svc = await h.users.create({
    email: `svc-nw-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync(`p-${tag}`, ROUNDS),
    role: role as never, useCaseKey: null, accountId: null, active: true,
    kycStatus: "approved", kyc: null, orgId, kind: "service",
  });
  const minted = await mintSecret(ROUNDS, mode);
  await h.apiKeys.create({
    orgId, userId: svc.id, name: `nw ${tag}`, prefix: minted.prefix,
    secretHash: minted.hash, scopes: ["*"], expiresAt: null, createdBy: "test", mode,
  });
  return minted.secret;
}

async function holderWithDid(h: TestAppHandle, tag: string): Promise<string> {
  const u = await h.users.create({
    email: `holder-nw-${tag}@tokenlayer.dev`, passwordHash: bcrypt.hashSync("h", ROUNDS),
    role: "Holder", useCaseKey: null, accountId: null, active: true,
    kycStatus: "approved", kyc: null, orgId: null, kind: "human",
  });
  await h.users.update(u.id, { did: `did:key:z6MkNW${tag}`, didSeedEncrypted: "enc" });
  return u.id;
}

const degreeClaims = (org: string) => ({ studentName: "A. Student", institution: org, degree: "BSc", conferredYear: 2026 });

/**
 * The whole world both halves of this file share: a real org (its DID
 * registered on the LIVE anchor, as any org's is), a live credential programme
 * and a sandbox one on the same org, a live tokenization use case and a sandbox
 * one, and a key for each environment.
 */
async function world() {
  const live = new FakeAnchor();
  const h = await buildTestAppWithRepos({ registry: fakeRegistry(live) });
  const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
  // SoD: a proposer may never decide their own proposal, so the LIVE control
  // half (proposed by `admin`) needs a second PlatformAdmin to approve.
  const admin2 = await loginAs(h.app, PLATFORM_ADMIN_2.email, PLATFORM_ADMIN_2.password);

  // A real organization, created the ordinary (live) way — this is the DID
  // registration that a sandbox act must never perform, done deliberately here.
  const orgRes = await h.app.inject({
    method: "POST", url: `${V1}/orgs`, headers: auth(admin),
    payload: { name: "Trap University", orgType: "government" },
  });
  expect(orgRes.statusCode).toBe(201);
  const orgId = orgRes.json().id as string;

  const provision = (sandbox: boolean, orgName: string) => h.app.inject({
    method: "POST", url: `${V1}/credential-use-cases/provision`, headers: auth(admin),
    payload: {
      templateKey: "education-certificate", params: eduParams(orgName), sandbox,
      provisioning: { createDeskUsers: false },
    },
  });

  const sbx = await provision(true, "Trap University");
  expect(sbx.statusCode).toBe(201);
  const sandboxProgramme = sbx.json().useCase.key as string;
  expect(sbx.json().useCase.sandbox).toBe(true);

  // A LIVE programme on a second real org, for the control half.
  const liveOrgRes = await h.app.inject({
    method: "POST", url: `${V1}/orgs`, headers: auth(admin),
    payload: { name: "Real University", orgType: "government" },
  });
  const liveOrgId = liveOrgRes.json().id as string;
  const lv = await provision(false, "Real University");
  expect(lv.statusCode).toBe(201);
  const liveProgramme = lv.json().useCase.key as string;

  await h.deps.useCases.create(sandboxUseCaseDef("nw-sandbox-tok"));
  await h.deps.useCases.create(liveUseCaseDef("nw-live-tok"));

  return {
    h, admin, admin2, orgId, liveOrgId, sandboxProgramme, liveProgramme, live,
    testKey: await seedOrgKey(h, orgId, "test"),
    liveKey: await seedOrgKey(h, liveOrgId, "live"),
  };
}

/** Draft an issuance and approve it; returns the approval response. */
async function issueAndApprove(h: TestAppHandle, cred: string, approver: string, programme: string, orgName: string, holderId: string) {
  const draft = await h.app.inject({
    method: "POST", url: `${V1}/credential-use-cases/${programme}/credentials`, headers: auth(cred),
    payload: { credentialType: "DegreeCredential", subjectUserId: holderId, claims: degreeClaims(orgName) },
  });
  expect(draft.statusCode).toBe(202);
  const approved = await h.app.inject({
    method: "POST", url: `${V1}/proposals/${draft.json().proposal.id}/approve`, headers: auth(approver), payload: {},
  });
  expect(approved.statusCode).toBe(200);
  expect(approved.json().proposal.status).toBe("executed");
  return approved;
}

describe("EN-D2 · the control: a LIVE act still reaches the chain", () => {
  it("a live issuance anchors, a live revocation revokes on-chain, and a live mint hits the ledger", async () => {
    // WITHOUT THIS, the no-write test below could pass on a platform that had
    // stopped anchoring altogether. It is the second half of the walkthrough
    // that found the defect (1386 → 1387), reproduced in the harness.
    const w = await world();
    const holder = await holderWithDid(w.h, "live");

    expect(w.live.credentials.size).toBe(0);
    await issueAndApprove(w.h, w.admin, w.admin2, w.liveProgramme, "Real University", holder);
    expect(w.live.credentials.size).toBe(1);
    const credentialId = [...w.live.credentials.keys()][0]!;

    // …and the status route reports the CHAIN as its source.
    const status = await w.h.app.inject({ method: "GET", url: `${V1}/credentials/${credentialId}/status` });
    expect(status.json()).toMatchObject({ anchored: true, source: "chain" });
    expect(status.json().sandbox).toBeUndefined();

    // Revocation is chain-first, so the on-chain record must flip too.
    const rev = await w.h.app.inject({
      method: "POST", url: `${V1}/credentials/${credentialId}/revoke`, headers: auth(w.admin),
      payload: { reason: "control" },
    });
    expect(rev.statusCode).toBe(202);
    const done = await w.h.app.inject({
      method: "POST", url: `${V1}/proposals/${rev.json().proposal.id}/approve`, headers: auth(w.admin2), payload: {},
    });
    expect(done.json().proposal.status).toBe("executed");
    expect(w.live.credentials.get(credentialId)?.revoked).toBe(true);

    // And an org DID registration is a real write on the same instrument.
    expect(w.live.dids.size).toBeGreaterThanOrEqual(2);
  });
});

describe("EN-D2 · a sandbox act reaches NO chain", () => {
  it("issuing, revoking, minting, anchoring audit and onboarding in the sandbox write nothing", async () => {
    const w = await world();
    const holder = await holderWithDid(w.h, "sbx");
    const holder2 = await holderWithDid(w.h, "sbx2");

    // ARM THE TRAP. Everything above was setup done in the live world; from
    // here on, any call to any chain other than `sandbox`, and any write to the
    // identity registry at all, is a recorded failure.
    const trap = new TrapAnchor();
    const attempts: string[] = [];
    w.h.deps.registry = { chainId: "besu", didRegistry: "0xdid", vcRegistry: "0xvc", deployTxHash: "0xdeploy", anchor: trap } satisfies IdentityRegistry;
    trapNonSandboxChains(w.h.deps, attempts);
    const clean = () => [...trap.attempts, ...attempts];

    // 1. CREDENTIAL ISSUANCE — the path the walkthrough proved. 202 → approve →
    //    the holder holds it, and nothing was anchored.
    await issueAndApprove(w.h, w.testKey, w.admin, w.sandboxProgramme, "Trap University", holder);
    expect(clean()).toEqual([]);

    const held = await w.h.deps.credentials.listByHolder(`did:key:z6MkNWsbx`);
    expect(held).toHaveLength(1);
    const cred = held[0]!;
    expect(cred.anchorTxHash).toBeNull();
    // The row carries the durable marker that makes every later negative
    // enforceable from the credential alone.
    expect(cred.anchorChainId).toBe(SANDBOX_CHAIN_ID);

    // 2. THE PUBLIC STATUS ROUTE IS HONEST ABOUT IT — and specifically does NOT
    //    look like the `database` fallback, which also means "the anchor failed".
    const status = await w.h.app.inject({ method: "GET", url: `${V1}/credentials/${cred.id}/status` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ id: cred.id, anchored: false, source: "sandbox", sandbox: true });

    // 3. REVOCATION is a chain write too — it must not happen either, and the
    //    credential must still end up revoked in the database.
    const rev = await w.h.app.inject({
      method: "POST", url: `${V1}/credentials/${cred.id}/revoke`, headers: auth(w.testKey),
      payload: { reason: "sandbox rehearsal" },
    });
    expect(rev.statusCode).toBe(202);
    const revDone = await w.h.app.inject({
      method: "POST", url: `${V1}/proposals/${rev.json().proposal.id}/approve`, headers: auth(w.admin), payload: {},
    });
    expect(revDone.json().proposal.status).toBe("executed");
    expect((await w.h.deps.credentials.get(cred.id))?.revoked).toBe(true);
    expect((await w.h.deps.credentials.get(cred.id))?.revokeTxHash).toBeNull();
    expect(clean()).toEqual([]);

    // 4. ASSET LIFECYCLE on a sandbox use case: deploy + mint + transfer + burn.
    //    The chain rule should already route these to the simulated adapter —
    //    ASSERTED, not assumed, because the walkthrough only exercised identity.
    const deployed = await w.h.app.inject({
      method: "POST", url: `${V1}/use-cases/nw-sandbox-tok/deploy`, headers: auth(w.admin),
      payload: { chainId: SANDBOX_CHAIN_ID },
    });
    expect(deployed.statusCode).toBe(200);
    const asset = await w.h.app.inject({
      method: "POST", url: `${V1}/assets`, headers: auth(w.admin),
      payload: {
        useCaseKey: "nw-sandbox-tok", name: "sandbox asset", chainId: SANDBOX_CHAIN_ID,
        metadata: { ref: "SBX-1" }, treasuryAccount: TREASURY, initialSupply: "100",
      },
    });
    expect(asset.statusCode).toBe(201);
    const assetId = asset.json().asset.id as string;
    for (const [action, body] of [
      ["mint", { to: TREASURY, amount: "50" }],
      ["transfer", { from: TREASURY, to: COUNTERPARTY, amount: "10" }],
      ["burn", { from: TREASURY, amount: "5" }],
    ] as const) {
      const res = await w.h.app.inject({
        method: "POST", url: `${V1}/assets/${assetId}/actions/${action}`, headers: auth(w.admin), payload: body,
      });
      expect([200, 201, 202]).toContain(res.statusCode);
    }
    expect(clean()).toEqual([]);

    // 5. POST /audit/anchor — a WRITE per asset, on each asset's own chain.
    //    Exercised as the test key (narrowed to sandbox use cases) AND as the
    //    human PlatformAdmin, whose selection spans BOTH environments and so is
    //    the one that would drag a sandbox asset onto a real chain if the
    //    asset's chain were not the sandbox one.
    // A PlatformAdmin-roled TEST key: its selection spans every use case and is
    // then narrowed to the sandbox by `modeVisibleUseCaseKeys` (the D2-6 fix) —
    // this is the machine half. The human below is the half that fix does not
    // cover, and so the one that depends on the asset's own chain being simulated.
    const testAdminKey = await seedOrgKey(w.h, w.orgId, "test", "PlatformAdmin");
    for (const anchorer of [testAdminKey, w.admin]) {
      const res = await w.h.app.inject({ method: "POST", url: `${V1}/audit/anchor`, headers: auth(anchorer), payload: {} });
      expect(res.statusCode).toBe(200);
    }
    expect(clean()).toEqual([]);

    // 6. ONBOARDING A USER INTO A SANDBOX USE CASE issues a KycCredential whose
    //    `credentialUseCaseKey` is null — it belongs to the closed catalog —
    //    while the act itself is governed by a TOKENIZATION use case. Nothing on
    //    the credential could have answered "am I sandbox?"; the call site has
    //    to, which is why `issueCredentialFor` demands it.
    const onboard = await w.h.app.inject({
      method: "POST", url: `${V1}/users`, headers: auth(w.admin),
      payload: {
        email: "rehearsal@trap.test", password: "rehearsal-pw", role: "Issuer",
        useCaseKey: "nw-sandbox-tok", kyc: { legalName: "Rehearsal Ltd", country: "IN" },
      },
    });
    expect(onboard.statusCode).toBe(202);
    const onboarded = await w.h.app.inject({
      method: "POST", url: `${V1}/proposals/${onboard.json().proposal.id}/approve`,
      headers: auth(w.admin2), payload: {},
    });
    if (onboarded.json().proposal?.status !== "executed") console.log("ONBOARD FAIL", onboarded.payload);
    expect(onboarded.json().proposal.status).toBe("executed");
    const rehearsal = await w.h.users.findByEmail("rehearsal@trap.test");
    const kyc = (await w.h.deps.credentials.listByHolder(rehearsal!.did!));
    expect(kyc).toHaveLength(1);
    expect(kyc[0]!.credentialUseCaseKey).toBeNull();      // the closed catalog: nothing on the row named a use case
    expect(kyc[0]!.anchorTxHash).toBeNull();
    expect(kyc[0]!.anchorChainId).toBe(SANDBOX_CHAIN_ID); // …and yet it is correctly marked sandbox
    expect(clean()).toEqual([]);

    // 7. PROVISIONING A SANDBOX PROGRAMME THAT CREATES ITS ISSUER ORG. Minting
    //    an organization registers its DID on the real DidRegistry — the third
    //    door, and the one furthest from anything named "sandbox". It still
    //    succeeds (one-call provisioning is how a sandbox programme is meant to
    //    come into existence, and refusing it would have closed the feature
    //    rather than the hole); it simply does not register.
    const fresh = await w.h.app.inject({
      method: "POST", url: `${V1}/credential-use-cases/provision`, headers: auth(w.admin),
      payload: {
        templateKey: "education-certificate", params: eduParams("Rehearsal University"),
        sandbox: true, provisioning: { createDeskUsers: false },
      },
    });
    expect(fresh.statusCode).toBe(201);
    const freshOrg = await w.h.organizations.findByName("Rehearsal University");
    expect(freshOrg).toBeTruthy();      // the org is REAL — it signs, it owns, it lists
    expect(freshOrg!.did).toBeTruthy(); // …with a real custodial DID
    expect(clean()).toEqual([]);        // …and not one byte of it reached a chain

    // 8. A SECOND SANDBOX ISSUANCE on the first org — the whole sandbox is
    //    still working, not merely quiet.
    await issueAndApprove(w.h, w.testKey, w.admin, w.sandboxProgramme, "Trap University", holder2);
    expect(clean()).toEqual([]);

    // THE WHOLE-RUN ASSERTION. Not "the anchor was not called" — NOTHING
    // chain-facing was touched at all, by any door, named or unnamed.
    expect(trap.attempts).toEqual([]);
    expect(attempts).toEqual([]);
  });
});

const TREASURY = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const COUNTERPARTY = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

describe("EN-D2 · a sandbox proposal publishes a SANDBOX fact", () => {
  it("proposal.executed for a sandbox issuance is mode test, and the test key reads back its own approval", async () => {
    // THE `GET /events` GAP THE SAME WALKTHROUGH SHOWED. `credential.issued`
    // was already correct — its `useCaseKey` names the sandbox programme, so
    // `deriveMode` labels it `test`. `proposal.executed` was NOT: a
    // credential-use-case proposal is ORG-scoped, so its `useCaseKey` column is
    // null and the programme appears only inside its payload, which meant every
    // sandbox approval was published as a LIVE fact — delivered to the org's
    // production webhook endpoints, and invisible to the very key that drafted
    // it.
    const w = await world();
    const holder = await holderWithDid(w.h, "ev");
    await issueAndApprove(w.h, w.testKey, w.admin, w.sandboxProgramme, "Trap University", holder);

    const rows = await w.h.deps.events.listAfter(0, { limit: 100 });
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(byType["credential.issued"]?.mode).toBe("test");
    expect(byType["proposal.executed"]?.mode).toBe("test");

    // Over HTTP, through the mode-narrowed cursor: the test key sees BOTH.
    const asTest = await w.h.app.inject({ method: "GET", url: `${V1}/events`, headers: auth(w.testKey) });
    expect(asTest.statusCode).toBe(200);
    const types = (asTest.json().events as { type: string; mode: string }[]);
    expect(types.map((e) => e.type).sort()).toEqual(["credential.issued", "proposal.executed"]);
    expect(types.every((e) => e.mode === "test")).toBe(true);

    // …and a LIVE key of the same org sees neither. Not merely absent from the
    // parsed list — absent from the raw text, so a payload nested one level
    // deeper than the assertion cannot smuggle a sandbox fact into a production
    // integration.
    const liveOfSameOrg = await seedOrgKey(w.h, w.orgId, "live");
    const asLive = await w.h.app.inject({ method: "GET", url: `${V1}/events`, headers: auth(liveOfSameOrg) });
    expect(asLive.json().events).toEqual([]);
    expect(asLive.payload).not.toContain("credential.issued");

    // The LIVE half is unmoved: a live proposal still publishes a live fact.
    const liveHolder = await holderWithDid(w.h, "ev2");
    await issueAndApprove(w.h, w.admin, w.admin2, w.liveProgramme, "Real University", liveHolder);
    const after = await w.h.deps.events.listAfter(0, { limit: 100 });
    const liveRows = after.filter((r) => r.orgId === w.liveOrgId);
    expect(liveRows.length).toBeGreaterThanOrEqual(2);
    expect(liveRows.every((r) => r.mode === "live")).toBe(true);
  });
});
