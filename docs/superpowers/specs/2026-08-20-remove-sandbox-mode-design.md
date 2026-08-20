# Remove sandbox/test-live mode — design

**Status:** approved 2026-08-20
**Theme:** delete a feature, completely, rather than leave half of it behind.

## Why

The platform has carried a full test/live duality (internally `ResourceMode`,
labeled "Sandbox" in the UI) since EN-D2: every use case, API key, webhook
endpoint, and event carries a mode; a sandbox use case can only run on a
dedicated mock chain; credentials issued under it are never anchored on-chain.
The user asked for it gone — the whole feature, in both the tokenization and
identity apps, not just the dashboard checkbox that prompted the request.

Verified before writing this down, not assumed: **zero rows** use any
non-default mode value, anywhere. Checked the combined stack's database and
both split-stack databases directly —
`UseCase.sandbox`, `CredentialUseCase.sandbox`, `ApiKey.mode`, `Event.mode`,
`WebhookEndpoint.mode` are at their default in every row, in every deployment.
This is a pure code removal. No data migration decision, no "what happens to
existing sandbox use cases" question — there are none.

## Goals

- No trace of the mode concept left in schema, backend, frontend, or tests.
- Every already-issued API key keeps working, unchanged (`tl_live_` prefix
  format is untouched — there is simply no more second prefix it could have
  been).
- The removal is verified the same way the ledger-truth branch was: full
  suite green, `tsc` clean, a live rebuild and re-test of the running stacks,
  before it ships.

## Non-goals

- Touching *which chains* exist otherwise (fabric/canton/besu/mst stay
  exactly as they are — only the `sandbox` chain entry, whose sole reason to
  exist was hosting sandbox-mode use cases, goes).
- Any change to personas, audience apps, or the split-deployment topology.
- Reissuing or migrating existing API keys. Their stored prefix is historical
  text on an already-created row; nothing rewrites it.

## What comes out, by layer

### 1. Schema (`apps/api/prisma/schema.prisma`)

Drop four columns, in one migration:
- `UseCase.sandbox` (line 116)
- `CredentialUseCase.sandbox` (line 136)
- `ApiKey.mode` (line 58)
- `Event.mode` (line 444)
- `WebhookEndpoint.mode` (line 487)

`prisma migrate dev --name remove_sandbox_mode`, applied to the combined
stack's dev database; the split stacks pick it up on their next
`prisma db push`/migrate at rebuild (same as any other schema change on this
project — no special handling needed since all three databases confirmed
empty of non-default rows).

### 2. Backend (`apps/api/src`, `packages/core/src`)

- Delete `apps/api/src/shared/sandbox.ts` entirely (`writableRegistry`,
  `isSandboxUseCase`, `isSandboxCredential` — all three exist only to serve
  the mode concept).
- Delete `SANDBOX_CHAIN_ID`, `ResourceMode`, `modeAllows`, `sandboxChainsValid`
  from `packages/core/src/shared/modes.ts`; delete the file if nothing else
  remains in it.
- Delete the `sandbox` entry from `config/chains.json`. It was the mode
  feature's dedicated always-simulated chain — with the feature gone it has
  no remaining purpose, and `fabric`/`canton` already cover "always
  simulated" for anyone who wants that independent of mode.
- Delete the inner closures `modeGate` (`context.ts:124`) and its
  read-side companion, plus `sandboxChainsRefused`/`sandboxImmutable`/
  `modeFilter`/`modeGateByKey` wherever each is defined (`context.ts`,
  `shared.ts`) and remove every call site across
  `apps/api/src/http/routes/{shared,tokenization,identity,context,common,index}.ts`.
- Delete the two `clone-to-live` routes and their schemas —
  `POST /use-cases/:key/clone-to-live` (`tokenization.ts:312`) and
  `POST /credential-use-cases/:key/clone-to-live` (`identity.ts:408`) — the
  refusal in `context.ts:204-218` that points at them, and every comment
  referencing "the supported way out of the sandbox."
- Delete the error codes and their schema/route occurrences: `WRONG_MODE`,
  `SANDBOX_IMMUTABLE`, `SANDBOX_NOT_CLONEABLE`, `NOT_SANDBOX`,
  `SANDBOX_NOT_ON_TEMPLATE`, `SANDBOX_MISPLACED`, `INVALID_SANDBOX_CHAINS` —
  present in `identity.ts`, `shared.ts`, `tokenization.ts`,
  `schemas/{identity,shared,tokenization,components}.ts`.
- `ApiKey` generation: remove the `mode` parameter and the `tl_test_`/
  `tl_live_` branch; every key is created with the `tl_live_` prefix — the
  same prefix live keys already carry, so existing verification code needs no
  change to keep validating them.
- `?includeSandbox=` query param removed from the analytics/invoice-register
  routes that currently read it (dashboards always show everything now).

### 3. Frontend (`apps/web/src`)

Full file list, confirmed by direct grep rather than the earlier survey's
approximation:

- `components/tokenization/Dashboard.tsx`, `components/identity/IdentityDashboard.tsx`
  — remove the "Include sandbox" checkbox and its explanatory copy.
- `components/shared/PlatformHome.tsx`, `components/identity/IdentityHome.tsx`
  — remove the sandbox-count banner and the amber "Sandbox" pills on
  use-case/credential-use-case cards.
- `components/tokenization/AssetManagement.tsx`, `components/identity/CredentialCard.tsx`,
  `components/shared/Organizations.tsx` — remove the "sandbox · not anchored"
  pills and banners.
- `components/tokenization/UseCaseBuilder.tsx`, `components/identity/CredentialUseCaseBuilder.tsx`,
  `components/identity/ProvisionFromTemplate.tsx` — remove the sandbox toggle
  and the chain-restriction logic that limits chain choices to `["sandbox"]`
  when it's on.
- `components/tokenization/InvoiceRegister.tsx` — remove its
  `includeSandbox`/sandbox-filter usage.
- `components/identity/PublicVerify.tsx`, `lib/identity/public-verify.ts` —
  remove the "sandbox, unanchored" verification-result messaging (a sandbox
  credential's status source; with anchoring now unconditional this
  distinction disappears).
- `components/shared/Developers.tsx`, `components/shared/ApiReference.tsx`,
  `components/shared/Webhooks.tsx` — remove the docs/copy explaining the
  `tl_test_`/`tl_live_` split and endpoint mode.
- `types.ts`, `api.ts` — remove `sandbox`/`mode` fields from the client-side
  type mirrors and API call signatures.
- `lib/shared/modes.ts` — deleted in full (`MODE_LABELS`, `chainChoicesFor`,
  `checkUseCaseDraft`, `SANDBOX_LEDGER_NOTE`, `SANDBOX_EXCLUDED_NOTE`,
  `SANDBOX_IMMUTABLE_NOTE`); it exists solely to mirror the backend concept.

### 4. Docs

`docs/api/guides/issue-a-credential.md` (served into the web app's developer
docs via `Guides.tsx`'s `?raw` import) has a live section instructing API
users to rehearse against a sandbox with `"sandbox": true`. That section is
deleted — leaving it would actively mislead an integrator into a call that
now 400s. `docs/api/CHANGELOG.md`'s many sandbox mentions are historical
record of past releases and are deliberately left untouched — a changelog
documents what was true when each entry was written, not what is true now.

### 5. Tests

Deleted, because their entire subject is the feature being removed — this is
the one place "never edit an existing test" is deliberately set aside, since
keeping them would mean asserting behavior of code that no longer exists:

- `apps/api/test/sandbox-mode.test.ts`
- `apps/api/test/sandbox-crossings.test.ts`
- `apps/api/test/sandbox-no-chain-writes.test.ts`
- `apps/api/test/mode-coverage.test.ts` — its whole premise ("every route
  resolving a use case must pass through a mode gate or be explicitly
  exempt") is moot once there is no mode gate.
- `packages/core/test/modes.test.ts`
- `apps/web/test/modes-view.test.ts`

Any OTHER existing test that happens to touch a now-deleted field (e.g.
constructs a `UseCase` fixture that sets `sandbox: false`) gets that field
dropped from the fixture, not its assertions changed — that is wiring, not a
behavior edit, the same distinction already established on the ledger-truth
branch.

## Verification plan

Same discipline as ledger-truth: `tsc --noEmit` clean on every touched
package, full `apps/api`/`packages/core`/`apps/web` suites green, then a real
rebuild of the combined stack and both split stacks with the live 5-node Besu
network, re-running the 20-script e2e sweep to confirm nothing that depended
on mode gating silently broke.

## Risk

Low. No data at risk (verified). The main way this could go wrong is missing
a call site — `modeGate`/`sandboxChainsRefused` etc. are threaded through
many route handlers — so the plan will grep for every remaining reference to
`sandbox`/`mode`-as-ResourceMode after each task and treat a stray hit as a
signal the task isn't done, not as an acceptable straggler.
