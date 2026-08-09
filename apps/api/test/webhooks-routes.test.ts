/**
 * EN-C task C6 — the nine HTTP routes: webhook endpoint management, the
 * delivery log, and the event cursor.
 *
 * WHAT THIS FILE IS REALLY ABOUT is tenancy. Every route here is org-scoped,
 * and an EN-C bug does not look like a 500 — it looks like org A quietly
 * learning something about org B, or an integrator's SIGNING SECRET (with which
 * deliveries are FORGED, not merely read) appearing in a response body that any
 * `webhooks:read` key can fetch. So the assertions below are deliberately
 * paranoid in three specific ways:
 *
 *  - the secret checks scan the RAW RESPONSE TEXT for both the literal field
 *    name and the actual stored ciphertext, rather than asserting on parsed
 *    fields. `expect(body.secretEncrypted).toBeUndefined()` passes happily when
 *    the ciphertext is nested one level deeper than the assertion looked;
 *  - cross-org probes assert the exact STATUS CODE, because 403-vs-404 is the
 *    entire difference between "no oracle" and "an oracle";
 *  - the EN-A tests run BOTH directions — refused at subscribe time, still
 *    delivering afterwards — because a check that is merely present is not
 *    evidence that it is scoped to the right moment.
 *
 * Every URL here is a LITERAL IP (203.0.113.x, the TEST-NET-3 documentation
 * range, which the guard scores as publicly routable). `checkUrl` skips
 * resolution for a literal, so this file performs no DNS and passes offline.
 */
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { Role } from "@tokenlayer/core";
import { mintSecret } from "../src/api-keys.js";
import { emitEvent } from "../src/events.js";
import { signatureHeader, verifySignature } from "../src/webhooks/signing.js";
import { auth, buildTestAppWithRepos, loginAs, V1, type TestAppHandle } from "./helpers.js";

/** A publicly routable literal — no DNS, and not in any blocked range. */
const HOOK = "https://203.0.113.10/hooks";
const HOOK_2 = "https://203.0.113.11/hooks";
/** Cloud metadata: the canonical SSRF target the guard exists to refuse. */
const SSRF = "https://169.254.169.254/";

const TEST_ROUNDS = 4;

const FULL_ENVELOPE = { domains: ["tokenization", "identity"], roles: ["Issuer", "Holder", "Verifier"] };
const IDENTITY_ONLY = { domains: ["identity"], roles: ["Issuer", "Verifier"] };

interface Org { id: string; adminTok: string }

/** A PlatformAdmin-created org plus a logged-in OrgAdmin member of it. */
async function makeOrg(app: FastifyInstance, platform: string, name: string): Promise<Org> {
  const created = await app.inject({ method: "POST", url: `${V1}/orgs`, headers: auth(platform), payload: { name, orgType: "corporate" } });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-admin@wh.dev`;
  const member = await app.inject({
    method: "POST", url: `${V1}/orgs/${id}/users`, headers: auth(platform),
    payload: { email, password: "wh-secret-1", role: "OrgAdmin" },
  });
  expect(member.statusCode).toBe(201);
  return { id, adminTok: await loginAs(app, email, "wh-secret-1") };
}

async function setCapabilities(app: FastifyInstance, platform: string, orgId: string, capabilities: unknown): Promise<void> {
  const res = await app.inject({ method: "PATCH", url: `${V1}/orgs/${orgId}/capabilities`, headers: auth(platform), payload: { capabilities } });
  expect(res.statusCode).toBe(200);
}

/** A live service user + API key bound to `orgId`, built straight through the repos. */
async function seedKey(h: TestAppHandle, orgId: string, scopes: string[], role: Role = "OrgAdmin"): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 10);
  const svc = await h.users.create({
    email: `svc-${tag}@wh.dev`, passwordHash: bcrypt.hashSync(`unguessable-${tag}`, TEST_ROUNDS),
    role, useCaseKey: null, accountId: null, active: true, kycStatus: "approved", kyc: null,
    orgId, kind: "service",
  });
  const minted = await mintSecret(TEST_ROUNDS);
  await h.apiKeys.create({
    orgId, userId: svc.id, name: `key ${tag}`, prefix: minted.prefix, secretHash: minted.hash,
    scopes, expiresAt: null, createdBy: "test",
  });
  return minted.secret;
}

const createHook = (app: FastifyInstance, token: string, orgId: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `${V1}/orgs/${orgId}/webhooks`, headers: auth(token), payload: body });

// ---------------------------------------------------------------------------
// Registration: the secret's one and only appearance, and the three refusals.
// ---------------------------------------------------------------------------

describe("POST /orgs/:id/webhooks — registration (EN-C task C6)", () => {
  it("201s with a whsec_ secret, and NEITHER the secret NOR its ciphertext is readable afterwards", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Hook Co");

    const res = await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["asset.issued", "credential.issued"], description: "ERP sync" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.endpoint).toMatchObject({
      orgId: org.id, url: HOOK, description: "ERP sync", eventTypes: ["asset.issued", "credential.issued"],
      status: "active", useCaseKey: null, consecutiveFailures: 0, failingSince: null,
    });
    // Even the 201 — the one body that carries the plaintext — must not carry
    // the ciphertext: two copies of one secret is one more place to leak it.
    expect(res.payload).not.toContain("secretEncrypted");

    // The ciphertext genuinely exists in the store, so the scan below is a real
    // test and not a search for a string that was never there.
    const stored = await h.deps.webhookEndpoints.findById(body.endpoint.id as string);
    expect(stored?.secretEncrypted).toBeTruthy();
    expect(h.deps.secretBox.open(stored!.secretEncrypted)).toBe(body.secret);

    // THE READ ROUTE. Scanning the raw text, not a parsed field: a projection
    // that returned the whole record would put both of these in the body, and a
    // `toBeUndefined()` on one parsed key would miss a nested copy.
    const list = await h.app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/webhooks`, headers: auth(org.adminTok) });
    expect(list.statusCode).toBe(200);
    expect(list.payload).not.toContain("secretEncrypted");
    expect(list.payload).not.toContain(stored!.secretEncrypted);
    expect(list.payload).not.toContain(body.secret);
    expect(list.payload).not.toContain("whsec_");
    expect(list.json().endpoints).toHaveLength(1);
    expect(list.json().endpoints[0]).toMatchObject({ id: body.endpoint.id, url: HOOK });
  });

  it("refuses an SSRF URL — 400 INVALID_WEBHOOK_URL, with our reason and not a raw resolver error", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "SSRF Co");

    const res = await createHook(h.app, org.adminTok, org.id, { url: SSRF, eventTypes: ["*"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_WEBHOOK_URL");
    expect(res.json().message).toContain("link-local");
    // Nothing was stored: a refused URL must not leave a half-made endpoint.
    const list = await h.app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/webhooks`, headers: auth(org.adminTok) });
    expect(list.json().endpoints).toEqual([]);

    // The whole blocked family, not just the one address, through the route.
    for (const url of ["http://127.0.0.1/x", "https://10.0.0.5/x", "https://[::1]/x", "http://203.0.113.10/x"]) {
      const r = await createHook(h.app, org.adminTok, org.id, { url, eventTypes: ["*"] });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("INVALID_WEBHOOK_URL");
    }
  });

  it("refuses an unknown event type — 400 UNKNOWN_EVENT_TYPE — and `ping` is not subscribable", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Vocab Co");

    const res = await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["asset.issued", "asset.exploded"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNKNOWN_EVENT_TYPE");

    // The synthetic ping the /test route sends is NOT a catalog entry, so it
    // cannot be subscribed to. If this ever 201s, someone added it to
    // EVENT_TYPES and the closed catalog is no longer closed.
    const ping = await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["ping"] });
    expect(ping.statusCode).toBe(400);
    expect(ping.json().error).toBe("UNKNOWN_EVENT_TYPE");

    // A partial wildcard is not a subscription either.
    const partial = await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["asset.*"] });
    expect(partial.statusCode).toBe(400);
    // Empty and duplicate lists are INVALID_EVENT_TYPES, not UNKNOWN_.
    expect((await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: [] })).json().error).toBe("INVALID_EVENT_TYPES");
  });

  it("VOCABULARY IS CHECKED BEFORE ENTITLEMENT: a typo in an out-of-envelope type is still a 400", async () => {
    // Order matters for the integrator's debugging: reporting a typo as a
    // missing capability sends them to the wrong support queue entirely.
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Order Co");
    await setCapabilities(h.app, platform, org.id, IDENTITY_ONLY);

    const res = await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["asset.izzued"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNKNOWN_EVENT_TYPE");
  });
});

// ---------------------------------------------------------------------------
// EN-A: the envelope gates SUBSCRIBING, and only subscribing.
// ---------------------------------------------------------------------------

describe("the EN-A envelope gates SUBSCRIBING (EN-C task C6)", () => {
  it("an identity-only org cannot subscribe to asset.* — 403 ORG_CAPABILITY_MISSING", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Ident Co");
    await setCapabilities(h.app, platform, org.id, IDENTITY_ONLY);

    const res = await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["asset.issued"] });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "ORG_CAPABILITY_MISSING", details: { orgId: org.id, missing: "tokenization" } });

    // …and the mirror image: a tokenization-only org cannot subscribe to
    // credential.* or verification.*, so the mapping is not a one-way accident.
    const other = await makeOrg(h.app, platform, "Token Co");
    await setCapabilities(h.app, platform, other.id, { domains: ["tokenization"], roles: ["Issuer"] });
    for (const t of ["credential.issued", "credential.revoked", "verification.requested", "verification.completed"]) {
      const r = await createHook(h.app, other.adminTok, other.id, { url: HOOK, eventTypes: [t] });
      expect(r.statusCode).toBe(403);
      expect(r.json().details.missing).toBe("identity");
    }

    // The domain-NEUTRAL types are subscribable by both. `*` is a request for
    // "whatever I am entitled to", not a claim on a domain; proposal.executed
    // is maker-checker governance, which both domains run.
    for (const t of ["*", "proposal.executed"]) {
      expect((await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: [t] })).statusCode).toBe(201);
      expect((await createHook(h.app, other.adminTok, other.id, { url: HOOK, eventTypes: [t] })).statusCode).toBe(201);
    }

    // A LEGACY (null) envelope is unrestricted — EN-A's standing rule, and the
    // reason this gate cannot break any org that predates it.
    const legacy = await makeOrg(h.app, platform, "Legacy Co");
    expect((await createHook(h.app, legacy.adminTok, legacy.id, { url: HOOK, eventTypes: ["asset.issued", "credential.issued"] })).statusCode).toBe(201);
  });

  it("NON-RETROACTIVE: an endpoint subscribed while entitled keeps receiving after the envelope tightens", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Retro Co");
    await setCapabilities(h.app, platform, org.id, FULL_ENVELOPE);

    const made = await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["asset.issued"] });
    expect(made.statusCode).toBe(201);
    const endpointId = made.json().endpoint.id as string;

    // The envelope narrows AFTER the fact — the platform withdraws tokenization.
    await setCapabilities(h.app, platform, org.id, IDENTITY_ONLY);

    // 1. The endpoint is untouched: still active, still subscribed. A tightened
    //    envelope must not silently switch off a customer's live integration.
    const list = await h.app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/webhooks`, headers: auth(org.adminTok) });
    expect(list.json().endpoints[0]).toMatchObject({ id: endpointId, status: "active", eventTypes: ["asset.issued"] });

    // 2. And it STILL RECEIVES. This is the half a "check the envelope at
    //    delivery time" implementation would break, and no route test would
    //    catch it — so drive the real emit/fan-out path.
    await emitEvent(h.deps, { type: "asset.issued", orgId: org.id, subjectId: "asset_1", data: { assetId: "asset_1" } });
    const deliveries = await h.deps.webhookDeliveries.listByEndpoint(endpointId, 10);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ endpointId, status: "pending", attempts: 0 });

    // 3. The other direction still bites: a NEW subscription is refused, and so
    //    is PATCHing an existing endpoint onto the withdrawn domain — otherwise
    //    PATCH is simply the way around the create-time gate.
    expect((await createHook(h.app, org.adminTok, org.id, { url: HOOK_2, eventTypes: ["asset.issued"] })).statusCode).toBe(403);
    const patched = await h.app.inject({
      method: "PATCH", url: `${V1}/orgs/${org.id}/webhooks/${endpointId}`,
      headers: auth(org.adminTok), payload: { eventTypes: ["asset.redeemed"] },
    });
    expect(patched.statusCode).toBe(403);
    expect(patched.json().error).toBe("ORG_CAPABILITY_MISSING");
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant: the property that matters most.
// ---------------------------------------------------------------------------

describe("cross-org isolation across all nine routes (EN-C task C6)", () => {
  it("a foreign OrgAdmin gets 403 on every endpoint route of another org", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const a = await makeOrg(h.app, platform, "Alpha Co");
    const b = await makeOrg(h.app, platform, "Bravo Co");

    const mine = await createHook(h.app, a.adminTok, a.id, { url: HOOK, eventTypes: ["*"] });
    const whId = mine.json().endpoint.id as string;

    // B's admin, aimed squarely at A's org and A's real endpoint id.
    const probes: [string, string][] = [
      ["POST", `${V1}/orgs/${a.id}/webhooks`],
      ["GET", `${V1}/orgs/${a.id}/webhooks`],
      ["PATCH", `${V1}/orgs/${a.id}/webhooks/${whId}`],
      ["POST", `${V1}/orgs/${a.id}/webhooks/${whId}/rotate`],
      ["DELETE", `${V1}/orgs/${a.id}/webhooks/${whId}`],
      ["POST", `${V1}/orgs/${a.id}/webhooks/${whId}/test`],
      ["GET", `${V1}/orgs/${a.id}/webhooks/${whId}/deliveries`],
      ["POST", `${V1}/orgs/${a.id}/webhooks/${whId}/deliveries/whd_x/replay`],
    ];
    for (const [method, url] of probes) {
      const res = await h.app.inject({ method: method as "GET", url, headers: auth(b.adminTok), payload: { url: HOOK, eventTypes: ["*"] } });
      expect(`${method} ${url} -> ${res.statusCode}`).toBe(`${method} ${url} -> 403`);
    }

    // A's endpoint survived every one of those attempts.
    const still = await h.app.inject({ method: "GET", url: `${V1}/orgs/${a.id}/webhooks`, headers: auth(a.adminTok) });
    expect(still.json().endpoints[0]).toMatchObject({ id: whId, status: "active", url: HOOK });
  });

  it("another org's ENDPOINT id under your own org is 404 — no existence oracle", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const a = await makeOrg(h.app, platform, "Oracle A");
    const b = await makeOrg(h.app, platform, "Oracle B");
    const foreign = (await createHook(h.app, b.adminTok, b.id, { url: HOOK, eventTypes: ["*"] })).json().endpoint.id as string;

    // A's admin, A's own org in the path, B's endpoint id in the tail. A real
    // id and a made-up one must be indistinguishable.
    for (const id of [foreign, "whep_does_not_exist"]) {
      const res = await h.app.inject({ method: "GET", url: `${V1}/orgs/${a.id}/webhooks/${id}/deliveries`, headers: auth(a.adminTok) });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("NOT_FOUND");
    }
  });

  it("replaying another org's DELIVERY is 404, not 403 — the same no-oracle rule", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const a = await makeOrg(h.app, platform, "Replay A");
    const b = await makeOrg(h.app, platform, "Replay B");
    const mine = (await createHook(h.app, a.adminTok, a.id, { url: HOOK, eventTypes: ["*"] })).json().endpoint.id as string;
    const theirs = (await createHook(h.app, b.adminTok, b.id, { url: HOOK_2, eventTypes: ["*"] })).json().endpoint.id as string;

    await emitEvent(h.deps, { type: "asset.issued", orgId: b.id, data: { assetId: "b_1" } });
    const foreignDelivery = (await h.deps.webhookDeliveries.listByEndpoint(theirs, 5))[0]!;

    // A's org, A's OWN endpoint, B's delivery id. The delivery exists; A must
    // not be able to tell that from a typo.
    const res = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${a.id}/webhooks/${mine}/deliveries/${foreignDelivery.id}/replay`,
      headers: auth(a.adminTok), payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("NOT_FOUND");
    // Same answer for an id that never existed — that IS the property.
    const bogus = await h.app.inject({
      method: "POST", url: `${V1}/orgs/${a.id}/webhooks/${mine}/deliveries/whd_nope/replay`,
      headers: auth(a.adminTok), payload: {},
    });
    expect(bogus.statusCode).toBe(404);
    expect(bogus.json()).toEqual(res.json());

    // B's delivery was not touched by A's attempt.
    expect((await h.deps.webhookDeliveries.findById(foreignDelivery.id))?.status).toBe("pending");
  });

  it("replay refuses a CLAIMED delivery in the WRITE, not in a prior read", async () => {
    // FINAL-REVIEW FIX (LOW). Replay used to read the row, check
    // `status !== "inflight"`, and then issue a plain update. A dispatcher
    // claiming in that gap had its claim silently reset while it was mid-POST,
    // so the row could be claimed and sent a second time — and the settle that
    // followed clobbered the replay anyway. The predicate now travels inside the
    // UPDATE (`requeue`), the same compare-and-set discipline as `claim`.
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const a = await makeOrg(h.app, platform, "Race Co");
    const ep = (await createHook(h.app, a.adminTok, a.id, { url: HOOK, eventTypes: ["*"] })).json().endpoint.id as string;
    await emitEvent(h.deps, { type: "asset.issued", orgId: a.id, data: { assetId: "r_1" } });
    const d = (await h.deps.webhookDeliveries.listByEndpoint(ep, 5))[0]!;
    // Burn an attempt and settle it, so the row is a realistic replay candidate.
    await h.deps.webhookDeliveries.update(d.id, { status: "failed", attempts: 3 });

    const replayUrl = `${V1}/orgs/${a.id}/webhooks/${ep}/deliveries/${d.id}/replay`;
    // A settled row replays: back to pending, attempts reset, due now.
    const ok = await h.app.inject({ method: "POST", url: replayUrl, headers: auth(a.adminTok), payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().delivery).toMatchObject({ status: "pending", attempts: 0 });

    // NOW THE RACE ITSELF, and it has to be the race or this test proves
    // nothing: simply claiming the row first and then calling replay is refused
    // by a read-based check too, so it would pass against the very code this
    // fixes. Instead a dispatcher claims INSIDE the window — after the route's
    // read returns, before the route writes — which is the only interleaving
    // that distinguishes a check in the read from a check in the write. The
    // route's snapshot therefore still says `pending`.
    const repo = h.deps.webhookDeliveries;
    const realFindById = repo.findById.bind(repo);
    let raced = false;
    repo.findById = async (id: string) => {
      const row = await realFindById(id);
      if (!raced && row && row.id === d.id) {
        raced = true;
        await repo.claim(d.id, "w-race", new Date().toISOString());
      }
      return row;
    };

    const conflict = await h.app.inject({ method: "POST", url: replayUrl, headers: auth(a.adminTok), payload: {} });
    expect(raced).toBe(true); // the interleaving really happened
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("DELIVERY_INFLIGHT");
    // THE POINT: the worker's claim survives the refused replay intact. Resetting
    // it would let a second worker take the row while the first is mid-POST, and
    // the first worker's settle would then clobber the replay anyway.
    repo.findById = realFindById;
    const after = (await repo.findById(d.id))!;
    expect(after.status).toBe("inflight");
    expect(after.claimedBy).toBe("w-race");
    expect(after.claimedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scopes. `...auth` alone would mean "any key with any scope" (EN-B's fail-open
// default), so both halves are asserted: refused without, allowed with.
// ---------------------------------------------------------------------------

describe("API-key scopes on the webhook routes (EN-C task C6)", () => {
  it("webhooks:read cannot create; webhooks:write can; a key with neither is refused both ways", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Scope Co");

    const readKey = await seedKey(h, org.id, ["webhooks:read"]);
    const writeKey = await seedKey(h, org.id, ["webhooks:write"]);
    const otherKey = await seedKey(h, org.id, ["assets:read", "credentials:issue"]);

    // CREATE demands webhooks:write.
    const refused = await createHook(h.app, readKey, org.id, { url: HOOK, eventTypes: ["*"] });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "INSUFFICIENT_SCOPE", details: { required: "webhooks:write" } });
    expect((await createHook(h.app, otherKey, org.id, { url: HOOK, eventTypes: ["*"] })).statusCode).toBe(403);

    const made = await createHook(h.app, writeKey, org.id, { url: HOOK, eventTypes: ["*"] });
    expect(made.statusCode).toBe(201);
    const whId = made.json().endpoint.id as string;

    // READS demand webhooks:read — a write-only key is not implicitly a reader,
    // and disclosure is an authorization decision in its own right.
    expect((await h.app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/webhooks`, headers: auth(readKey) })).statusCode).toBe(200);
    const listRefused = await h.app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/webhooks`, headers: auth(writeKey) });
    expect(listRefused.statusCode).toBe(403);
    expect(listRefused.json().details.required).toBe("webhooks:read");
    expect((await h.app.inject({ method: "GET", url: `${V1}/events`, headers: auth(otherKey) })).statusCode).toBe(403);
    expect((await h.app.inject({ method: "GET", url: `${V1}/events`, headers: auth(readKey) })).statusCode).toBe(200);

    // The remaining mutations all sit behind webhooks:write.
    for (const url of [
      `${V1}/orgs/${org.id}/webhooks/${whId}/rotate`,
      `${V1}/orgs/${org.id}/webhooks/${whId}/test`,
      `${V1}/orgs/${org.id}/webhooks/${whId}/deliveries/whd_x/replay`,
    ]) {
      expect((await h.app.inject({ method: "POST", url, headers: auth(readKey), payload: {} })).statusCode).toBe(403);
    }
    expect((await h.app.inject({ method: "PATCH", url: `${V1}/orgs/${org.id}/webhooks/${whId}`, headers: auth(readKey), payload: { description: "x" } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: "DELETE", url: `${V1}/orgs/${org.id}/webhooks/${whId}`, headers: auth(readKey) })).statusCode).toBe(403);

    // A key still cannot reach ANOTHER org, whatever it is scoped for.
    const b = await makeOrg(h.app, platform, "Scope Other");
    expect((await createHook(h.app, writeKey, b.id, { url: HOOK, eventTypes: ["*"] })).statusCode).toBe(403);
    expect((await h.app.inject({ method: "GET", url: `${V1}/orgs/${b.id}/webhooks`, headers: auth(readKey) })).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Rotation.
// ---------------------------------------------------------------------------

describe("POST /orgs/:id/webhooks/:whId/rotate (EN-C task C6)", () => {
  it("replaces the stored ciphertext and returns a new secret; the old one stops verifying", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Rotate Co");
    const made = await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["*"] });
    const whId = made.json().endpoint.id as string;
    const oldSecret = made.json().secret as string;
    const oldCipher = (await h.deps.webhookEndpoints.findById(whId))!.secretEncrypted;

    const res = await h.app.inject({ method: "POST", url: `${V1}/orgs/${org.id}/webhooks/${whId}/rotate`, headers: auth(org.adminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    const newSecret = res.json().secret as string;
    expect(newSecret).toMatch(/^whsec_/);
    expect(newSecret).not.toBe(oldSecret);
    expect(res.payload).not.toContain("secretEncrypted");

    const newCipher = (await h.deps.webhookEndpoints.findById(whId))!.secretEncrypted;
    expect(newCipher).not.toBe(oldCipher);
    expect(h.deps.secretBox.open(newCipher)).toBe(newSecret);

    // THE PROPERTY THAT MATTERS: a delivery signed the way the dispatcher signs
    // one, from what the store now holds, verifies under the NEW secret and not
    // under the old — no overlap window, so a leaked secret dies on rotation.
    const body = JSON.stringify({ id: "evt_x", type: "asset.issued" });
    const t = Math.floor(Date.now() / 1000);
    const header = signatureHeader(h.deps.secretBox.open(newCipher), t, body);
    expect(verifySignature(newSecret, header, body)).toBe(true);
    expect(verifySignature(oldSecret, header, body)).toBe(false);

    // Rotation changes nothing else about the endpoint.
    expect(res.json().endpoint).toMatchObject({ id: whId, url: HOOK, eventTypes: ["*"], status: "active" });
  });
});

// ---------------------------------------------------------------------------
// PATCH: the re-enable reset, and the URL guard on every change.
// ---------------------------------------------------------------------------

describe("PATCH /orgs/:id/webhooks/:whId (EN-C task C6)", () => {
  it("re-enabling a disabled endpoint clears ALL FIVE failure fields", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Reenable Co");
    const whId = (await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["*"] })).json().endpoint.id as string;

    // Exactly the state the dispatcher's auto-disable leaves behind: the count
    // is at the threshold and the run is older than the time floor.
    const anHourAgo = new Date(Date.now() - 90 * 60_000).toISOString();
    await h.deps.webhookEndpoints.update(whId, {
      status: "disabled", disabledReason: "20 consecutive delivery failures over 95 minutes",
      disabledAt: anHourAgo, consecutiveFailures: 20, consecutiveGuardFailures: 4, failingSince: anHourAgo,
    });
    // It is genuinely out of the fan-out set while disabled.
    expect((await h.deps.webhookEndpoints.listActive()).map((e) => e.id)).not.toContain(whId);

    const res = await h.app.inject({ method: "PATCH", url: `${V1}/orgs/${org.id}/webhooks/${whId}`, headers: auth(org.adminTok), payload: { status: "active" } });
    expect(res.statusCode).toBe(200);
    // All five together. Leave ANY of them and the endpoint auto-disables again
    // on its very next failed attempt — `failingSince` worst of all, since the
    // run's age would keep growing from the original outage forever.
    expect(res.json().endpoint).toMatchObject({
      status: "active", disabledReason: null, disabledAt: null,
      consecutiveFailures: 0, consecutiveGuardFailures: 0, failingSince: null,
    });
    const stored = (await h.deps.webhookEndpoints.findById(whId))!;
    expect(stored).toMatchObject({ status: "active", disabledReason: null, disabledAt: null, consecutiveFailures: 0, consecutiveGuardFailures: 0, failingSince: null });
    // And it is back in the fan-out set.
    await emitEvent(h.deps, { type: "asset.issued", orgId: org.id, data: {} });
    expect(await h.deps.webhookDeliveries.listByEndpoint(whId, 5)).toHaveLength(1);
  });

  it("re-runs the URL guard on a url change, and updates the ordinary fields", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Patch Co");
    const whId = (await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["*"], useCaseKey: "carbon-credit" })).json().endpoint.id as string;
    const patch = (payload: Record<string, unknown>) =>
      h.app.inject({ method: "PATCH", url: `${V1}/orgs/${org.id}/webhooks/${whId}`, headers: auth(org.adminTok), payload });

    // PATCH must not be the way around registration's SSRF check.
    const moved = await patch({ url: SSRF });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error).toBe("INVALID_WEBHOOK_URL");
    expect((await h.deps.webhookEndpoints.findById(whId))!.url).toBe(HOOK);

    const ok = await patch({ url: HOOK_2, description: "moved", eventTypes: ["asset.issued"] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().endpoint).toMatchObject({ url: HOOK_2, description: "moved", eventTypes: ["asset.issued"], useCaseKey: "carbon-credit" });

    // An explicit null CLEARS the use-case filter (widening the endpoint back to
    // its org's whole stream) — the one request a non-nullable schema would 400.
    const cleared = await patch({ useCaseKey: null, description: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().endpoint).toMatchObject({ useCaseKey: null, description: null });

    // Disabling by hand stops the fan-out.
    expect((await patch({ status: "disabled" })).json().endpoint).toMatchObject({ status: "disabled", disabledReason: "disabled by an administrator" });
    await emitEvent(h.deps, { type: "asset.issued", orgId: org.id, data: {} });
    expect(await h.deps.webhookDeliveries.listByEndpoint(whId, 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The synthetic ping, and DELETE.
// ---------------------------------------------------------------------------

describe("POST /orgs/:id/webhooks/:whId/test — the synthetic ping (EN-C task C6)", () => {
  it("enqueues a delivery for THAT endpoint ONLY — never for a sibling wildcard endpoint", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Ping Co");
    const target = (await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["asset.issued"] })).json().endpoint.id as string;
    // A SIBLING subscribed to `*`. `endpointMatches` would send it the ping too,
    // which is exactly why the /test route does not use `endpointMatches`.
    const sibling = (await createHook(h.app, org.adminTok, org.id, { url: HOOK_2, eventTypes: ["*"] })).json().endpoint.id as string;

    const res = await h.app.inject({ method: "POST", url: `${V1}/orgs/${org.id}/webhooks/${target}/test`, headers: auth(org.adminTok), payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().event.type).toBe("ping");
    expect(res.json().delivery).toMatchObject({ endpointId: target, status: "pending", attempts: 0 });

    // The narrow endpoint got it even though `ping` is not in its subscription…
    expect(await h.deps.webhookDeliveries.listByEndpoint(target, 5)).toHaveLength(1);
    // …and the wildcard sibling did NOT, even though `*` would have matched it.
    expect(await h.deps.webhookDeliveries.listByEndpoint(sibling, 5)).toEqual([]);

    // The ping is a real, org-scoped row in the outbox — the dispatcher resolves
    // deliveries by event id, so a delivery with no event would never send.
    const events = await h.deps.events.listAfter(0, { orgId: org.id, limit: 10 });
    expect(events.map((e) => e.type)).toEqual(["ping"]);
    expect(events[0]).toMatchObject({ orgId: org.id, subjectId: target });

    // A disabled endpoint says so rather than queueing a guaranteed-dead row.
    await h.deps.webhookEndpoints.update(target, { status: "disabled", disabledReason: "x", disabledAt: new Date().toISOString() });
    const onDisabled = await h.app.inject({ method: "POST", url: `${V1}/orgs/${org.id}/webhooks/${target}/test`, headers: auth(org.adminTok), payload: {} });
    expect(onDisabled.statusCode).toBe(409);
    expect(onDisabled.json().error).toBe("ENDPOINT_DISABLED");
  });
});

describe("DELETE /orgs/:id/webhooks/:whId (EN-C task C6)", () => {
  it("soft-deletes: fan-out stops, the row leaves the listing, and it is 404 thereafter", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Delete Co");
    const whId = (await createHook(h.app, org.adminTok, org.id, { url: HOOK, eventTypes: ["*"] })).json().endpoint.id as string;

    const res = await h.app.inject({ method: "DELETE", url: `${V1}/orgs/${org.id}/webhooks/${whId}`, headers: auth(org.adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json().endpoint).toMatchObject({ status: "disabled", disabledReason: "deleted" });
    expect(res.json().endpoint.deletedAt).toBeTruthy();

    const list = await h.app.inject({ method: "GET", url: `${V1}/orgs/${org.id}/webhooks`, headers: auth(org.adminTok) });
    expect(list.json().endpoints).toEqual([]);
    // Gone from the API surface entirely — a second delete is a 404, same as a
    // stranger's id, so a deleted endpoint is not an oracle either.
    expect((await h.app.inject({ method: "DELETE", url: `${V1}/orgs/${org.id}/webhooks/${whId}`, headers: auth(org.adminTok) })).statusCode).toBe(404);
    await emitEvent(h.deps, { type: "asset.issued", orgId: org.id, data: {} });
    expect(await h.deps.webhookDeliveries.listByEndpoint(whId, 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The cursor.
// ---------------------------------------------------------------------------

describe("GET /events — the cursor (EN-C task C6)", () => {
  it("is org-scoped and exclusive: org A never sees org B's events", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const a = await makeOrg(h.app, platform, "Cursor A");
    const b = await makeOrg(h.app, platform, "Cursor B");

    await emitEvent(h.deps, { type: "asset.issued", orgId: a.id, subjectId: "a1", data: { assetId: "a1" } });
    await emitEvent(h.deps, { type: "credential.issued", orgId: b.id, subjectId: "b1", data: { credentialId: "b1" } });
    await emitEvent(h.deps, { type: "asset.transferred", orgId: a.id, subjectId: "a2", data: { assetId: "a2" } });
    await emitEvent(h.deps, { type: "proposal.executed", orgId: null, subjectId: "p1", data: { proposalId: "p1" } });

    const read = async (token: string, qs = "") =>
      (await h.app.inject({ method: "GET", url: `${V1}/events${qs}`, headers: auth(token) })).json();

    // A sees ONLY A's two. B's credential id does not appear anywhere in the
    // body — not in a payload, not in a subject, not as a stray field.
    const mine = await read(a.adminTok);
    expect(mine.events.map((e: { subjectId: string }) => e.subjectId)).toEqual(["a1", "a2"]);
    expect(JSON.stringify(mine)).not.toContain("b1");
    expect(mine.nextAfter).toBe(mine.events[1].seq);

    const theirs = await read(b.adminTok);
    expect(theirs.events.map((e: { subjectId: string }) => e.subjectId)).toEqual(["b1"]);

    // The cursor is EXCLUSIVE — `after = nextAfter` never re-reads and never
    // skips, which is the whole contract of the documented catch-up loop.
    const page2 = await read(a.adminTok, `?after=${mine.events[0].seq}`);
    expect(page2.events.map((e: { subjectId: string }) => e.subjectId)).toEqual(["a2"]);
    const drained = await read(a.adminTok, `?after=${mine.nextAfter}`);
    expect(drained.events).toEqual([]);
    // An empty page hands the caller's own cursor back, so polling a quiet log
    // is idempotent rather than resetting to zero.
    expect(drained.nextAfter).toBe(mine.nextAfter);

    // A PlatformAdmin reads every org's log, including the platform-scope row.
    const all = await read(platform);
    expect(all.events.map((e: { subjectId: string }) => e.subjectId)).toEqual(["a1", "b1", "a2", "p1"]);

    // …and `type` narrows within the caller's own scope, never outside it.
    expect((await read(a.adminTok, "?type=asset.issued")).events.map((e: { subjectId: string }) => e.subjectId)).toEqual(["a1"]);
    expect((await read(a.adminTok, "?type=credential.issued")).events).toEqual([]);
  });

  it("shows an ORG-LESS principal NOTHING — the platform-scope bucket is not a fallback", async () => {
    // FINAL-REVIEW FIX (HIGH). `requireScope` only narrows API KEYS, so a JWT
    // session carries `webhooks:read` unconditionally, and this route has no
    // role check and no `orgScoped`. Any principal whose `orgId` is null — every
    // seeded user, every holder, every org-less Verifier desk operator —
    // therefore selected exactly the `orgId: null` rows.
    //
    // And that bucket is not niche: the branch ROUTES RESOLUTION FAILURES INTO
    // IT. `ownerOrgOfUseCase` returns null for every seeded/legacy tokenization
    // use case, a holder DID that no longer resolves gives `?? null`, and an
    // org-less Verifier desk raises verifications with no org at all. So the
    // rows below are exactly what a real deployment accumulates.
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const a = await makeOrg(h.app, platform, "Scope A");

    await emitEvent(h.deps, {
      type: "asset.issued", orgId: null, useCaseKey: "carbon-credit", subjectId: "unowned-asset",
      data: { assetId: "unowned-asset", supply: 5000 },
    });
    await emitEvent(h.deps, {
      type: "verification.requested", orgId: null, subjectId: "vr-1",
      data: { holderDid: "did:tl:a-third-partys-holder", purpose: "kyc", credentialTypes: ["KycCredential"] },
    });
    await emitEvent(h.deps, { type: "asset.issued", orgId: a.id, subjectId: "a1", data: { assetId: "a1" } });

    // A gold-loan Buyer: a real seeded principal, authenticated, org-less, and
    // one that gets a 404 from GET /assets/:id for a carbon asset.
    const buyer = await loginAs(h.app, "gold.buyer@tokenlayer.dev", "gold123");
    const res = await h.app.inject({ method: "GET", url: `${V1}/events`, headers: auth(buyer) });
    // 200-and-empty, NOT 403: an org-less caller is not forbidden from the
    // route, there is simply nothing in this log that belongs to them.
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([]);
    // Scanned on the RAW body, so a row nested one level deeper than a parsed
    // assertion looked still fails this.
    expect(res.body).not.toContain("unowned-asset");
    expect(res.body).not.toContain("a-third-partys-holder");
    expect(res.body).not.toContain("KycCredential");
    // The caller's own cursor still comes back, so the documented polling loop
    // is unaffected — it just never advances.
    const paged = await h.app.inject({ method: "GET", url: `${V1}/events?after=2`, headers: auth(buyer) });
    expect(paged.json()).toEqual({ events: [], nextAfter: 2 });

    // A SCOPE, NOT A BLANKET. The same call still works for everyone it should:
    // an OrgAdmin reads exactly their own org...
    const mine = (await h.app.inject({ method: "GET", url: `${V1}/events`, headers: auth(a.adminTok) })).json();
    expect(mine.events.map((e: { subjectId: string }) => e.subjectId)).toEqual(["a1"]);
    // ...and a PlatformAdmin still reads every row INCLUDING the null ones, so
    // nothing has become unreadable — it has only stopped being readable by the
    // wrong people.
    const all = (await h.app.inject({ method: "GET", url: `${V1}/events`, headers: auth(platform) })).json();
    expect(all.events.map((e: { subjectId: string }) => e.subjectId)).toEqual(["unowned-asset", "vr-1", "a1"]);
  });

  it("caps the page size, and tolerates junk in the query", async () => {
    const h = await buildTestAppWithRepos();
    const platform = await loginAs(h.app, "admin@tokenlayer.dev", "admin123");
    const org = await makeOrg(h.app, platform, "Page Co");
    for (let i = 0; i < 5; i += 1) await emitEvent(h.deps, { type: "asset.issued", orgId: org.id, subjectId: `a${i}`, data: {} });

    const read = async (qs: string) =>
      (await h.app.inject({ method: "GET", url: `${V1}/events${qs}`, headers: auth(org.adminTok) })).json();

    expect((await read("?limit=2")).events).toHaveLength(2);
    // A caller may ask for less than the default; nobody may ask for more than
    // the cap, and nothing unparseable may become NaN inside the repo query.
    expect((await read("?limit=99999")).events).toHaveLength(5);
    expect((await read("?limit=abc")).events).toHaveLength(5);
    expect((await read("?limit=0")).events).toHaveLength(5);
    expect((await read("?after=abc")).events).toHaveLength(5);
    expect((await read("?after=-4")).events).toHaveLength(5);
  });
});
