# Remove Sandbox Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the test/live "sandbox" mode feature completely — schema, backend, frontend, tests, and the one docs guide that instructs users into it — from both the tokenization and identity products.

**Architecture:** Removal, not addition, so the task order inverts the usual TDD shape and instead follows a strict dependency direction: delete every *usage* of the mode concept first (route call sites, error codes, UI), verify the codebase still compiles and the full suite still passes with unused definitions left dangling, THEN delete the now-dead *definitions* (the shared helpers, the config entry), and only in the LAST task drop the actual database columns — because dropping a column while application code still reads it would break compilation at every intermediate step instead of only at the end.

**Tech Stack:** Fastify 5 + Prisma/SQLite (apps/api), React + Vite (apps/web), TypeScript throughout, vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-remove-sandbox-mode-design.md`

## Global Constraints

- **Verified fact, not an assumption:** zero rows anywhere (combined stack, both split stacks) use a non-default value for `UseCase.sandbox`, `CredentialUseCase.sandbox`, `ApiKey.mode`, `Event.mode`, `WebhookEndpoint.mode`. This removal is pure code deletion — no data migration branch, no "convert existing sandbox rows" step exists in this plan because there is nothing to convert.
- **Existing API keys must keep working unchanged.** Every key ever issued carries a `tl_live_` prefix (the codebase's own comment confirms `mode` currently DEFAULTS to `"live"` for every pre-existing key). The prefix format is NOT changing — only the branch that could ever produce a `tl_test_` key goes away.
- **"Never edit an existing test" is deliberately suspended for this plan, and only this plan, for tests whose entire subject is the feature being deleted.** Deleting `apps/api/test/sandbox-mode.test.ts` (etc.) is not weakening coverage of something that still exists — the thing it tests is gone. Any OTHER test that merely sets `sandbox: false` in a fixture gets that field dropped from the fixture (wiring), never an assertion changed.
- Run tests with explicit timeouts on this machine: `npx vitest run <path> --testTimeout=45000 --hookTimeout=45000`.
- The `packages/contracts` six pre-existing Hardhat-under-vitest file failures are unrelated and out of scope — ignore them in every full-suite run.
- The full `apps/api` suite currently takes ~3 minutes; run it in the FOREGROUND, never backgrounded — this machine has repeatedly lost implementer turns to a backgrounded long-running suite. Where a task's own step tells you to run only a targeted test, do that; the controller runs the full suite between tasks.
- NEVER touch `apps/api/prisma/dev.db*` directly; migrations go through `prisma migrate dev`.
- After ANY `schema.prisma` change, run `pnpm --filter @tokenlayer/api exec prisma generate` or the Prisma client's TypeScript types will not reflect it.
- **The completion bar for every deletion step is a grep returning ZERO hits**, not "I removed the parts I noticed." Each task below names the exact verification command — run it, and if it returns anything, the task is not done yet.

---

## File Structure

| File / area | What happens to it |
|---|---|
| `apps/api/src/shared/sandbox.ts` | Deleted whole (Task 2) |
| `packages/core/src/shared/modes.ts` | Deleted whole (Task 2) — `ResourceMode`, `modeAllows`, `SANDBOX_CHAIN_ID`, `sandboxChainsValid` all live only here |
| `packages/core/src/index.ts` | Drop the re-export of the above (Task 2) |
| `config/chains.json` | Drop the `"sandbox"` entry (Task 2) |
| `apps/api/src/shared/chains.ts` | Drop the `SANDBOX_CHAIN_ID` special-case branch (Task 2) |
| `apps/api/src/shared/api-keys.ts` | Collapse `KEY_PREFIX_MARKERS`/mode-aware `mintSecret` down to one fixed `tl_live_` prefix (Task 1) |
| `apps/api/src/http/routes/{shared,tokenization,identity,context,common,index}.ts` | Remove `modeGate`/`modeGateByKey`/`sandboxChainsRefused`/`sandboxImmutable`/`modeFilter` and every call site; remove the two `clone-to-live` routes (Task 1) |
| `apps/api/src/http/schemas/{shared,tokenization,identity,components}.ts` | Remove the sandbox/mode schema fields and the `clone-to-live` schemas (Task 1) |
| `apps/api/src/webhooks/matching.ts` | Remove the `ep.mode !== ev.mode` gate (Task 1) |
| `apps/api/test/{sandbox-mode,sandbox-crossings,sandbox-no-chain-writes,mode-coverage}.test.ts` | Deleted whole (Task 1) |
| `packages/core/test/modes.test.ts` | Deleted whole (Task 2) |
| `docs/api/guides/issue-a-credential.md` | Sandbox section removed (Task 1) |
| `apps/web/src/components/{tokenization/Dashboard,identity/IdentityDashboard,shared/PlatformHome,identity/IdentityHome,tokenization/AssetManagement,identity/CredentialCard,shared/Organizations}.tsx` | Sandbox checkboxes/pills/banners removed (Task 3) |
| `apps/web/src/components/{tokenization/UseCaseBuilder,identity/CredentialUseCaseBuilder,identity/ProvisionFromTemplate,tokenization/InvoiceRegister,identity/PublicVerify,shared/Developers,shared/ApiReference,shared/Webhooks}.tsx`, `apps/web/src/lib/identity/public-verify.ts` | Sandbox toggles/copy/filters removed (Task 4) |
| `apps/web/src/lib/shared/modes.ts` | Deleted whole (Task 4) |
| `apps/web/src/types.ts`, `apps/web/src/api.ts` | Drop `sandbox`/`mode` fields from client-side mirrors (Task 4) |
| `apps/web/test/modes-view.test.ts` | Deleted whole (Task 4) |
| `apps/api/prisma/schema.prisma` | Five columns dropped via migration (Task 5, last) |

---

## Task 1: Backend — remove every mode/sandbox USAGE from the route layer

**Files:**
- Modify: `apps/api/src/http/routes/context.ts` — delete the `modeGate` closure and its read-side companion (search `function modeGate`, `modeFilter`), and the two-clone-to-live refusal block at lines ~204-218.
- Modify: `apps/api/src/http/routes/shared.ts` — delete `sandboxChainsRefused`/`sandboxImmutable`/`modeGateByKey` wherever defined in this file, and every call site of any of the five gate functions across it.
- Modify: `apps/api/src/http/routes/tokenization.ts` — delete `POST /use-cases/:key/clone-to-live` (around line 312) and every gate call site. Remove the `?includeSandbox=` query handling from the invoice-register/analytics list routes in this file.
- Modify: `apps/api/src/http/routes/identity.ts` — delete `POST /credential-use-cases/:key/clone-to-live` (around line 408) and every gate call site.
- Modify: `apps/api/src/http/routes/common.ts`, `apps/api/src/http/routes/index.ts` — remove any import/re-export of the gate functions or error codes that becomes unused once the above land.
- Modify: `apps/api/src/http/schemas/shared.ts`, `apps/api/src/http/schemas/tokenization.ts`, `apps/api/src/http/schemas/identity.ts`, `apps/api/src/http/schemas/components.ts` — remove `sandbox`/`mode` properties from every request/response schema, and the two `cloneUseCaseToLive`/`cloneCredentialUseCaseToLive` schema objects.
- Modify: `apps/api/src/shared/api-keys.ts` — see the dedicated step below; this file has real logic depth, not just call-site removal.
- Modify: `apps/api/src/webhooks/matching.ts:47` — delete the line `if (ep.mode !== ev.mode) return false;`.
- Modify: `apps/api/src/webhooks/dispatcher.ts:281` — remove `mode: event.mode,` from whatever object literal it sits in (read the surrounding 10 lines first; it is very likely one field of a larger payload object and only that one field goes).
- Modify: `docs/api/guides/issue-a-credential.md` — delete the sandbox section (currently lines ~213-225: "To rehearse all of this against a sandbox..." through the `SANDBOX_NOT_ON_TEMPLATE` mention). Read the file first; line numbers may have drifted.
- Delete: `apps/api/test/sandbox-mode.test.ts`
- Delete: `apps/api/test/sandbox-crossings.test.ts`
- Delete: `apps/api/test/sandbox-no-chain-writes.test.ts`
- Delete: `apps/api/test/mode-coverage.test.ts`

**Interfaces:**
- Consumes: nothing from a later task — this is the first task.
- Produces: a route layer with zero calls to any mode-gating function. `packages/core/src/shared/modes.ts` and `apps/api/src/shared/sandbox.ts` still EXIST after this task (Task 2 deletes them) but nothing in `apps/api/src/http` imports from them anymore. The Prisma schema still has all five columns (Task 5 drops them) — that is fine, an unread column breaks nothing.

- [ ] **Step 1: Establish the starting inventory**

Before touching anything, run this and save the output — it is the checklist this task is not done until it satisfies:

```bash
grep -rn "sandbox\|Sandbox" apps/api/src/http --include='*.ts' | wc -l
grep -rn "modeGate\|modeFilter\|sandboxChainsRefused\|sandboxImmutable\|modeGateByKey\|WRONG_MODE\|SANDBOX_IMMUTABLE\|SANDBOX_NOT_CLONEABLE\|NOT_SANDBOX\|SANDBOX_NOT_ON_TEMPLATE\|SANDBOX_MISPLACED\|INVALID_SANDBOX_CHAINS\|clone-to-live" apps/api/src --include='*.ts' | wc -l
```

Both numbers are non-zero right now. This task's exit condition is BOTH commands returning **zero** lines (after step 8 you re-run these exact commands).

- [ ] **Step 2: Read the two gate-definition sites in full before deleting anything**

```bash
sed -n '1,260p' apps/api/src/http/routes/context.ts
grep -n "function modeGate\|function sandboxChainsRefused\|function sandboxImmutable\|function modeFilter\|function modeGateByKey\|=>.*sandbox\|=>.*Sandbox" apps/api/src/http/routes/shared.ts
```

Note every call site each one has (you will need to touch each caller, not just the definition) — grep for the bare function name across `apps/api/src/http` to find them all, e.g. `grep -rn "modeGate(" apps/api/src/http`.

- [ ] **Step 3: Remove the route-layer call sites and definitions**

For each of `modeGate`, `modeFilter`, `sandboxChainsRefused`, `sandboxImmutable`, `modeGateByKey`:
1. Delete every call site. A call site that gated a route (`if (modeGate(request, reply, useCase)) return;`-shaped) — delete the whole `if` block; the route now runs unconditionally for that check. A call site that FILTERED a list (`modeFilter`-shaped, the "read-side companion") — delete the filter step; the list now returns everything, which is correct since dashboards no longer distinguish sandbox from live.
2. Delete the function definition itself once it has zero remaining callers.

Delete the two `clone-to-live` routes in full — the route handler, and (next step) their schemas. Delete the refusal block in `context.ts` that points at them (the one whose message says "use clone-to-live to create a live copy of a sandbox use case").

- [ ] **Step 4: Remove the error codes and the schemas that reference them**

```bash
grep -rln "WRONG_MODE\|SANDBOX_IMMUTABLE\|SANDBOX_NOT_CLONEABLE\|NOT_SANDBOX\|SANDBOX_NOT_ON_TEMPLATE\|SANDBOX_MISPLACED\|INVALID_SANDBOX_CHAINS" apps/api/src
```

For each file this lists, remove the `reply.code(...).send({ error: "THE_CODE", ... })` blocks (these should already be gone if they were inside a gate function deleted in Step 3 — this command is here to catch any that were NOT inside one of those functions, e.g. inline in a route body). Remove the corresponding error-response schema entries in `apps/api/src/http/schemas/*.ts` (search each code as a string literal in those files too).

Remove `sandbox`/`mode` properties from every schema object in `apps/api/src/http/schemas/{shared,tokenization,identity,components}.ts` — read each file's `grep -n "sandbox\|mode" <file>` output and remove each matched property line (leave properties that are unrelated, e.g. `paymentMode` or similar false positives — read the surrounding context, do not blind-delete every line a bare grep matches).

- [ ] **Step 5: Collapse `api-keys.ts` from mode-aware to a single fixed prefix**

Read the whole file first: `apps/api/src/shared/api-keys.ts` is small and has real logic, not just call sites. Specifically:

```ts
export const KEY_PREFIX_MARKERS: Record<ResourceMode, string> = {
  live: "tl_live_",
  test: "tl_test_",
};
export const KEY_PREFIX_MARKER = KEY_PREFIX_MARKERS.live;
```

becomes one constant:

```ts
/** Every key carries this prefix — there is only one kind of key now. */
export const KEY_PREFIX_MARKER = "tl_live_";
```

Find the reverse lookup this file builds ("Marker → the mode it claims. Built from the map so it cannot fall behind it.") and delete it along with whatever consumes it — search `grep -rn "KEY_PREFIX_MARKERS\|MARKER_MODES\|claimedMode" apps/api/src` (the exact reverse-map name may differ; read the file to find its real name) for every caller.

`mintSecret(rounds: number, mode: ResourceMode = "live")` loses its `mode` parameter entirely:

```ts
export async function mintSecret(rounds: number): Promise<MintedSecret> {
  // ... unchanged body, but every reference to `mode` inside it now reads
  // KEY_PREFIX_MARKER directly instead of KEY_PREFIX_MARKERS[mode]
}
```

Update every CALLER of `mintSecret` to drop the second argument — `grep -rn "mintSecret(" apps/api/src` and fix each.

Find and remove whatever reads a raw credential's claimed mode and TRUSTS/verifies it against a resource's mode (comment context: "What a raw credential's marker claims... Not yet trusted: the caller must check it") — this verification step existed only to enforce `modeAllows`, which Task 2 deletes; remove the check here now so nothing in this file references `ResourceMode` by the end of this task. `ResourceMode` itself is still exported from `packages/core` until Task 2 — importing it one more time here is fine for now if you have not finished removing every reference; just make sure NOTHING calls `modeAllows` from this file.

- [ ] **Step 6: The two non-route-layer edits**

`apps/api/src/webhooks/matching.ts:47` — delete `if (ep.mode !== ev.mode) return false;` in full (it is a single guard clause inside a larger matching function; delete just that line).

`apps/api/src/webhooks/dispatcher.ts:281` — read lines 270-295 first. `mode: event.mode,` is one field inside a larger object literal (almost certainly the payload sent to an endpoint, or a row being persisted) — delete only that one field/line, not the surrounding object.

`docs/api/guides/issue-a-credential.md` — read the file, find the sandbox section (search for the string "rehearse all of this against a sandbox"), delete that whole section through to where the next unrelated section begins.

**Do NOT touch `docs/api/CHANGELOG.md`.** It also mentions sandbox extensively, but deliberately stays untouched — it is a historical record of what was true in each past release, not current-state documentation. If you grep `docs/` for "sandbox" while working this step, you will find it; leave it exactly as it is.

- [ ] **Step 7: Delete the four dedicated test files**

```bash
rm apps/api/test/sandbox-mode.test.ts apps/api/test/sandbox-crossings.test.ts apps/api/test/sandbox-no-chain-writes.test.ts apps/api/test/mode-coverage.test.ts
```

If any OTHER still-existing test file constructs a fixture object that sets `sandbox: false` or `mode: "live"` explicitly (not testing the mode feature itself, just including the field because it used to be required), remove that one field from the fixture literal. Do not touch that test's assertions. Find these with:

```bash
grep -rln "sandbox: false\|sandbox: true\|mode: \"live\"\|mode: \"test\"" apps/api/test --include='*.ts'
```

- [ ] **Step 8: Verify — this task is not done until BOTH commands from Step 1 return zero**

```bash
grep -rn "sandbox\|Sandbox" apps/api/src/http --include='*.ts' | wc -l
grep -rn "modeGate\|modeFilter\|sandboxChainsRefused\|sandboxImmutable\|modeGateByKey\|WRONG_MODE\|SANDBOX_IMMUTABLE\|SANDBOX_NOT_CLONEABLE\|NOT_SANDBOX\|SANDBOX_NOT_ON_TEMPLATE\|SANDBOX_MISPLACED\|INVALID_SANDBOX_CHAINS\|clone-to-live" apps/api/src --include='*.ts' | wc -l
```

Both must print `0`. If either does not, go back — you missed a call site or a schema property.

- [ ] **Step 9: Compile and test**

```bash
npx tsc --noEmit -p apps/api
npx vitest run apps/api --testTimeout=45000 --hookTimeout=45000
```

Expected: `tsc` clean. Full suite passes minus the 4 files you deleted (the count will be lower than the pre-task baseline by exactly the number of tests those 4 files held — note the before/after numbers in your report). `packages/core/src/shared/modes.ts` and `apps/api/src/shared/sandbox.ts` are unused-but-present and cause no compile error (an unimported file is not a TypeScript error).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/http apps/api/src/shared/api-keys.ts apps/api/src/webhooks/matching.ts apps/api/src/webhooks/dispatcher.ts apps/api/test docs/api/guides/issue-a-credential.md
git commit -m "refactor(mode): remove every sandbox/mode usage from the route layer"
```

---

## Task 2: Backend — delete the now-dead definitions

**Files:**
- Delete: `apps/api/src/shared/sandbox.ts`
- Delete: `packages/core/src/shared/modes.ts`
- Modify: `packages/core/src/index.ts` — remove the re-export line for `SANDBOX_CHAIN_ID, modeAllows, sandboxChainsValid, type ResourceMode` (or whatever the exact exported names are — `grep -n "modes.js\|ResourceMode\|SANDBOX_CHAIN_ID" packages/core/src/index.ts` to find the exact line).
- Modify: `config/chains.json` — remove the `{ "id": "sandbox", ... }` entry.
- Modify: `apps/api/src/shared/chains.ts` — remove the `SANDBOX_CHAIN_ID` special-case branch (search `SANDBOX_CHAIN_ID` in this file; it is described in the spec as an unconditional-simulated special case around where chain configs are read).
- Delete: `packages/core/test/modes.test.ts`

**Interfaces:**
- Consumes: Task 1's completed state (zero usages anywhere in `apps/api/src/http`).
- Produces: `packages/core` exports nothing named `ResourceMode`/`modeAllows`/`SANDBOX_CHAIN_ID`/`sandboxChainsValid`; `config/chains.json` has exactly the chains that remain real chain choices (besu, mst, fabric, canton — confirm the exact remaining list by reading the file before and after).

- [ ] **Step 1: Confirm nothing outside these files still references what you're about to delete**

```bash
grep -rln "ResourceMode\|modeAllows\|SANDBOX_CHAIN_ID\|sandboxChainsValid\|isSandboxUseCase\|isSandboxCredential\|writableRegistry" apps/api/src packages/core/src apps/web/src --include='*.ts' --include='*.tsx'
```

Expected right now: only `apps/api/src/shared/sandbox.ts`, `packages/core/src/shared/modes.ts`, `packages/core/src/index.ts`, `apps/api/src/shared/chains.ts`, and possibly `apps/web/src/lib/shared/modes.ts` (that one is Task 4's, not this task's — if it shows up here, leave it; you are not touching `apps/web` in this task). If ANYTHING else shows up, Task 1 missed a call site — go fix that first, in Task 1's files, before proceeding.

- [ ] **Step 2: Delete the two backend definition files**

```bash
rm apps/api/src/shared/sandbox.ts
rm packages/core/src/shared/modes.ts
```

- [ ] **Step 3: Fix the re-export and the chain registry**

In `packages/core/src/index.ts`, remove the line re-exporting from `./shared/modes.js`.

In `apps/api/src/shared/chains.ts`, find and remove the `SANDBOX_CHAIN_ID` special-case branch — read the surrounding function first (`grep -n "SANDBOX_CHAIN_ID" apps/api/src/shared/chains.ts` to find it, then read 15 lines of context above and below before deciding exactly what to delete, since this sits inside a larger loop/switch building the chain registry from `config/chains.json`).

In `config/chains.json`, remove the `{ "id": "sandbox", "label": "Sandbox (simulated)", "family": "mock", "kind": "simulated" }` entry (read the file first to confirm the exact current entry — do not guess at trailing commas; fix the JSON so it stays valid after removal).

- [ ] **Step 4: Delete the core test file**

```bash
rm packages/core/test/modes.test.ts
```

- [ ] **Step 5: Verify — zero remaining references**

```bash
grep -rln "ResourceMode\|modeAllows\|SANDBOX_CHAIN_ID\|sandboxChainsValid" apps/api/src packages/core/src --include='*.ts'
```

Must print nothing (empty output, no file names).

- [ ] **Step 6: Compile and test**

```bash
npx tsc --noEmit -p apps/api
npx tsc --noEmit -p packages/core
npx vitest run apps/api packages/core --testTimeout=45000 --hookTimeout=45000
```

Expected: both `tsc` runs clean, both suites green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/shared packages/core/src config/chains.json packages/core/test
git commit -m "refactor(mode): delete the sandbox chain and mode helpers, backend side"
```

---

## Task 3: Frontend — remove the sandbox UI from the two dashboards and the home/card surfaces

**Files:**
- Modify: `apps/web/src/components/tokenization/Dashboard.tsx` — remove the "Include sandbox" checkbox and the `SANDBOX_EXCLUDED_NOTE` copy block.
- Modify: `apps/web/src/components/identity/IdentityDashboard.tsx` — remove the identical checkbox and copy block.
- Modify: `apps/web/src/components/shared/PlatformHome.tsx` — remove the sandbox-count banner and the amber "Sandbox" pill on use-case cards.
- Modify: `apps/web/src/components/identity/IdentityHome.tsx` — remove the equivalent amber "Sandbox" pill treatment on credential-use-case cards.
- Modify: `apps/web/src/components/tokenization/AssetManagement.tsx` — remove the sandbox banner + `SANDBOX_LEDGER_NOTE` on an asset's detail page.
- Modify: `apps/web/src/components/identity/CredentialCard.tsx` — remove the "sandbox · not anchored" pill.
- Modify: `apps/web/src/components/shared/Organizations.tsx` — remove the equivalent pill (`grep -n "sandbox" apps/web/src/components/shared/Organizations.tsx` — one hit was previously found around line 720).

**Interfaces:**
- Consumes: nothing from Task 1/2 directly — this is frontend TypeScript that does not import backend files. Independent of backend removal for compilation purposes, but logically depends on the spec's completed backend removal for the FEATURE to make sense end to end.
- Produces: neither dashboard offers a sandbox filter; no card anywhere carries a "Sandbox" pill or banner. `apps/web/src/lib/shared/modes.ts` (still imported by these files, still exists) is Task 4's to delete — this task only stops CALLING it from these seven files.

- [ ] **Step 1: Read each file's sandbox usage before editing**

```bash
for f in apps/web/src/components/tokenization/Dashboard.tsx apps/web/src/components/identity/IdentityDashboard.tsx apps/web/src/components/shared/PlatformHome.tsx apps/web/src/components/identity/IdentityHome.tsx apps/web/src/components/tokenization/AssetManagement.tsx apps/web/src/components/identity/CredentialCard.tsx apps/web/src/components/shared/Organizations.tsx; do
  echo "=== $f ==="
  grep -n "sandbox\|Sandbox" "$f"
done
```

Read each matched line in its surrounding JSX context (open the file, do not edit from the grep output alone) before removing anything — a checkbox's `onChange` handler, its bound state variable, and its label text are usually three separate lines that must all go together, or the file will not compile (an unused state setter is fine; a JSX reference to a now-deleted variable is not).

- [ ] **Step 2: Remove the two dashboard toggles**

In `Dashboard.tsx` and `IdentityDashboard.tsx`: delete the checkbox `<input type="checkbox">` (or equivalent toggle component) bound to "include sandbox" state, its label, and the `SANDBOX_EXCLUDED_NOTE`-driven paragraph. Delete the `includeSandbox` state variable and any filter logic gated on it in the same file (the dashboard's stat computation should now always include everything — remove the conditional, not just the toggle that set it, or the dashboard will silently stay in whatever the toggle's default was).

- [ ] **Step 3: Remove the banners and pills**

In `PlatformHome.tsx`, `IdentityHome.tsx`, `AssetManagement.tsx`, `CredentialCard.tsx`, `Organizations.tsx`: delete each sandbox-conditional pill/banner element (`{item.sandbox && <span>...Sandbox...</span>}`-shaped, or similar). Where the surrounding conditional was ONLY there to gate the sandbox pill, remove the whole conditional block, not just its contents.

- [ ] **Step 4: Verify no stray reference remains in these seven files**

```bash
for f in apps/web/src/components/tokenization/Dashboard.tsx apps/web/src/components/identity/IdentityDashboard.tsx apps/web/src/components/shared/PlatformHome.tsx apps/web/src/components/identity/IdentityHome.tsx apps/web/src/components/tokenization/AssetManagement.tsx apps/web/src/components/identity/CredentialCard.tsx apps/web/src/components/shared/Organizations.tsx; do
  n=$(grep -c "sandbox\|Sandbox" "$f")
  echo "$f: $n"
done
```

Every count must be `0`. (`apps/web/src/lib/shared/modes.ts` may still be imported by these files at this point if you have not yet touched its usage — if any of these seven files still imports something from it, that import itself will show up in this grep as containing the word if the import path or a type name has "mode" in a way that matches — re-read carefully; the grep is for "sandbox"/"Sandbox" specifically, which a bare `import { ... } from "../../lib/shared/modes.js"` will not match unless it imports something sandbox-named. If it does, that specific symbol usage needs removing too.)

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit -p apps/web
```

Expected: clean. (`apps/web`'s test suite has no DOM environment configured on this machine — do not attempt to run component tests for these files; `tsc` plus the live browser check in the final task is the verification path here.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/tokenization/Dashboard.tsx apps/web/src/components/identity/IdentityDashboard.tsx apps/web/src/components/shared/PlatformHome.tsx apps/web/src/components/identity/IdentityHome.tsx apps/web/src/components/tokenization/AssetManagement.tsx apps/web/src/components/identity/CredentialCard.tsx apps/web/src/components/shared/Organizations.tsx
git commit -m "refactor(mode): remove sandbox UI from both dashboards and the home/card surfaces"
```

---

## Task 4: Frontend — remove the remaining sandbox UI, the shared lib, and the type mirrors

**Files:**
- Modify: `apps/web/src/components/tokenization/UseCaseBuilder.tsx` — remove the sandbox toggle and the chain-restriction logic (`chainChoicesFor` usage) at use-case creation.
- Modify: `apps/web/src/components/identity/CredentialUseCaseBuilder.tsx`, `apps/web/src/components/identity/ProvisionFromTemplate.tsx` — same, identity-domain twin.
- Modify: `apps/web/src/components/tokenization/InvoiceRegister.tsx` — remove its `includeSandbox`/sandbox-filter usage.
- Modify: `apps/web/src/components/identity/PublicVerify.tsx`, `apps/web/src/lib/identity/public-verify.ts` — remove the "sandbox, unanchored" verification-result messaging.
- Modify: `apps/web/src/components/shared/Developers.tsx`, `apps/web/src/components/shared/ApiReference.tsx`, `apps/web/src/components/shared/Webhooks.tsx` — remove the docs/copy explaining the `tl_test_`/`tl_live_` split and endpoint mode.
- Modify: `apps/web/src/types.ts`, `apps/web/src/api.ts` — remove `sandbox`/`mode` fields from the client-side type mirrors and API call signatures.
- Delete: `apps/web/src/lib/shared/modes.ts`
- Delete: `apps/web/test/modes-view.test.ts`

**Interfaces:**
- Consumes: Task 3's completed state (the seven files there no longer call into `lib/shared/modes.ts`'s sandbox-specific exports) — confirm this at Step 1 before deleting the lib file, or you will break Task 3's files.
- Produces: `apps/web/src/lib/shared/` contains no `modes.ts`; no file anywhere under `apps/web/src` imports from it (the import path itself must be gone, not just unused).

- [ ] **Step 1: Confirm Task 3's files are clean, then find every remaining importer of the lib file**

```bash
grep -rln "lib/shared/modes" apps/web/src --include='*.ts' --include='*.tsx'
```

This must list ONLY the files named in this task's Files section above (plus possibly the file itself if it imports its own siblings — check). If any file from Task 3 appears here, stop and finish removing its usage first — Task 3's exit condition implicitly required this too.

- [ ] **Step 2: Read `lib/shared/modes.ts` in full, and read each of its listed importers**

```bash
cat apps/web/src/lib/shared/modes.ts
```

Note every exported name (`MODE_LABELS`, `chainChoicesFor`, `checkUseCaseDraft`, `SANDBOX_LEDGER_NOTE`, `SANDBOX_EXCLUDED_NOTE`, `SANDBOX_IMMUTABLE_NOTE`, and any others actually present — read the real file, this list is from the spec's survey and may not be exhaustive). For each importer, `grep -n "modes.js" <file>` to see exactly which of these names it pulls in, then read that usage in context before removing it.

- [ ] **Step 3: Remove usage from the use-case builders**

In `UseCaseBuilder.tsx`, `CredentialUseCaseBuilder.tsx`, `ProvisionFromTemplate.tsx`: remove the sandbox on/off toggle control, its bound state, and the `chainChoicesFor(sandbox, ...)`-style call — replace any such call with the plain, unrestricted chain list the file already has available (read the file to find where the FULL chain list is sourced from before the sandbox-conditional narrowing was applied; use that directly). Remove `checkUseCaseDraft`'s sandbox-branch validation call if this file invoked it specifically for that purpose (read to confirm — if the function does other, still-needed validation too, keep the call and remove only its sandbox-specific internals, which happens naturally once `checkUseCaseDraft` itself is edited or removed in Step 2's file — do not duplicate logic here).

- [ ] **Step 4: Remove usage from the remaining five files**

`InvoiceRegister.tsx` — remove the `includeSandbox` toggle/filter, mirroring Task 3 Step 2's dashboard pattern.

`PublicVerify.tsx` / `public-verify.ts` — remove the "sandbox, unanchored" result-messaging branch; a verification result now always reports the same anchored/unanchored logic without a sandbox-specific case.

`Developers.tsx`, `ApiReference.tsx`, `Webhooks.tsx` — remove the prose/example blocks explaining `tl_test_` vs `tl_live_` and endpoint mode. These are documentation/copy edits inside JSX — read each file's matched lines in context and remove the paragraph/section they belong to, not just the matched line.

- [ ] **Step 5: Remove the type mirrors**

```bash
grep -n "sandbox\|mode" apps/web/src/types.ts apps/web/src/api.ts
```

Remove each matched `sandbox`/`mode` field from interface/type definitions in `types.ts`, and each matched parameter/property from call signatures in `api.ts`. Read enough surrounding context to distinguish a real match from a false positive (e.g. a field literally named `mode` for something unrelated, or a substring hit inside an unrelated word) before deleting.

- [ ] **Step 6: Delete the lib file and its test**

```bash
rm apps/web/src/lib/shared/modes.ts
rm apps/web/test/modes-view.test.ts
```

- [ ] **Step 7: Verify — zero remaining references anywhere in `apps/web/src`**

```bash
grep -rn "sandbox\|Sandbox" apps/web/src --include='*.ts' --include='*.tsx' | wc -l
grep -rln "lib/shared/modes" apps/web/src --include='*.ts' --include='*.tsx'
```

The count must be `0`; the second command must list nothing.

- [ ] **Step 8: Type-check**

```bash
npx tsc --noEmit -p apps/web
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "refactor(mode): remove the remaining sandbox UI, the shared lib, and type mirrors"
```

---

## Task 5: Drop the schema columns, and full-system verification

**Files:**
- Modify: `apps/api/prisma/schema.prisma` — remove `sandbox Boolean @default(false)` from `UseCase` (and its `EN-D2` comment) and from `CredentialUseCase`; remove `mode String @default("live")` from `ApiKey`, `Event`, and `WebhookEndpoint` (and the "never updated in place" comment on the last one, which no longer applies to anything).
- Create: a Prisma migration (via `prisma migrate dev`, not hand-written SQL).

**Interfaces:**
- Consumes: Tasks 1-4's completed state — by this point NOTHING in `apps/api/src` or `apps/web/src` reads or writes any of these five columns, which is what makes dropping them safe to do last rather than first.
- Produces: a schema with no mode/sandbox columns anywhere, matching the code that has already stopped referencing them.

- [ ] **Step 1: Confirm, one more time, that nothing references these fields before dropping them**

```bash
grep -rn "\.sandbox\b" apps/api/src --include='*.ts'
grep -rn "\.mode\b" apps/api/src/persistence --include='*.ts'
```

The first must be empty. The second should show nothing related to `ApiKey`/`Event`/`WebhookEndpoint` mode (it may show unrelated hits if any other model has an unrelated `.mode` field — read each hit; only act if it is genuinely one of these three models' removed field still being referenced, which at this point should not exist).

- [ ] **Step 2: Edit the schema**

Read `apps/api/prisma/schema.prisma` in full first. Remove:
- `UseCase.sandbox` and its preceding `EN-D2` comment lines.
- `CredentialUseCase.sandbox` and its preceding comment.
- `ApiKey.mode` and its preceding comment.
- `Event.mode`.
- `WebhookEndpoint.mode` and its preceding "never updated in place" comment.

- [ ] **Step 3: Generate the migration**

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI/apps/api"
npx prisma migrate dev --name remove_sandbox_mode
```

Expected: Prisma reports the migration as applied cleanly against the local dev database, with no data-loss warning beyond "these columns will be dropped" (there is no data in them to lose — verified at the start of this whole plan).

- [ ] **Step 4: Regenerate the client and compile**

```bash
pnpm --filter @tokenlayer/api exec prisma generate
npx tsc --noEmit -p apps/api
```

Expected: clean. If `tsc` now reports an error somewhere, an earlier task missed a reference — go fix it in that task's files, not here.

- [ ] **Step 5: Full local suite, every touched package**

```bash
npx vitest run apps/api packages/core apps/web --testTimeout=45000 --hookTimeout=45000
```

Report the exact file/test counts. Expect them below the pre-plan baseline by exactly the number of tests in the six deleted test files (`sandbox-mode`, `sandbox-crossings`, `sandbox-no-chain-writes`, `mode-coverage`, `packages/core/test/modes.test.ts`, `apps/web/test/modes-view.test.ts`) — note the baseline-vs-final numbers explicitly in your report so the controller can verify the arithmetic.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma
git commit -m "feat(mode): drop the sandbox/mode columns — the feature is fully removed"
```

- [ ] **Step 7: Live rebuild and verification — do this whether you are the implementer or the controller re-verifying**

Rebuild the combined stack and both split stacks so the running deployments pick up every change from all five tasks:

```bash
cd "/Users/kamleshnagware/Tokenlayer XPI"
./scripts/deploy.sh
bash scripts/stack-up.sh identity tokenization
```

Then confirm the schema migration actually applied inside the rebuilt containers (a fresh `prisma db push`/migrate runs as part of each container's boot, per the Dockerfile CMD) — log in and load both dashboards, and confirm neither shows an "Include sandbox" control:

```bash
node -e '
(async()=>{
  const API="http://localhost:4000/api/v1";
  const r=await fetch(API+"/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"admin@tokenlayer.dev",password:"admin123"})});
  const t=(await r.json()).token;
  const uc=await fetch(API+"/use-cases",{headers:{authorization:"Bearer "+t}});
  console.log("GET /use-cases status:", uc.status);
  const body=await uc.text();
  console.log("response mentions sandbox?", /sandbox/i.test(body));
})()'
```

Expected: `200`, and `false` for the sandbox mention. Then run the full 20-script e2e sweep exactly as done for the ledger-truth branch (18 combined-stack scripts + `personas-e2e.mjs` + `seam-e2e.mjs` on the split topology) to confirm nothing that depended on mode gating silently broke.
