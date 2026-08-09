# Sandbox / Test Mode (EN-D2) — Design

**Goal:** Let an integrator build against a real API — real gates, real maker-checker, real webhooks, real error shapes — without touching a chain, spending gas, or putting anything into a register that matters. A `tl_test_` key acts only on sandbox use cases; a `tl_live_` key acts only on real ones; neither can reach the other's data.

**Program context:** EN-A gave organizations a capability envelope. EN-B added org-scoped API keys. EN-C added signed webhooks and a durable event log. EN-D1 documented all of it and shipped a portal — and deliberately withheld interactive mutation from the reference, because a documentation page must not issue a credential against live data. EN-D2 is the environment where doing that is safe.

**Tech stack:** apps/api (two flags, a chain-catalog entry, one enforcement predicate, mode-scoped keys and webhook endpoints, clone-to-live), packages/core (the mode vocabulary), apps/web (mode in the use-case builder, the key form, the webhook form, and a visible environment indicator). **No new ledger code** — see below.

---

## The expensive part already exists

`packages/adapters/src/simulated-adapter.ts` is an in-memory ledger that mirrors the on-chain compliance rules, and it is the shared engine behind the mock, Fabric and Canton adapters. `ChainInfo` already carries **`mode: "real" | "simulated"`**, and `computeAnalytics` already tags each chain with it.

So EN-D2 does not build a mock chain. It adds the *tenancy* that makes one safe to hand to a customer.

**And it must not derive sandbox from that existing flag.** `ChainInfo.mode` is a function of deployment configuration — Fabric reports `"simulated"` precisely when its connection env is absent. Deriving "this use case is sandbox" from "its chain is currently simulated" would mean an operator who has not yet configured Fabric finds real use cases classified as sandbox and reachable by test keys, and that bringing Fabric online silently reclassifies them. The flag is therefore **explicit and set at creation**, and the chain rule is an *enforcement* mechanism layered on top, not the definition.

## The mode axis

A single vocabulary in `packages/core/src/modes.ts`, shared by API and web:

```ts
export type ResourceMode = "live" | "test";
```

Four things carry it:

| carrier | how |
|---|---|
| `UseCase.sandbox` / `CredentialUseCase.sandbox` | `Boolean @default(false)` — explicit, set at creation, **immutable thereafter** |
| `ApiKey.mode` | `"live" \| "test"`, default `"live"`; a test key's secret reads `tl_test_…` |
| `WebhookEndpoint.mode` | `"live" \| "test"`, default `"live"` |
| `Event.mode` | derived at emit from the acting use case; never supplied by a caller |

Everything else — assets, credentials, verification requests, proposals, staged invoices — carries **no flag at all**. Their mode is the mode of the use case they belong to, and they are already scoped by `useCaseKey`. That is the whole point of choosing this shape: **isolation reuses a tenancy predicate that already works** rather than adding a second one parallel to `orgId`. The final review has found a tenancy defect on every sub-project of this program; inventing another dimension is how you get a fifth.

## One predicate, and a coverage test

Following EN-C's `endpointMatches` and EN-B's scope map, the rule lives in exactly one place:

```ts
/** May a principal in `actor` mode act on a resource in `resource` mode? */
export function modeAllows(actor: ResourceMode, resource: ResourceMode): boolean {
  return actor === resource;
}
```

Deliberately **not** written as a truthiness check or a `!==` guard scattered at call sites. It is symmetric and total: a live key cannot touch sandbox, a test key cannot touch live, and neither direction is the "safe" one to forget.

A **human session has no mode** and may act on both — an OrgAdmin must be able to configure and inspect their sandbox. That asymmetry is the one thing about this design most likely to be got wrong later, so it is stated in the predicate's doc comment and pinned by tests in both directions.

`apps/api/test/mode-coverage.test.ts` mirrors `scope-coverage.test.ts`: **every route that resolves a use case must consult the mode gate, or appear in a `MODE_EXEMPT` table with a written reason.** A new route that touches a use case and forgets the check fails the build.

## The sandbox chain

A catalog entry `sandbox`, `mode: "simulated"` **unconditionally** — unlike Fabric and Canton, no env can promote it to real. A sandbox use case's `allowedChainIds` may contain only this chain; a live use case may not contain it. Both directions are validated at creation, because a live use case allowed to deploy to the sandbox chain would produce real-looking assets on an in-memory ledger.

Contracts deploy to it through the existing path, so a sandbox use case exercises the same deploy-then-issue flow — including deployment failure modes — that a live one does.

## Key and endpoint modes

**Keys.** `POST /orgs/:id/api-keys` accepts `mode`, defaulting to `"live"`. A test key's secret carries the `tl_test_` marker. `KEY_PREFIX_MARKER` becomes two markers; the auth path recognises both and records which one authenticated. The mirrored constant in `apps/web/src/types.ts` follows, and the Developers console shows the mode as a pill on every row — a secret you cannot tell apart from a live one is the failure this choice exists to prevent.

**Endpoints.** A webhook endpoint is registered `live` or `test` and receives only events of its own mode. `endpointMatches` gains one clause. Sandbox activity therefore cannot reach a production handler and be processed as a real issuance — which is the specific accident that makes "one endpoint, filter on a field" the wrong default.

## Clone to live

`POST /use-cases/:key/clone-to-live` (and the credential-use-case equivalent) copies **configuration only**: fields, compliance rules, fees, lifecycle, certificate design, holder policy. It does not copy assets, credentials, holders, proposals or events, and it redeploys contracts against the real chain.

It returns **202 with a proposal** for an OrgAdmin, exactly as `POST /use-cases` already does — cloning creates a live use case, and the platform's existing governance for that must not be bypassed by giving the act a different name. The sandbox original keeps running.

The new use case gets a distinct key (`<key>-live` by default, caller-overridable) because keys are unique per domain, and the response says plainly which key was created.

## What is deliberately excluded from v1

- **Sandbox reset.** Deleting a sandbox use case and creating another already achieves it; a bulk "wipe my sandbox" is a destructive operation that deserves its own design rather than a corner of this one.
- **Interactive mutation in the API reference.** EN-D1 withheld it pending sandbox, and it stays withheld: try-it executes with the **human session**, which has no mode, so making it safe means giving the reference a way to act as a test key — a real design question about credential handling in a browser, not a checkbox. Recorded as the next thing worth doing, not smuggled in here.
- **A per-row `testMode` column.** Rejected above.
- **Sandbox rate limits or quotas.** The existing per-key limit applies unchanged.

## Error handling

- A key acting across modes → **403 `WRONG_MODE`**, with `details: {keyMode, useCaseMode}`. A distinct code, not a generic 403: "your test key hit a live use case" is a different fix from "you lack a scope", and an integrator should not have to guess which.
- A live use case naming the sandbox chain, or a sandbox use case naming any other → **400 `INVALID_SANDBOX_CHAINS`** naming both.
- Attempting to change `sandbox` after creation → **409 `SANDBOX_IMMUTABLE`**, pointing at clone-to-live.
- Cloning a use case that is not sandbox → **400**, since the operation has no meaning.

## Reads, analytics and registers

Sandbox use cases are **excluded by default** from `GET /analytics`, the org dashboards and the invoice register, with an explicit `?includeSandbox=true` for someone who wants to see it. A sandbox asset counted in a customer's headline supply figure is a reporting defect, and the default must be the safe one.

`GET /events` and the delivery log stay mode-scoped through the endpoint that produced them.

## Testing

- **core:** `modeAllows` is total and symmetric; both cross-mode directions refused; a session (no mode) permitted on both.
- **mode coverage:** every use-case-touching route consults the gate or is exempt with a reason, and the exemption table has no stale entries.
- **api:** a `tl_test_` key issuing on a live use case → 403 `WRONG_MODE`; a `tl_live_` key on a sandbox use case → 403 `WRONG_MODE`; a human OrgAdmin succeeds on both; sandbox chain validation refuses both bad directions; `sandbox` is immutable; clone-to-live copies configuration and **provably no data** (assert the new use case has zero assets/credentials); a sandbox issuance produces an event of mode `test` delivered only to a test endpoint, and a live endpoint of the same org receives nothing.
- **analytics:** a sandbox asset is absent by default and present with `includeSandbox=true`.
- **web:** the environment is visible wherever a key or endpoint is shown; the builder cannot produce an invalid chain/mode combination.
- **live walkthrough:** provision a sandbox programme; mint a `tl_test_` key; issue a credential end to end **with Besu running but untouched** — proven by comparing the Besu block number before and after, and by the absence of any anchor for that credential. Then mint a `tl_live_` key and show it refused on the same use case. Then clone to live and issue for real, confirming *that* one anchors on-chain.

That block-number comparison is the heart of the whole sub-project: the claim is "no chain was touched", and only an independent reading of the chain proves it.

## Verification / done

Full core + api + web suites (including one api run with `.env` moved aside, counts identical), both builds, the live walkthrough above, a browser pass, then the final whole-branch review — which, per EN-A through EN-D1, hunts independently. Then finish the branch (`feat/sandbox-mode` → main).

## Coordination note

Three sessions are running against `main` and touch files this sub-project also touches: the proposals-wire fix and the consent re-scope (`routes.ts`, `schemas.ts`), and the ERC-20 `decimals()` change (`packages/contracts`, `packages/adapters`). The last of those is the closest — EN-D2 routes issuance to the simulated adapter, and a decimals change alters what both adapters report. **Let those land first, or rebase onto them before the walkthrough**, so the block-number proof is run against the adapter behaviour that will actually ship.

## Alternatives considered

- **Derive sandbox from `ChainInfo.mode`** — no new field, but deployment configuration would silently decide which use cases are sandbox, and bringing a chain online would reclassify them. Covered above.
- **A `testMode` column on every model** — the literal reading of the brief. It permits one use case holding both kinds of data, at the cost of a second tenancy dimension across eight models and a filter on every read path. The chosen shape gets isolation from `useCaseKey`, which is already enforced and already reviewed.
- **A separate sandbox deployment** — perfect isolation, and an operator burden (a second database, a second process, a second set of credentials) that puts sandboxing out of reach for exactly the smaller integrators who need it most.
- **Same key marker for both modes** — one less constant to change, and two secrets that look identical while behaving completely differently. The prefix is what turns a pasted-wrong-key incident into something visible.
- **Sandbox events to production endpoints with a `mode` field** — fewer objects to configure, and it sends test traffic to a production handler by default. Every consumer would have to remember the check, and forgetting it processes a sandbox issuance as real.
