# Sandbox / Test Mode (EN-D2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `tl_test_` key acts only on sandbox use cases and a `tl_live_` key only on real ones, so an integrator can exercise the whole platform — gates, maker-checker, webhooks, error shapes — without touching a chain or a register that matters.

**Architecture:** The in-memory ledger already exists (`packages/adapters/src/simulated-adapter.ts`) and `ChainInfo` already distinguishes `real` from `simulated`. This adds the **tenancy** that makes it safe to expose: an explicit `sandbox` flag on a use case (never derived from chain mode), a dedicated always-simulated chain, mode on keys and webhook endpoints, and **one symmetric predicate** enforced by a coverage test in the shape of `scope-coverage.test.ts`.

**Tech Stack:** packages/core (the mode vocabulary), apps/api (Fastify + Prisma/SQLite + vitest), apps/web (React + Vite), vitest.

**Spec:** `docs/superpowers/specs/2026-08-09-sandbox-test-mode-design.md`

---

## Ground rules for every task

1. **No existing behavioural test may be edited.** The suite is the back-compat oracle (628 api / 248 core / 107 web). If one genuinely encodes a bug, say so with the name and reason — never weaken one quietly.
2. **Mutation-check every guard.** Break it, confirm a *named* test fails, restore. Report each. A survivor means the test was passing for the wrong reason — strengthen it and say so. This has happened on every sub-project of this program and each time exposed something real.
3. **THE PARITY RULE.** Any new persisted field lands in the Prisma schema, the record type, the row type, the mapper, and the create/update literals in **both** `memory.ts` and `prisma.ts`, then `npx prisma generate` — one commit. Memory-harness tests cannot catch a prisma-side drop.
4. **THE ADDITIVITY RULE (from EN-D1, still in force).** `fast-json-stringify` silently strips undeclared response fields. You may ADD response `properties`; never remove `additionalProperties: true`, never narrow a schema. There is a structural test enforcing this — do not defeat it.
5. **Documentation is verified against enforcement (EN-D1).** Every route carrying `authScoped(...)` must document both credentials **and name its scope in prose**, or `openapi-contract.test.ts` fails. New routes must satisfy it, and the committed `apps/api/openapi.snapshot.json` must be regenerated deliberately (`pnpm --filter @tokenlayer/api openapi:snapshot`) with the diff reviewed, not reflexively accepted.
6. **No test directory here is typechecked** (`"include": ["src"]`) — a `@ts-expect-error` in a test is inert.
7. Run the api suite **once with `apps/api/.env` moved aside** and confirm an identical count.
8. Never touch `apps/api/prisma/dev.db*`. Kill APIs by port, never `pkill`.

## Coordination before you start

Three sessions are landing on `main`: the proposals-wire `useCaseKey` fix, the consent re-scope (both `routes.ts`/`schemas.ts`), and the **ERC-20 `decimals()` change** (`packages/contracts`, `packages/adapters`). The last one matters most here — sandbox issuance routes through the simulated adapter, and a decimals change alters what adapters report. **Branch from a `main` that includes it if it has landed; otherwise rebase before task D2-8's walkthrough**, so the block-number proof runs against shipping behaviour.

## File Structure

**Create**
| File | Responsibility |
|---|---|
| `packages/core/src/modes.ts` | `ResourceMode`, `modeAllows`, `sandboxChainsValid`. Pure. |
| `packages/core/test/modes.test.ts` | Symmetry, totality, the session asymmetry. |
| `apps/api/test/mode-coverage.test.ts` | Every use-case-touching route consults the gate or is exempt with a reason. |
| `apps/api/test/sandbox-mode.test.ts` | Cross-mode refusals, chain validation, immutability, clone-to-live. |
| `apps/web/src/lib/modes.ts` | Mirrored vocabulary + display helpers. |
| `apps/web/test/modes-view.test.ts` | Builder cannot produce an invalid chain/mode pair. |

**Modify**
| File | Change |
|---|---|
| `config/chains.json` | the `sandbox` entry |
| `apps/api/src/chains.ts` | build it as unconditionally simulated |
| `apps/api/prisma/schema.prisma` | `UseCase.sandbox`, `CredentialUseCase.sandbox`, `ApiKey.mode`, `WebhookEndpoint.mode`, `Event.mode` |
| `apps/api/src/persistence/{types,memory,prisma}.ts` | parity for all five |
| `apps/api/src/api-keys.ts` | two markers |
| `apps/api/src/http/{routes,schemas}.ts` | the gate, chain validation, clone-to-live, mode on key/endpoint creation |
| `apps/api/src/events.ts` | `Event.mode` at emit |
| `apps/api/src/webhooks/matching.ts` | one mode clause |
| `apps/api/src/analytics.ts` + register reads | exclude sandbox by default |
| `apps/web/src/components/*` | builder, key form, webhook form, environment indicators |

---

## Task D2-1: Core — the mode vocabulary

**Files:** Create `packages/core/src/modes.ts`, `packages/core/test/modes.test.ts`; modify `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { modeAllows, sandboxChainsValid, SANDBOX_CHAIN_ID, type ResourceMode } from "../src/index.js";

describe("modeAllows — symmetric on purpose", () => {
  it("permits only matching modes, in both directions", () => {
    expect(modeAllows("live", "live")).toBe(true);
    expect(modeAllows("test", "test")).toBe(true);
    expect(modeAllows("test", "live")).toBe(false);
    expect(modeAllows("live", "test")).toBe(false);
  });

  it("is total over the mode pair — no third value is reachable", () => {
    const modes: ResourceMode[] = ["live", "test"];
    for (const a of modes) for (const b of modes) expect(typeof modeAllows(a, b)).toBe("boolean");
  });

  it("A HUMAN SESSION HAS NO MODE and may act on both", () => {
    // The one asymmetry in the design: an OrgAdmin must be able to configure and
    // inspect their own sandbox. Callers pass null for a session.
    expect(modeAllows(null, "live")).toBe(true);
    expect(modeAllows(null, "test")).toBe(true);
  });
});

describe("sandboxChainsValid — both directions are errors", () => {
  it("a sandbox use case may allow ONLY the sandbox chain", () => {
    expect(sandboxChainsValid(true, [SANDBOX_CHAIN_ID])).toBe(true);
    expect(sandboxChainsValid(true, [SANDBOX_CHAIN_ID, "besu"])).toBe(false);
    expect(sandboxChainsValid(true, ["besu"])).toBe(false);
    expect(sandboxChainsValid(true, [])).toBe(false);
  });

  it("a LIVE use case may never allow the sandbox chain", () => {
    // Otherwise a real-looking asset mints on an in-memory ledger.
    expect(sandboxChainsValid(false, ["besu"])).toBe(true);
    expect(sandboxChainsValid(false, ["besu", SANDBOX_CHAIN_ID])).toBe(false);
    expect(sandboxChainsValid(false, [SANDBOX_CHAIN_ID])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

```bash
pnpm --filter @tokenlayer/core test -- --run modes
```

- [ ] **Step 3: Implement**

`packages/core/src/modes.ts`:

```ts
/**
 * Live vs test (EN-D2). A `tl_test_` key acts only on sandbox use cases and a
 * `tl_live_` key only on real ones.
 *
 * ISOLATION REUSES `useCaseKey`. Assets, credentials, verification requests,
 * proposals and events carry NO mode of their own — their mode is the mode of
 * the use case they belong to, and they are already scoped by it. Adding a
 * per-row flag would create a second tenancy dimension parallel to `orgId`, and
 * a tenancy predicate has produced a finding on every sub-project of this
 * program so far.
 */
export type ResourceMode = "live" | "test";

/** The dedicated always-simulated chain. Never promoted to real by any env. */
export const SANDBOX_CHAIN_ID = "sandbox";

/**
 * May a principal act on a resource?
 *
 * Written as EQUALITY, not as a guard against one direction: a live key
 * reaching sandbox data and a test key reaching live data are both wrong, and
 * neither is the safe one to forget.
 *
 * `actor === null` is A HUMAN SESSION, which has no mode and may act on both —
 * an OrgAdmin has to be able to configure and inspect their own sandbox. That
 * is the single asymmetry in this design and the thing most likely to be got
 * wrong later, so it is explicit here rather than implied at a call site.
 */
export function modeAllows(actor: ResourceMode | null, resource: ResourceMode): boolean {
  return actor === null || actor === resource;
}

/** The chain rule, in both directions. */
export function sandboxChainsValid(sandbox: boolean, allowedChainIds: readonly string[]): boolean {
  if (allowedChainIds.length === 0) return false;
  return sandbox
    ? allowedChainIds.every((c) => c === SANDBOX_CHAIN_ID)
    : allowedChainIds.every((c) => c !== SANDBOX_CHAIN_ID);
}
```

Export from `packages/core/src/index.ts` alongside the other closed vocabularies.

- [ ] **Step 4: Run, then mutation-check**

1. `modeAllows` → `actor !== "test" || resource === "test"` (guards one direction only). The live-key-on-sandbox case must fail.
2. `sandboxChainsValid`'s live branch → `return true`. The live-allows-sandbox case must fail.
3. Drop the `actor === null` arm. The session test must fail.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/modes.ts packages/core/test/modes.test.ts packages/core/src/index.ts
git commit -m "feat(core): live/test mode vocabulary and the sandbox chain rule (EN-D2)"
```

---

## Task D2-2: Persistence + the sandbox chain

**THE PARITY RULE APPLIES IN FULL** — all five fields, both repos, one commit.

**Files:** `config/chains.json`, `apps/api/src/chains.ts`, `apps/api/prisma/schema.prisma`, `apps/api/src/persistence/{types,memory,prisma}.ts`; test `apps/api/test/sandbox-mode.test.ts`.

- [ ] **Step 1: Add the chain**

`config/chains.json` — a new entry. Read the existing shape first; `fabric`/`canton` use `kind: "simulated"`, and `apps/api/src/chains.ts` decides real-vs-simulated from env for those. **The sandbox chain must not go through that path** — it is simulated unconditionally.

```json
{ "id": "sandbox", "label": "Sandbox (simulated)", "family": "mock", "kind": "simulated" }
```

In `chains.ts`, construct it with `SimulatedChainAdapter` (see `packages/adapters/src/simulated-adapter.ts`, whose family is `"mock"`) and force `mode: "simulated"`, `available: true`. Add a comment saying why no env may promote it: a live use case deploying to a chain that silently became real, or a sandbox one to a chain that did, are both data-integrity failures.

- [ ] **Step 2: Schema + record types**

```prisma
model UseCase {
  // …
  /// EN-D2: set at creation, never mutated. Sandbox use cases deploy only to
  /// the always-simulated `sandbox` chain and are excluded from analytics.
  sandbox Boolean @default(false)
}
model CredentialUseCase { /* … */ sandbox Boolean @default(false) }
model ApiKey           { /* … */ mode String @default("live") }
model WebhookEndpoint  { /* … */ mode String @default("live") }
model Event            { /* … */ mode String @default("live") }
```

`@default(false)` / `@default("live")` is what makes this a zero-migration change for every existing row — the same null-as-legacy instinct EN-A used, expressed as a default rather than a nullable.

Mirror in `types.ts` (`sandbox: boolean`, `mode: ResourceMode`), and in **both** repos' create literals and mappers. `npx prisma generate` from `apps/api`.

- [ ] **Step 3: Write the parity + chain tests, run, watch fail, implement**

```ts
it("the sandbox chain is simulated no matter what the env says", async () => {
  // Even with every real-chain env var set, `sandbox` must not be promoted.
  const chains = buildChains({ ...envWithEverythingConfigured });
  const s = chains.list().find((c) => c.id === "sandbox");
  expect(s).toMatchObject({ mode: "simulated", available: true });
});

it("existing rows default to live / non-sandbox", async () => {
  const uc = await repo.create({ /* no sandbox field */ });
  expect(uc.sandbox).toBe(false);
  const key = await apiKeys.create({ /* no mode field */ });
  expect(key.mode).toBe("live");
});
```

- [ ] **Step 4: Print the parity table**

For each of the five fields, a row with schema / record type / memory create / prisma create / prisma mapper. Do it honestly — a field supplied by a DB default is a legitimate absence from a create literal, and should be marked as such rather than ticked.

- [ ] **Step 5: Mutation-check + commit**

Drop `mode` from the prisma mapper → the default test must fail. Force `sandbox` chain to `mode: "real"` when `BESU_RPC_URL` is set → the chain test must fail.

```bash
git commit -m "feat(api): sandbox flag, key/endpoint/event modes, the sandbox chain (EN-D2)"
```

---

## Task D2-3: Two key markers

**Files:** `apps/api/src/api-keys.ts`, `apps/api/src/http/support.ts`, `apps/web/src/types.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it("mints a test secret with the tl_test_ marker and a live one with tl_live_", async () => {
  expect((await mintSecret(4, "test")).secret).toMatch(/^tl_test_/);
  expect((await mintSecret(4, "live")).secret).toMatch(/^tl_live_/);
});

it("the auth path accepts BOTH markers and records which one authenticated", async () => {
  // A key's mode is a property of the record, not of the string — but the string
  // must agree with it, or a pasted secret says one thing and behaves another.
  expect(prefixOf("tl_test_abcdefgh…")).not.toBeNull();
  expect(prefixOf("tl_live_abcdefgh…")).not.toBeNull();
  expect(prefixOf("tl_prod_abcdefgh…")).toBeNull();
});

it("REFUSES a secret whose marker disagrees with its stored mode", async () => {
  // Defence in depth: if the two ever diverge, fail closed rather than trusting
  // either. Prove it by storing a live-marked hash on a test-mode row.
});
```

- [ ] **Step 2: Implement**

Keep one exported constant per marker and derive a map from mode → marker, so adding a third mode later is one entry rather than a scattered literal. `prefixOf` recognises both and returns the mode it saw. The verification path compares that against the stored `mode` and refuses a mismatch.

Update the mirrored constant in `apps/web/src/types.ts`.

- [ ] **Step 3: Mutation-check**

Make `prefixOf` accept any `tl_` prefix → the `tl_prod_` test must fail. Drop the marker-vs-mode comparison → the mismatch test must fail.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(api): tl_test_ keys, with the marker checked against the stored mode (EN-D2)"
```

---

## Task D2-4: Enforcement — the gate and its coverage test

**This is the centrepiece.** The rule exists in one place and a test makes forgetting it a build failure.

**Files:** `apps/api/src/http/routes.ts`, `apps/api/test/mode-coverage.test.ts`, `apps/api/test/sandbox-mode.test.ts`.

- [ ] **Step 1: Write the coverage test first**

Model it on `scope-coverage.test.ts`, and reuse `apps/api/test/route-decls.ts` (EN-D1's shared brace-balancing parser — do **not** write a second parser).

```ts
/**
 * EN-D2: A ROUTE THAT RESOLVES A USE CASE AND FORGETS THE MODE GATE IS A
 * CROSS-ENVIRONMENT HOLE. Same discipline as scope-coverage: every such route
 * either calls the gate or appears below with a written reason.
 */
const MODE_EXEMPT: Record<string, string> = {
  "GET /use-cases": "listing is mode-filtered in the projection, not gated per row",
  // …each with a reason, and a staleness check that rejects entries no longer needed
};
```

Find candidate routes by scanning `routes.ts` for handlers that resolve a use case (`useCases.get(`, `credentialUseCases.get(`, `scopedAsset`, `resolveIssuer`, …). Assert each either calls the gate helper or is exempt. **Include a blind-spot assertion**: the scan must find a plausible number of candidates, so a broken matcher fails loudly rather than passing with zero.

- [ ] **Step 2: Write the behavioural tests**

```ts
it("a tl_test_ key is refused on a LIVE use case", async () => {
  // 403 WRONG_MODE with details {keyMode, useCaseMode} — a distinct code,
  // because "wrong environment" and "missing scope" have different fixes.
});
it("a tl_live_ key is refused on a SANDBOX use case", async () => { /* the other direction */ });
it("a human OrgAdmin succeeds on BOTH", async () => { /* the session asymmetry, live */ });
it("sandbox is immutable — 409 SANDBOX_IMMUTABLE pointing at clone-to-live", async () => {});
it("a live use case naming the sandbox chain is 400 INVALID_SANDBOX_CHAINS", async () => {});
it("a sandbox use case naming besu is 400 INVALID_SANDBOX_CHAINS", async () => {});
```

- [ ] **Step 3: Implement the gate**

One helper beside the other guards in `routes.ts`, taking the request and the resolved use case, returning a boolean and sending the 403 itself (matching how `apiKeyScope` behaves), so a call site cannot forget to act on the result.

- [ ] **Step 4: Mutation-check — five, and report each**

1. Remove the gate from the issuance route → the cross-mode test names it.
2. Make the gate one-directional → the live-key-on-sandbox test fails.
3. Empty `MODE_EXEMPT` → coverage names every route needing a decision.
4. Add a stale exemption → the staleness check fails.
5. Break the candidate matcher so it finds nothing → the blind-spot assertion fails.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(api): the mode gate, with a coverage test that makes forgetting it fail (EN-D2)"
```

---

## Task D2-5: Events and webhook endpoints

**Files:** `apps/api/src/events.ts`, `apps/api/src/webhooks/matching.ts`, `apps/api/src/http/{routes,schemas}.ts`.

- [ ] **Step 1: Failing tests**

```ts
it("an event carries the mode of the use case that produced it, never a caller-supplied one", async () => {});
it("a TEST event reaches a test endpoint and NOT a live endpoint of the same org", async () => {
  // The specific accident this prevents: a sandbox issuance arriving at a
  // production handler and being processed as a real credential.
});
it("a LIVE event reaches a live endpoint and not a test one", async () => {});
it("a platform-scope endpoint still only sees its own mode", async () => {});
```

- [ ] **Step 2: Implement**

`emitEvent` derives `mode` from the acting use case — **never** from `EmitInput`, so no call site can mislabel one. `endpointMatches` gains exactly one clause, written to read like the org disjunction beside it and commented for why mode is equality where org is a disjunction (a platform endpoint legitimately spans orgs; nothing legitimately spans modes).

- [ ] **Step 3: Mutation-check**

Drop the mode clause from `endpointMatches` → the cross-mode delivery test must fail. Let `EmitInput.mode` override → the derivation test must fail.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(api): mode-scoped events and webhook endpoints (EN-D2)"
```

---

## Task D2-6: Clone to live, and keeping sandbox out of the numbers

**Files:** `apps/api/src/http/{routes,schemas}.ts`, `apps/api/src/analytics.ts`, invoice-register reads.

- [ ] **Step 1: Failing tests**

```ts
it("clone-to-live copies CONFIGURATION and provably no data", async () => {
  // Assert the clone has the same fields/compliance/fees AND zero assets,
  // zero credentials, zero proposals. "No data came with it" is the claim.
});
it("returns 202 with a proposal for an OrgAdmin, like POST /use-cases", async () => {
  // Cloning creates a LIVE use case; giving the act a different name must not
  // bypass the governance the platform already applies to that.
});
it("refuses to clone a use case that is not sandbox", async () => {});
it("a sandbox asset is absent from analytics by default and present with includeSandbox=true", async () => {});
```

- [ ] **Step 2: Implement**

Clone copies config, allocates `<key>-live` (caller-overridable), sets `sandbox: false`, resets `allowedChainIds` to the caller's choice of real chains, and deploys through the existing path. Analytics and register reads filter sandbox use cases unless `includeSandbox=true`.

New routes must satisfy EN-D1's contract test: `authScoped(...)`, both credentials documented, **scope named in the description**, response properties declared additively. Then regenerate the snapshot and **read the diff**.

- [ ] **Step 3: Mutation-check**

Make the clone copy assets → the no-data test fails. Return 201 instead of 202 → the governance test fails. Drop the analytics filter → the exclusion test fails.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(api): clone-to-live and sandbox exclusion from analytics (EN-D2)"
```

---

## Task D2-7: Web — make the environment impossible to miss

**Files:** `apps/web/src/lib/modes.ts`, `apps/web/test/modes-view.test.ts`, the use-case builder, `Developers.tsx`, `Webhooks.tsx`.

- [ ] **Step 1: Failing tests for the pure helpers**

```ts
it("offers only the sandbox chain when sandbox is chosen, and never it otherwise", () => {});
it("a draft with a chain/mode mismatch cannot reach the create call", () => {});
it("labels a test key and a live key distinguishably", () => {});
```

- [ ] **Step 2: Implement**

The builder offers a sandbox choice at creation only (never an edit control — it is immutable, and an affordance the server will refuse is the EN-B lesson). The key form and webhook form carry mode. Every key row, endpoint row and delivery row shows its environment. Sandbox use cases are visually marked wherever they are listed, so nobody mistakes a sandbox asset for a real one at a glance.

- [ ] **Step 3: Mutation-check**

Let the builder offer besu under sandbox → the chain test fails. Drop the mode from the key row → the labelling test fails.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(web): sandbox in the builder, mode on keys and endpoints (EN-D2)"
```

---

## Task D2-8: Verify — and prove no chain was touched

- [ ] **Step 1: Suites**

```bash
pnpm --filter @tokenlayer/core test -- --run
pnpm --filter @tokenlayer/api test -- --run --testTimeout=180000
mv apps/api/.env apps/api/.env.bak && pnpm --filter @tokenlayer/api test -- --run --testTimeout=180000; mv apps/api/.env.bak apps/api/.env
pnpm --filter @tokenlayer/web test && pnpm --filter @tokenlayer/web build
npx tsc --noEmit -p apps/api && npx tsc --noEmit -p apps/web
```

The two api runs must report the **same** count.

- [ ] **Step 2: Live walkthrough — the block-number proof**

Boot against live Besu on a throwaway DB (standard recipe, `DATABASE_URL="file:./dev-sandbox.db"`). Then:

1. `eth_blockNumber` → record `before`.
2. Provision a **sandbox** credential programme; mint a `tl_test_` key.
3. Issue a credential end to end through maker-checker with that key. Confirm the holder holds it and the API reports success.
4. `eth_blockNumber` → record `after`.
5. **Assert nothing was anchored for it**: `VcRegistry.statusOf(ethers.id(credentialId))` returns `exists: false`.
6. Mint a `tl_live_` key and attempt the same use case → **403 `WRONG_MODE`**.
7. Clone to live, approve, mint a live key, issue for real → and now `statusOf` returns `exists: true`, proving the live path still works.

On (4): Besu mines on a timer, so `after` will normally exceed `before`. **The proof is (5) plus the absence of any transaction from our operator address** — check `eth_getTransactionCount` for the operator before and after and assert it is unchanged. Say which evidence you used; do not assert "no blocks were mined" if blocks were mined.

- [ ] **Step 3: Browser pass**

Sandbox use case visibly marked; a `tl_test_` key shows its environment; a test webhook endpoint receives a sandbox event while a live endpoint of the same org does not; analytics excludes the sandbox asset until the toggle is set.

- [ ] **Step 4: Teardown**

Kill port 4000 by port, stop the web server, `rm apps/api/prisma/dev-sandbox.db*`, verify `dev.db` and `dev.db.freshkey.bak` mtimes unchanged, prune agent worktrees (leave any holding uncommitted work), confirm a clean tree.

- [ ] **Step 5: Final whole-branch review**

Isolated worktree, briefed to **hunt independently**. Point it at, without limiting it to: whether any path lets a test key reach live data or the reverse (especially reads, and especially routes that resolve a use case indirectly); whether the human-session exemption is wider than intended; whether a sandbox asset can reach any customer-facing total; whether `Event.mode` can be influenced by a caller; whether the marker-vs-mode check can be bypassed; and whether clone-to-live can copy anything it should not.

- [ ] **Step 6: Finish the branch**

`superpowers:finishing-a-development-branch` (standing choice: merge locally, `--no-ff`), delete the branch, update `enterprise-program.md` — EN-D2 merged with its sha, EN-E next, plus new gotchas.

---

## Self-review

**Spec coverage.** Explicit-not-derived flag → D2-2. Sandbox chain, unconditionally simulated → D2-2. `modeAllows` symmetric + session asymmetry → D2-1. One predicate + coverage test → D2-4. `tl_test_` marker and the marker/mode agreement check → D2-3. Mode-scoped endpoints and derived `Event.mode` → D2-5. Clone-to-live, config-only, 202 → D2-6. Analytics exclusion → D2-6. Web indicators + immutable-at-creation → D2-7. Error codes (`WRONG_MODE`, `INVALID_SANDBOX_CHAINS`, `SANDBOX_IMMUTABLE`) → D2-4/D2-6. Walkthrough with independent chain evidence → D2-8. Excluded-from-v1 items (reset, interactive mutation, per-row flags, sandbox quotas) are not planned anywhere, matching the spec.

**Placeholder scan.** No TBD/TODO. The candidate-route list for D2-4 is generated by a failing test rather than hand-enumerated — deliberate, because a hand list would be stale before the task began, and the same technique EN-D1 used for its response-documentation queue.

**Type consistency.** `ResourceMode` and `modeAllows(actor, resource)` argument order identical in D2-1's tests, the implementation and every later call; `SANDBOX_CHAIN_ID` exported once from core and used by both the chain catalog check and the web builder; `MODE_EXEMPT` mirrors `DELIBERATELY_UNSCOPED`/`DOCUMENTATION_DEFERRED` naming; `route-decls.ts` reused rather than reimplemented.
