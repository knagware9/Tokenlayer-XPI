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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  holdsValidCredential,
  httpIdentityAssertions,
  IDENTITY_CREDENTIAL_TYPE,
  isExpired,
  isValidHeldCredential,
  localIdentityAssertions,
  selectIdentityAssertions,
  unavailableIdentityAssertions,
} from "../src/identity/identity-assertions.js";
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

  it("says no for a credential that has expired", async () => {
    // Through the ROUTE, not just the predicate: the HTTP surface is where an
    // integrator meets this rule, and it is the answer a split deployment acts
    // on. Before the expiry fix this returned true — a lapsed KYC would still
    // have opened the tokenization gate.
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await h.deps.credentials.create(credential({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    const key = await peerKey(h, admin, ["identity:assert"]);
    expect((await assert(h, key, { subject: HOLDER })).json().holds).toBe(false);
    await h.app.close();
  });

  it("says yes for one whose expiry is still ahead", async () => {
    const h = await buildTestAppWithRepos();
    const admin = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    await h.deps.credentials.create(credential({ expiresAt: "2099-01-01T00:00:00.000Z" }));
    const key = await peerKey(h, admin, ["identity:assert"]);
    expect((await assert(h, key, { subject: HOLDER })).json().holds).toBe(true);
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

  it("treats an EXPIRED credential as invalid, like every other component already did", () => {
    // The gate used to say yes here while the verification exchange
    // (`notExpired`), the certificate renderer (the EXPIRED watermark) and the
    // identity dashboard (the "expired" bucket) all said the credential was
    // finished. Four components, two answers, and the dissenter was the one
    // enforcing compliance.
    const expired = credential({ expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(isValidHeldCredential(expired, IDENTITY_CREDENTIAL_TYPE)).toBe(false);
  });

  it.each([
    ["no expiry at all", null, false],
    ["expires in the future", "2099-01-01T00:00:00.000Z", false],
    ["expired long ago", "2020-01-01T00:00:00.000Z", true],
  ])("%s → expired=%s", (_label, expiresAt, expected) => {
    expect(isExpired(credential({ expiresAt }), Date.parse("2026-08-13T00:00:00.000Z"))).toBe(expected);
  });

  it("is expired STRICTLY after the instant, so the expiry moment itself is still valid", () => {
    // Matches the certificate renderer's `< nowMs` exactly. A boundary picked by
    // one component and guessed by another is how the two drift apart again.
    const at = "2026-08-13T00:00:00.000Z";
    const t = Date.parse(at);
    expect(isExpired(credential({ expiresAt: at }), t)).toBe(false);
    expect(isExpired(credential({ expiresAt: at }), t + 1)).toBe(true);
  });

  it("compares instants, not strings — an offset timestamp does not fool it", () => {
    // `2026-08-13T05:30:00+05:30` IS midnight UTC. Lexicographically it sorts
    // after "2026-08-13T00:00:00.000Z" and a string compare would call it
    // unexpired an hour after it lapsed.
    const offset = credential({ expiresAt: "2026-08-13T05:30:00+05:30" });
    expect(isExpired(offset, Date.parse("2026-08-13T00:00:01.000Z"))).toBe(true);
  });

  it("the async wrapper agrees with the predicate on expiry", async () => {
    const repo = new MemoryCredentialRepository();
    await repo.create(credential({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    expect(await holdsValidCredential(repo, HOLDER, IDENTITY_CREDENTIAL_TYPE)).toBe(false);
  });
});

/**
 * THE SEAM THE PRODUCT SPLIT TURNS ON.
 *
 * `IdentityAssertions` is one method with three implementations — the local
 * store, an HTTP call to a separately-deployed Identity service, and a refusal
 * for the deployment that was given neither. What these tests protect is not
 * the plumbing but the two decisions inside it:
 *
 *   · FAIL-CLOSED IS NOT THE SAME AS `false`. A timeout, a 500 or a rejected
 *     peer key must THROW. Returning `false` would report "this holder is not
 *     verified" for what is really "we could not ask", and send an operator to
 *     the holder's credentials instead of to the network.
 *   · NO WALLET CROSSES THE WIRE. The question is asked about a DID. Address →
 *     account → user → DID resolution stays on tokenization's side, because a
 *     wallet is a tokenization concept and Identity has no business learning
 *     about them.
 */
describe("the identity assertions seam", () => {
  const DID = "did:key:z6MkRemoteHolder";

  /** A fetch double that records the one call it is given. */
  function stubFetch(reply: Response | Error) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (reply instanceof Error) throw reply;
      return reply;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("relays the service's verdict, both ways", async () => {
    for (const verdict of [true, false]) {
      const { impl } = stubFetch(json({ subject: DID, credentialType: IDENTITY_CREDENTIAL_TYPE, holds: verdict }));
      const remote = httpIdentityAssertions({ baseUrl: "https://id.example.com/api/v1", apiKey: "tl_live_x", fetchImpl: impl });
      expect(await remote.holds(DID, IDENTITY_CREDENTIAL_TYPE)).toBe(verdict);
    }
  });

  it("calls the assertion route with the peer key and the DID — and nothing else", async () => {
    const { impl, calls } = stubFetch(json({ holds: true }));
    // Trailing slash on purpose: an operator writes the base URL by hand.
    const remote = httpIdentityAssertions({ baseUrl: "https://id.example.com/api/v1/", apiKey: "tl_live_secret", fetchImpl: impl });
    await remote.holds(DID, IDENTITY_CREDENTIAL_TYPE);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://id.example.com/api/v1/identity/assertions");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tl_live_secret");

    // The body carries a DID and a credential type. Anything else — an address,
    // an asset id, a use-case key — would be tokenization leaking across the
    // boundary, and the point of the split is that it does not.
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ subject: DID, credentialType: IDENTITY_CREDENTIAL_TYPE });
  });

  it.each([
    ["a refused connection", new Error("fetch failed: ECONNREFUSED")],
    ["a timeout", Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })],
  ])("throws IDENTITY_SERVICE_UNAVAILABLE on %s — it never answers `false`", async (_label, err) => {
    const { impl } = stubFetch(err);
    const remote = httpIdentityAssertions({ baseUrl: "https://id.example.com", apiKey: "k", fetchImpl: impl });
    await expect(remote.holds(DID, IDENTITY_CREDENTIAL_TYPE)).rejects.toMatchObject({
      name: "PolicyError", code: "IDENTITY_SERVICE_UNAVAILABLE",
    });
  });

  it.each([401, 403, 404, 500, 503])("throws on HTTP %i rather than treating it as a denial", async (status) => {
    const { impl } = stubFetch(json({ error: "FORBIDDEN" }, status));
    const remote = httpIdentityAssertions({ baseUrl: "https://id.example.com", apiKey: "k", fetchImpl: impl });
    await expect(remote.holds(DID, IDENTITY_CREDENTIAL_TYPE)).rejects.toMatchObject({
      code: "IDENTITY_SERVICE_UNAVAILABLE", details: { status },
    });
  });

  it("throws when a 200 carries no boolean verdict", async () => {
    // A wrong-shaped 200 is the shape a proxy, a login page or a version skew
    // produces. `undefined` is falsy, so a naive `return body.holds` would
    // refuse every holder and look like policy.
    for (const body of [{}, { holds: "yes" }, { holds: null }]) {
      const { impl } = stubFetch(json(body));
      const remote = httpIdentityAssertions({ baseUrl: "https://id.example.com", apiKey: "k", fetchImpl: impl });
      await expect(remote.holds(DID, IDENTITY_CREDENTIAL_TYPE)).rejects.toMatchObject({
        code: "IDENTITY_SERVICE_UNAVAILABLE",
      });
    }
  });

  it("the local implementation answers from the store", async () => {
    const repo = new MemoryCredentialRepository();
    const local = localIdentityAssertions(repo);
    expect(await local.holds(HOLDER, IDENTITY_CREDENTIAL_TYPE)).toBe(false);
    await repo.create(credential());
    expect(await local.holds(HOLDER, IDENTITY_CREDENTIAL_TYPE)).toBe(true);
  });

  it("the unavailable implementation refuses loudly instead of denying quietly", async () => {
    await expect(unavailableIdentityAssertions("not configured").holds(DID, IDENTITY_CREDENTIAL_TYPE))
      .rejects.toMatchObject({ code: "IDENTITY_SERVICE_UNAVAILABLE" });
  });

  describe("selection at boot", () => {
    const repo = new MemoryCredentialRepository();
    const base = { credentials: repo };

    it("a deployment running the identity domain answers from its own store", async () => {
      await repo.create(credential());
      const chosen = selectIdentityAssertions({ ...base, enabledDomains: ["tokenization", "identity"] });
      expect(await chosen.holds(HOLDER, IDENTITY_CREDENTIAL_TYPE)).toBe(true);
    });

    it("a tokenization-only deployment with a service URL asks the service", async () => {
      const { impl, calls } = stubFetch(json({ holds: true }));
      const chosen = selectIdentityAssertions({
        ...base, enabledDomains: ["tokenization"],
        serviceUrl: "https://id.example.com/api/v1", serviceKey: "k", fetchImpl: impl,
      });
      // `true` although the LOCAL store holds nothing for this DID: proof the
      // remote answered, not the store that happens to be in the same process.
      expect(await chosen.holds(DID, IDENTITY_CREDENTIAL_TYPE)).toBe(true);
      expect(calls[0]!.url).toBe("https://id.example.com/api/v1/identity/assertions");
    });

    it("a tokenization-only deployment with NO service refuses — it does not fall back to a store it does not own", async () => {
      // The local store exists in-process (one binary, two products), so a
      // fallback would compile and pass every test while quietly re-merging the
      // two deployments' answers. This is the case that has to throw.
      await repo.create(credential());
      const chosen = selectIdentityAssertions({ ...base, enabledDomains: ["tokenization"] });
      await expect(chosen.holds(HOLDER, IDENTITY_CREDENTIAL_TYPE)).rejects.toMatchObject({
        code: "IDENTITY_SERVICE_UNAVAILABLE",
      });
    });

    it("half a remote configuration is not a remote configuration", async () => {
      // env.ts refuses this pair at boot; the selector must not silently treat a
      // keyless URL as configured and send an unauthenticated request.
      const { impl, calls } = stubFetch(json({ holds: true }));
      const chosen = selectIdentityAssertions({
        ...base, enabledDomains: ["tokenization"], serviceUrl: "https://id.example.com", fetchImpl: impl,
      });
      await expect(chosen.holds(DID, IDENTITY_CREDENTIAL_TYPE)).rejects.toMatchObject({
        code: "IDENTITY_SERVICE_UNAVAILABLE",
      });
      expect(calls).toHaveLength(0);
    });
  });
});

/**
 * THE TWO CONFIGURATIONS THE PROCESS MUST NOT BOOT WITH.
 *
 * Both are silent in production and loud here, which is the whole trade:
 *
 *   · A URL without a key authenticates against nothing, and the operator finds
 *     out one 401 at a time, per mint, in a log.
 *   · A remote service on a deployment that ALSO runs the identity domain means
 *     the desk writes credentials here while the gate reads them there. Nobody
 *     gets a stack trace; they get a holder who was verified a minute ago being
 *     refused, and they go looking in the wrong database.
 *
 * Driven through a real child process rather than by re-reading the source,
 * because the thing being asserted is that the MODULE refuses on import — a
 * test that reproduced the condition itself would pass just as happily if the
 * check were deleted.
 */
describe("boot refuses a half-configured or contradictory identity topology", () => {
  const envModule = fileURLToPath(new URL("../src/env.ts", import.meta.url));

  function boot(overrides: Record<string, string | undefined>): { code: number | null; stderr: string } {
    const child = spawnSync(
      "npx",
      ["tsx", "-e", `import(${JSON.stringify(envModule)}).catch((e) => { console.error(e.message); process.exit(9); })`],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        env: {
          ...process.env,
          IDENTITY_SERVICE_URL: undefined, IDENTITY_SERVICE_KEY: undefined, ENABLED_DOMAINS: undefined,
          ...overrides,
        } as NodeJS.ProcessEnv,
      },
    );
    return { code: child.status, stderr: child.stderr ?? "" };
  }

  it("refuses a URL with no key", () => {
    const { code, stderr } = boot({ IDENTITY_SERVICE_URL: "https://id.example.com", ENABLED_DOMAINS: "tokenization" });
    expect(code).toBe(9);
    expect(stderr).toContain("must be set together");
  }, 60_000);

  it("refuses a key with no URL", () => {
    const { code, stderr } = boot({ IDENTITY_SERVICE_KEY: "tl_live_x", ENABLED_DOMAINS: "tokenization" });
    expect(code).toBe(9);
    expect(stderr).toContain("must be set together");
  }, 60_000);

  it("refuses delegating identity while also serving it", () => {
    const { code, stderr } = boot({
      IDENTITY_SERVICE_URL: "https://id.example.com", IDENTITY_SERVICE_KEY: "tl_live_x",
      ENABLED_DOMAINS: "tokenization,identity",
    });
    expect(code).toBe(9);
    expect(stderr).toContain("also runs the 'identity' domain");
  }, 60_000);

  it("boots a tokenization deployment that delegates to a service", () => {
    // The positive control: without it the three refusals above would pass on a
    // module that refused everything.
    const { code, stderr } = boot({
      IDENTITY_SERVICE_URL: "https://id.example.com", IDENTITY_SERVICE_KEY: "tl_live_x",
      ENABLED_DOMAINS: "tokenization",
    });
    expect({ code, stderr }).toMatchObject({ code: 0 });
  }, 60_000);
});
