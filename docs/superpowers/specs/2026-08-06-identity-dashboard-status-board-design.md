# Identity Dashboard + Credential Status Board (ID-N) — Design

**Goal:** Give identity-domain operators a TalentPass-style at-a-glance operations view: stat tiles (issued / pending acceptance / accepted / changes requested / rejected / revoked / expired), an issued-per-day activity strip, a filterable **credential status board** (who holds what, in which lifecycle state), and a verification-activity summary — all scoped to what the caller actually runs. Third sub-project of the TalentPass/Sethu gap program (ID-L..O).

**Program context:** The TalentPass issuer video opens on a dashboard: stat cards over the issued population and a status table per credential with holder, type, date, and state. Our platform now *produces* all of those states — ID-L added the acceptance lifecycle, ID-M mass-produces credentials in batches — but there is no place to *see* them in aggregate: an issuer desk today infers its portfolio from the Approvals inbox and individual card pills. Everything needed is already persisted (`Credential.acceptance/revoked/expiresAt/credentialUseCaseKey`, `VerificationRequest.status`); ID-N is a pure read model. Tx-hash surfacing and per-verification detail are explicitly **ID-O**, not here.

**Tech stack:** apps/api (a pure `identity-analytics.ts` fold + one authed route + two repo `list()` methods) + apps/web (an `IdentityDashboard` view wired into the identity domain nav). **No core change. No new dependency. No new writes** — read-only aggregation, mirroring the tokenization `analytics.ts` precedent (pure, injectable `now`, no I/O).

---

## Scoping model (who sees which slice)

Resolved in the route, before any data is loaded:

- **PlatformAdmin** — every credential use case.
- **OrgAdmin** — the credential use cases whose configured issuer is their org (`issuer.kind === "org" && issuer.orgId === claims.orgId`). This matches the issuing authority they exercise via `resolveIssuer`.
- **Scoped identity desk** (`UseCaseAdmin` or `Issuer` whose `claims.useCaseKey` is a credential use case) — exactly their one use case.
- **Everyone else** (Holder, Verifier, tokenization desks, Trader/Buyer/Auditor) — **403**. Holders already have MyIdentity (their own credentials with acceptance strips); a holder-facing dashboard is out of scope. A scope that resolves to zero use cases (e.g. an OrgAdmin whose org issues nothing) gets an empty dashboard, not an error.

Only credentials with a `credentialUseCaseKey` inside the scope are counted. Catalog credentials (KYB OrganizationCredential, onboarding KYC, membership — `credentialUseCaseKey: null`) are invisible here even to PlatformAdmin: this is the *use-case operations* dashboard, and mixing the platform's internal identity plumbing into it would make every tile lie.

## The aggregation — pure `computeIdentityDashboard(input)`

New `apps/api/src/identity-analytics.ts`, same contract as `analytics.ts`: takes already-loaded, already-scope-filtered data, no I/O, deterministic under an injected `now`.

**Input:** `{ useCases, credentials, verifications, holderLabels, now, days }` where `useCases` is the scoped slice of `CredentialUseCaseDefinition`s, `credentials`/`verifications` are pre-filtered to those keys, `holderLabels` is a `Map<holderDid, string>` built by the route (user email, else org name, else truncated DID), `days` = 30.

**Derived per-credential status** (one pill per credential, precedence documented and tested):
`revoked` → else `expiresAt < now` ⇒ `expired` → else the ID-L `acceptance` value (`pending` | `changes_requested` | `rejected` | `accepted`). This matches the public `/status` endpoint's semantics — the dashboard must never disagree with the credential's own status page.

**Output:**
- `totals` — `{ issued, accepted, pendingAcceptance, changesRequested, rejectedByHolder, revoked, expired }` (`issued` = row count; the other six partition it by the derived status).
- `byUseCase[]` — per use case: `key`, `name`, per-credential-type rows with the same seven counts.
- `board[]` — the status board rows, **newest first, capped at 200**, with `boardTotal` carrying the uncapped count: `{ credentialId, useCaseKey, useCaseName, type, holderDid, holderLabel, issuedAt, expiresAt, status, acceptanceNote }` (`acceptanceNote` only when status is `changes_requested` — the TalentPass table shows the reason inline).
- `activity[]` — last 30 UTC days, `{ date, issued }` per day (drives the mini bar strip; reuses the same day-bucketing shape as tokenization's `ActivityDay`).
- `verification` — `{ pending, consented, rejected, expired, verifiedValid, verifiedInvalid }` over the scope's verification requests. `consented` requests that have a `verifierResult` split into `verifiedValid`/`verifiedInvalid` by the stored result's `valid` boolean; consented-but-not-yet-verified stays in `consented`.

All counting is plain integer arithmetic over in-memory rows — no BigInt/money machinery needed.

## API

**Repo additions (the parity-critical bit):** `CredentialRepository.list(): Promise<CredentialRecord[]>` and `VerificationRequestRepository.list(): Promise<VerificationRequestRecord[]>` — in `persistence/types.ts` **and BOTH** `memory.ts` and `prisma.ts` in the same task (the ID-L lesson: a memory-only method ships green and fails live). No new columns, no schema migration — these are straight table scans; scope filtering happens in the route. Fine at MVP scale, and centralizing the filter in the route keeps the repos dumb.

**Route:** `GET /identity/dashboard` (authed). Steps: resolve scope (above; 403 outside it) → `credentialUseCases.list()` and slice → `credentials.list()` / `verificationRequests.list()` filtered by scoped keys → build `holderLabels` from `users.list()` + `organizations.list()` → `computeIdentityDashboard` → 200. Response schema is a loose `{ type: "object", additionalProperties: true }` 200 (the fast-json-stringify lesson — nested typed schemas here would silently strip fields). Schema entry `identityDashboard` tagged `Identity`.

## Web

- **Nav:** new item `identity-dashboard` (label "Dashboard", icon "chart" — whatever `ui.tsx`'s icon set already has closest) mapped to `identity` in `NAV_DOMAIN`. Shown to PlatformAdmin and OrgAdmin in the identity domain, and to identity desk UseCaseAdmin/Issuer in the desk branch. The identity domain's `defaultView` stays `identity` (the home) — making the dashboard the landing view per role would complicate the domain registry for no reference-behavior gain; users click one nav item.
- **`IdentityDashboard.tsx`:**
  - Tile row: the seven `totals` (accepted green, pending amber, changes-requested red, rejected/revoked/expired muted — same tone conventions as CredentialCard's pills).
  - Activity strip: 30-day issued-per-day bar chart reusing the existing SVG chart primitives from the tokenization Dashboard.
  - Verification card: the six verification counters.
  - **Status board table:** columns Holder / Credential / Use case / Issued / Expires / Status(+note); client-side filter chips by derived status, a credential-type `<select>`, and a text search over holder label — all filtering the returned (≤200) rows. A "showing newest 200 of N" line when capped. Row status pills match the tile colors.
  - By-use-case section: collapsible per-use-case type breakdown (PlatformAdmin/OrgAdmin see several; a desk sees one, pre-expanded).
- `api.identityDashboard()` client method + response types in `types.ts`.

## Error handling

- Scope resolution failures are 403 `FORBIDDEN`; an empty scope returns a zeroed dashboard (empty arrays, zero tiles) — the UI renders an empty state, not an error.
- `holderLabels` misses (a DID with no current user/org — e.g. deactivated user) fall back to the truncated DID; the fold never throws on unresolvable labels.
- The route does **no chain reads** — revocation counts come from the DB flag exactly like list projections do today (`/status`'s chain fallback is for the single-credential public page; a dashboard doing N chain reads would be slow and flaky). This means a chain-revoked-but-DB-missed credential counts as active — accepted skew, same as every existing list view.

## Testing

- **api unit (pure fold):** deterministic `now`; status precedence (revoked beats expired beats pending); partition property (`issued` = sum of the six states); board ordering + 200-cap + `boardTotal`; `changes_requested` note carried; activity day-bucketing across a month boundary; verification split incl. `verifiedValid/Invalid` from stored results.
- **api route:** PlatformAdmin sees all identity use cases but NOT null-key catalog credentials; scoped desk sees only its use case (isolation proven with two use cases); OrgAdmin sees only own-org-issuer use cases; Holder/Verifier/tokenization desk → 403; lifecycle transitions move the counts (issue-pending → accept → revoke, re-fetch between each); holder label resolution (user email + org-held credential's org name).
- **web:** tsc + build; live walkthrough — provision a domicile program (holderAcceptance on), ID-M batch-issue 5, open the dashboard as the desk: 5 pending; accept one, reject one, revoke one → tiles and board pills update; run a verification → verification card increments; PlatformAdmin sees the same use case among all; filter chips + search narrow the board.

## Verification / done

Full core (untouched) + api suites green + web tsc/build + the live Besu walkthrough above, then finish the branch (`feat/identity-dashboard` → main).

## Alternatives considered

- **Client-side aggregation over existing endpoints** — there is no endpoint that lists a scope's credentials at all (only by-holder/by-issuer), so the client would need new endpoints anyway plus N+1 label fetches; a server fold matches the established `analytics.ts` pattern and is unit-testable.
- **Prisma `groupBy` aggregate queries** — faster at large scale, but splits the logic per persistence backend (parity risk, the exact ID-L failure mode) and can't express the derived-status precedence cleanly; the pure fold over `list()` keeps memory/prisma behavior identical by construction.
- **Server-side board pagination/filtering** — deferred; 200 newest + client filters covers the TalentPass reference behavior, and the cap bounds the payload. A `?useCaseKey=` server filter can come later without breaking the response shape.
- **Including catalog (null-key) credentials for PlatformAdmin** — rejected: KYB/onboarding/membership credentials are platform plumbing with different lifecycles; they would distort every tile. The dashboard is per-use-case operations.
