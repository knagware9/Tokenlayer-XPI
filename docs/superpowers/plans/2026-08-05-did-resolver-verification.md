# Public W3C DID Resolver Wired into Verification (ID-K) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `resolveDid` module (did:key document + on-chain `DidRegistry` state) behind a PUBLIC `GET /dids/:did/resolve` (W3C DID Resolution Result); the VP verify route's issuer-trust step and the authed `/dids/:did/document` route rewired through it; per-credential `issuerResolution` in verify results + web pills; the verify phase runs the whole arc live on Besu with everything anchored.

**Architecture:** apps/api only for logic (new `did-resolver.ts` composing core's `publicKeyFromDidKey` with `deps.registry.anchor.didRegistration`; no core change, no new dependency, no persistence change) + apps/web for surfacing. Trust behavior must stay byte-equivalent (fail-closed); existing verification tests stay green untouched.

**Tech Stack:** apps/api (Fastify, vitest, `FakeAnchor`/`fakeRegistry` test double), apps/web (React).

**Spec:** `docs/superpowers/specs/2026-08-05-did-resolver-verification-design.md`
**Spec refinement (locked here):** the spec sketched `issuer: { did, registered, … }` on each verify-result credential; the field `issuer` ALREADY exists as the DID string (routes.ts:2646) and is stored + consumed by the web. The enrichment is therefore a NEW sibling field `issuerResolution: { registered: boolean; active: boolean; chainId: string } | null` — same information, no breakage.

**Conventions:** tests from repo root — `pnpm -s --filter @tokenlayer/api test`, `pnpm -s --filter @tokenlayer/web typecheck` / `build`. Commit after each task. **Never touch `apps/api/prisma/dev.db*`.**

**Key facts already verified:**
- Authed document route: `apps/api/src/http/routes.ts:2202-2229` — validates via `publicKeyFromDidKey`, 400 `UNSUPPORTED_DID` on invalid, builds the doc inline, appends `registration: { registered, active, chainId, registry } | null` from `deps.registry.anchor.didRegistration`.
- VP verify route STEP 1 (issuer trust): routes.ts:2583-2607 — collects issuer DIDs from the VP, then per DID: registry present → `didRegistration` → trust iff `registered && active` (read failure logged, NOT trusted); registry absent → `deps.trustedKycIssuers` allowlist. STEP 3 per-credential result build: routes.ts:2621-2650 — `{ id, type, issuer (DID string), claims, reason, checks, valid }`; result stored via `setVerifierResult` (routes.ts:2653-2655).
- `IdentityRegistry` = `{ chainId, didRegistry, vcRegistry, deployTxHash, anchor }` (`apps/api/src/registry.ts:14-20`); `deps.registry?` absent-tolerant (context.ts:90).
- Test double: `apps/api/test/fake-anchor.ts` — `FakeAnchor` (`dids` Map, `didRegistration` → `{registered, active}`, `deactivateDid`, `failNext`) + `fakeRegistry(anchor)`; `buildTestApp({ registry })` accepts it (helpers.ts:42,85).
- `publicKeyFromDidKey(did)` exported from `@tokenlayer/core` (throws on invalid); routes.ts already imports it.
- Schemas: `S.didDocument` exists; response schemas for status-style routes use loose objects — **fast-json-stringify strips undeclared fields**, so the new route's 200 schema must be `{ type: "object", additionalProperties: true }`; the verify-route response schema must be CHECKED for strictness before adding `issuerResolution` (grep `S.verifyPresentation` / the verify route's schema entry in `apps/api/src/http/schemas.ts` — if its credentials items are strictly declared, add `issuerResolution` there or loosen with `additionalProperties: true`).
- Web: `VerificationResult` type at `apps/web/src/types.ts:458-466` (credentials entries: `{ id, type, issuer, reason, claims, checks, valid }`); results rendered in `apps/web/src/components/VerificationRequests.tsx:86-96` (`result.credentials.map((c, i) => …)` with `check(...)` spans, `Pill` imported); `api.didDocument` at `apps/web/src/api.ts:203`; `api.certificateUrl` pattern at `:200` (module const `BASE`); CredentialCard issuer DID line: `apps/web/src/components/CredentialCard.tsx` `issuer · {c.issuerDid}` div.
- Besu is healthy and mining; registries auto-deploy at boot per-DB (`resolveIdentityRegistry`, never throws — degrades to unanchored loudly).

---

## Task K1: API — `did-resolver.ts` module + unit tests

**Files:**
- Create: `apps/api/src/did-resolver.ts`
- Test: `apps/api/test/did-resolver.test.ts` (new)

- [ ] **Step 1: Write the failing unit tests** (`apps/api/test/did-resolver.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { resolveDid } from "../src/did-resolver.js";
import { generateDidKey } from "@tokenlayer/core";
import { FakeAnchor, fakeRegistry } from "./fake-anchor.js";

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
    // FakeAnchor.didRegistration has no failNext hook — monkey-patch it:
    anchor.didRegistration = async () => { throw new Error("rpc down"); };
    let sawError: unknown = null;
    const res = await resolveDid(did, { registry, onChainError: (e) => { sawError = e; } });
    expect(res.didDocumentMetadata).toEqual({ source: "off-chain" });
    expect(sawError).toBeTruthy();
    expect(res.didDocument?.id).toBe(did); // document still resolves
  });
});
```

Run: `pnpm -s --filter @tokenlayer/api test -- did-resolver` → FAIL (module missing). (If `generateDidKey` is not exported from `@tokenlayer/core`, grep how other api tests mint a DID — e.g. `didKeyFromSeed` — and use that instead.)

- [ ] **Step 2: Write the module** (`apps/api/src/did-resolver.ts`)

```ts
/**
 * The platform's single DID resolution point (W3C DID Resolution shape).
 * Composes core's did:key derivation with the on-chain DidRegistry read.
 * Never throws; a failed/absent chain read yields source:"off-chain" with
 * NO registration claims — the resolver never fabricates chain state.
 */
import { publicKeyFromDidKey } from "@tokenlayer/core";
import type { IdentityRegistry } from "./registry.js";

export interface ResolvedDidDocument {
  "@context": string[];
  id: string;
  verificationMethod: { id: string; type: string; controller: string; publicKeyMultibase: string }[];
  authentication: string[];
  assertionMethod: string[];
}

export type DidDocumentMetadata =
  | { source: "chain"; registered: boolean; active: boolean; deactivated: boolean; chainId: string; registry: string }
  | { source: "off-chain" };

export interface DidResolutionResult {
  didResolutionMetadata: { contentType: "application/did+ld+json"; error?: "invalidDid" | "methodNotSupported" };
  didDocument: ResolvedDidDocument | null;
  didDocumentMetadata: DidDocumentMetadata;
}

const failure = (error: "invalidDid" | "methodNotSupported"): DidResolutionResult => ({
  didResolutionMetadata: { contentType: "application/did+ld+json", error },
  didDocument: null,
  didDocumentMetadata: { source: "off-chain" },
});

export async function resolveDid(
  did: string,
  deps: { registry?: IdentityRegistry; onChainError?: (err: unknown) => void },
): Promise<DidResolutionResult> {
  if (typeof did !== "string" || !did.startsWith("did:")) return failure("invalidDid");
  if (!did.startsWith("did:key:")) return failure("methodNotSupported");
  try {
    publicKeyFromDidKey(did);
  } catch {
    return failure("invalidDid");
  }

  const vm = `${did}#0`;
  const didDocument: ResolvedDidDocument = {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: did,
    verificationMethod: [{ id: vm, type: "Ed25519VerificationKey2020", controller: did, publicKeyMultibase: did.slice("did:key:".length) }],
    authentication: [vm],
    assertionMethod: [vm],
  };

  let didDocumentMetadata: DidDocumentMetadata = { source: "off-chain" };
  if (deps.registry) {
    try {
      const r = await deps.registry.anchor.didRegistration(deps.registry.didRegistry, did);
      didDocumentMetadata = {
        source: "chain",
        registered: r.registered,
        active: r.active,
        deactivated: r.registered && !r.active,
        chainId: deps.registry.chainId,
        registry: deps.registry.didRegistry,
      };
    } catch (err) {
      deps.onChainError?.(err);
    }
  }
  return { didResolutionMetadata: { contentType: "application/did+ld+json" }, didDocument, didDocumentMetadata };
}
```

- [ ] **Step 3: Run → PASS + commit**

`pnpm -s --filter @tokenlayer/api test -- did-resolver` green; full `pnpm -s --filter @tokenlayer/api test` still green; typecheck clean.
```bash
git add apps/api/src/did-resolver.ts apps/api/test/did-resolver.test.ts
git commit -m "feat(api): resolveDid — W3C DID resolution over did:key + on-chain DidRegistry"
```

---

## Task K2: API — public `/dids/:did/resolve` route + document-route delegation

**Files:**
- Modify: `apps/api/src/http/routes.ts` (new route + rewrite `GET /dids/:did/document` body)
- Modify: `apps/api/src/http/schemas.ts` (`didResolve` schema)
- Test: `apps/api/test/did-resolver.test.ts` (extend with route tests)

- [ ] **Step 1: Failing route tests** (append to `did-resolver.test.ts`; use `buildTestApp` from `./helpers.js` — read an existing route test for the login/inject pattern)

Cases:
1. `GET /api/v1/dids/:did/resolve` with NO Authorization header → 200; body has `didDocument.id === did`, `didDocumentMetadata.source === "off-chain"` (test app built without registry).
2. Same route on an app built with `registry: fakeRegistry(anchor)` where the DID is registered → `didDocumentMetadata` `{ source: "chain", registered: true, active: true, … }`.
3. `GET /api/v1/dids/did:web:x/resolve` (no auth) → 200 with `didResolutionMetadata.error === "methodNotSupported"`, `didDocument: null`.
4. `GET /api/v1/dids/garbage/resolve` → 200 with `error === "invalidDid"`.
5. Back-compat: `GET /api/v1/dids/:did/document` (authed, valid DID, registry app) returns the OLD shape — top-level `id`, `verificationMethod`, and `registration: { registered: true, active: true, chainId, registry }`; and an invalid DID still → 400 `UNSUPPORTED_DID`.

Run → FAIL (route 404 / old inline logic).

- [ ] **Step 2: Schema** (`apps/api/src/http/schemas.ts`, beside `didDocument`)

```ts
  didResolve: {
    tags: ["Identity"], summary: "Public: resolve a DID (W3C DID Resolution Result; did:key + on-chain registration)",
    params: { type: "object", required: ["did"], properties: { did: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true } },
  },
```
(Match the neighbouring entries' style. The loose 200 is REQUIRED — fast-json-stringify would strip the nested resolution fields otherwise. No `errs(...)`: the route always 200s.)

- [ ] **Step 3: Routes** (`apps/api/src/http/routes.ts`)

Import at top (beside the other local imports): `import { resolveDid } from "../did-resolver.js";`

Add the PUBLIC route immediately BEFORE the existing `GET /dids/:did/document` (~line 2202):

```ts
  // PUBLIC W3C DID resolution — a DID document is public key material; same
  // public posture as /credentials/:id/status. Third-party verifiers resolve
  // an issuer DID against the on-chain DidRegistry with no platform account.
  app.get("/dids/:did/resolve", { schema: S.didResolve }, async (request) => {
    const { did } = request.params as { did: string };
    return resolveDid(did, {
      registry: deps.registry,
      onChainError: (err) => request.log.error({ err, did }, "on-chain DID registration read failed"),
    });
  });
```

Rewrite the BODY of the existing `GET /dids/:did/document` handler (keep its schema, auth, and response contract exactly):

```ts
  app.get("/dids/:did/document", { schema: S.didDocument, ...auth }, async (request, reply) => {
    const { did } = request.params as { did: string };
    const res = await resolveDid(did, {
      registry: deps.registry,
      onChainError: (err) => request.log.error({ err, did }, "on-chain DID registration read failed"),
    });
    if (res.didResolutionMetadata.error || !res.didDocument) {
      return reply.code(400).send({ error: "UNSUPPORTED_DID", message: "only did:key ed25519 can be resolved" });
    }
    const m = res.didDocumentMetadata;
    const registration = m.source === "chain"
      ? { registered: m.registered, active: m.active, chainId: m.chainId, registry: m.registry }
      : null;
    return { ...res.didDocument, registration };
  });
```
(Delete the now-dead inline construction. `publicKeyFromDidKey` may become unused in routes.ts — remove it from the import ONLY if nothing else in the file uses it; grep first.)

- [ ] **Step 4: Run → PASS + commit**

New route tests green; FULL api suite green (document-route consumers, MyIdentity flows untouched); typecheck clean.
```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/did-resolver.test.ts
git commit -m "feat(api): public GET /dids/:did/resolve + document route delegated to resolveDid"
```

---

## Task K3: API — verify-route trust via resolver + `issuerResolution` enrichment

**Files:**
- Modify: `apps/api/src/http/routes.ts` (verify route STEP 1 + the per-credential result build)
- Modify: `apps/api/src/http/schemas.ts` (ONLY if the verify response schema strictly declares credential items — check first)
- Test: `apps/api/test/did-resolver.test.ts` or the existing verification test file (one new enrichment test)

- [ ] **Step 1: Failing test**

In the existing verification flow test (grep the file exercising request→consent→verify — reuse its full setup), add: with a registry-backed app (`fakeRegistry`) and a registered issuer, the verify result's `credentials[0].issuerResolution` equals `{ registered: true, active: true, chainId: "besu" }`; with a chainless app, `issuerResolution` is `null`. Run → FAIL.

- [ ] **Step 2: STEP 1 rewrite** (routes.ts:2594-2607 — replace the `const trusted…` loop; keep the `issuerDids` collection above it)

```ts
    const resolutions = new Map<string, Awaited<ReturnType<typeof resolveDid>>>();
    for (const did of issuerDids) {
      if (!did) continue;
      resolutions.set(did, await resolveDid(did, {
        registry: deps.registry,
        onChainError: (err) => request.log.error({ err, did }, "on-chain issuer-trust read failed"),
      }));
    }
    const trusted: string[] = [];
    for (const [did, res] of resolutions) {
      const m = res.didDocumentMetadata;
      if (m.source === "chain") {
        if (m.registered && m.active) trusted.push(did);
      } else if (!deps.registry && (deps.trustedKycIssuers ?? []).includes(did)) {
        trusted.push(did);
      }
    }
```
EQUIVALENCE INVARIANT (the whole point): registry present + read ok → trust = `registered && active`; registry present + read failed → `source: "off-chain"` and `deps.registry` set → NOT trusted (no allowlist fallback); registry absent → allowlist. This must be byte-equivalent to the old loop — every existing verification test stays green UNTOUCHED.

- [ ] **Step 3: Enrichment** (the `credentials` map at routes.ts:2621-2650)

Inside the map callback, derive and add one field to the returned object:
```ts
      const issuerDid = c.credential?.issuer ?? null;
      const resMeta = issuerDid ? resolutions.get(issuerDid)?.didDocumentMetadata : undefined;
```
and in the `return { … }` add:
```ts
        issuerResolution: resMeta && resMeta.source === "chain"
          ? { registered: resMeta.registered, active: resMeta.active, chainId: resMeta.chainId }
          : null,
```
(Reuses STEP 1's resolutions — no extra chain reads.)

- [ ] **Step 4: Schema check**

Find the verify route's response schema in schemas.ts (the route registered with the verification `POST …/verify`). If its `credentials` items are strictly declared (no `additionalProperties: true`), add `issuerResolution: { type: ["object", "null"], additionalProperties: true }` to the items (or loosen the items with `additionalProperties: true`) — else fast-json-stringify silently strips the new field. If the schema is already loose, no change.

- [ ] **Step 5: Run → PASS + commit**

New test green + FULL api suite green (esp. every existing verification test, unmodified). Typecheck clean.
```bash
git add apps/api/src/http/routes.ts apps/api/src/http/schemas.ts apps/api/test/
git commit -m "feat(api): verify issuer trust via resolveDid + per-credential issuerResolution"
```

---

## Task K4: Web — issuer pills in verification results + resolver link on the card

**Files:**
- Modify: `apps/web/src/types.ts` (`VerificationResult` credentials entry)
- Modify: `apps/web/src/api.ts` (`didResolveUrl` helper)
- Modify: `apps/web/src/components/VerificationRequests.tsx` (issuer pill per credential)
- Modify: `apps/web/src/components/CredentialCard.tsx` (issuer DID line → public resolver link)

- [ ] **Step 1: Types** (`apps/web/src/types.ts:458-466` — the `VerificationResult` interface's credentials entry)

Add to the per-credential object type:
```ts
    issuerResolution?: { registered: boolean; active: boolean; chainId: string } | null;
```

- [ ] **Step 2: api helper** (`apps/web/src/api.ts`, beside `certificateUrl`)

```ts
  didResolveUrl: (did: string): string => `${BASE}/dids/${encodeURIComponent(did)}/resolve`,
```

- [ ] **Step 3: Issuer pill** (`apps/web/src/components/VerificationRequests.tsx` — inside `result.credentials.map((c, i) => …)`, beside the existing `check(...)` spans at ~:93-95)

```tsx
                  {c.issuerResolution && (
                    c.issuerResolution.active
                      ? <Pill tone="ok">issuer on-chain · {c.issuerResolution.chainId} · active</Pill>
                      : c.issuerResolution.registered
                        ? <Pill tone="danger">issuer deactivated</Pill>
                        : <Pill tone="muted">issuer not registered</Pill>
                  )}
```
(`Pill` is already imported in that file — verify; import from `./ui.js` if not. Place it where it reads naturally in the credential row — e.g. after the checks spans.)

- [ ] **Step 4: Card resolver link** (`apps/web/src/components/CredentialCard.tsx` — the `issuer · {c.issuerDid}` div in the details block)

```tsx
          <div className="text-[11px] text-slate-500 font-mono break-all">
            issuer · <a className="text-brand-600 hover:text-brand-700 underline decoration-dotted"
              href={api.didResolveUrl(c.issuerDid)} target="_blank" rel="noopener noreferrer">{c.issuerDid}</a>
          </div>
```
(`api` is already imported in CredentialCard since ID-I.)

- [ ] **Step 5: Verify + commit**

`pnpm -s --filter @tokenlayer/web typecheck` clean; `pnpm -s --filter @tokenlayer/web build` succeeds.
```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/components/VerificationRequests.tsx apps/web/src/components/CredentialCard.tsx
git commit -m "feat(web): issuer on-chain resolution pills + public DID-resolver link on the card"
```

---

## Task K5: Verify — suites + LIVE BESU anchored walkthrough + review + finish

- [ ] **Step 1: Full suites**
```bash
pnpm -s typecheck
pnpm -s --filter @tokenlayer/core test
pnpm -s --filter @tokenlayer/api test
pnpm -s --filter @tokenlayer/web build
```
All green (core untouched — count unchanged).

- [ ] **Step 2: LIVE BESU anchored walkthrough** (the point of ID-K — real chain, everything anchored)

Boot (throwaway DB, **`dev.db` untouched**, Besu configured — NO `CHAIN_STRICT=0` chainless shortcut this time):
```bash
cd apps/api && DATABASE_URL="file:./dev-kdemo.db" ./node_modules/.bin/prisma db push --skip-generate --accept-data-loss
# then, with root .env sourced (DID_MASTER_KEY, JWT_SECRET, escrow/fee accounts, DEV_KYC/TRUSTED issuers):
BESU_RPC_URL=http://localhost:8545 BESU_OPERATOR_KEY=0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63 \
REGISTRY_CHAIN_ID=besu CHAIN_STRICT=0 DATABASE_URL="file:./dev-kdemo.db" PORT=4000 LOGIN_RATE_LIMIT_MAX=1000 \
CORS_ORIGINS=http://localhost:5173 ENABLED_DOMAINS=tokenization,identity exec ./node_modules/.bin/tsx src/server.ts
```
(`CHAIN_STRICT=0` only tolerates OTHER absent chains — Besu itself is configured, so the registry deploys/resolves on it. Boot log must show the registry resolved on besu, NOT the "UNANCHORED" line. Fresh-DB-on-existing-chain: seed token-contract deploys may leave some use cases pending — harmless; if boot wedges on "Known transaction", restart the besu nodes once, then reboot the API.)

Walkthrough script (scratchpad, mirror `tpl-cert-walkthrough.mjs` + the eth_call section of `scripts/identity-to-tokenization-e2e.mjs`):
1. Provision from `domicile-certificate` (ID-J) → org DID registered on-chain at provision/boot.
2. **Public resolver**: `GET /dids/<orgDid>/resolve` with NO token → `didDocumentMetadata` `{ source: "chain", registered: true, active: true, chainId: "besu", registry: "0x…" }`.
3. **Independent proof**: raw `eth_call` to the DidRegistry address for the org DID's registration (reuse the encoding pattern from `scripts/identity-to-tokenization-e2e.mjs`) — matches the resolver's answer without going through the API.
4. Issue a DomicileCredential → approve → `GET /credentials/:id/status` shows `{ anchored: true, source: "chain" }`; independent `eth_call` `credentialStatusOf` shows `exists: true, revoked: false`; the ID-I certificate PDF downloads (rendered from live chain status).
5. Verifier flow (request → holder consent → verify): result `credentials[0].issuerResolution` = `{ registered: true, active: true, chainId: "besu" }`, `valid: true`.
6. Revoke (chain-first) → `eth_call` now shows `revoked: true` → re-verify → `notRevoked` fails / `valid: false` → certificate PDF re-renders with the REVOKED watermark. The resolver STILL resolves the issuer (revocation ≠ DID deactivation).
7. Save the resolver JSON + both PDFs; screenshots if driven via browser.
Teardown: kill the API, delete `dev-kdemo.db*`; confirm `git status` shows `dev.db` clean.

- [ ] **Step 3: Final review** — whole-implementation review. Focus: trust-path byte-equivalence (fail-closed in all three registry states), the public route leaks only public key material + registration state, document-route back-compat exact, no fabricated chain claims on read failure, schema strip-check done, web pills render all three states.

- [ ] **Step 4: Finish** — `superpowers:finishing-a-development-branch` (merge `feat/did-resolver` → main).

---

## Notes / risks

- **The equivalence invariant is the headline**: STEP 1's rewrite must preserve exact trust behavior (esp. read-failure ⇒ untrusted with NO allowlist fallback when a registry exists). Existing verification tests are the oracle — none may be edited.
- **fast-json-stringify strips undeclared fields** (ID-G/ID-I lesson): the resolve route needs a loose 200 schema; the verify response schema must be checked before `issuerResolution` will survive serialization.
- **`issuer` stays a string** on verify-result credentials; the enrichment is the new `issuerResolution` sibling (spec refinement recorded above).
- **FakeAnchor has no `failNext` on `didRegistration`** — the throw test monkey-patches the method on the instance (documented in the test); do NOT modify fake-anchor.ts unless the reviewer prefers a proper hook (then add `"didRegistration"` to its `boom` pattern consistently).
- **Live run realities**: fresh DB + long-lived Besu → token seed deploys may leave some tokenization use cases pending (boot continues; irrelevant to this walkthrough). The registries deploy fresh for the new DB on the same chain — expected.
- **Public exposure**: `/dids/:did/resolve` reveals whether a DID is registered/active on the platform's registry — that is the feature (a public trust registry), and it exposes no names/credentials/PII.
