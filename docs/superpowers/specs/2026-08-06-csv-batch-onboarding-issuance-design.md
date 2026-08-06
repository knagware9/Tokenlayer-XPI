# CSV Batch Onboarding + Batch Issuance (ID-M) — Design

**Goal:** Let an identity desk work at TalentPass scale: upload a **CSV of holders** to onboard many at once, and a **CSV of credentials** (columns derived from the use case's claim schema) to issue many at once — each with a review table before submission, a single maker-checker approval for the whole batch, and a per-row success/failure report ("Total: 8 | Successful: 7 | Failed: 1 — Holder not found"). Second sub-project of the TalentPass/Sethu gap program (ID-L..O).

**Program context:** Today, onboarding (`POST /users` → onboard-user proposal) and issuance (`POST /credential-use-cases/:key/credentials` → issue-usecase-credential proposal) are strictly one-at-a-time, each producing its own proposal. The TalentPass issuer video demonstrates staff CSV-uploading 8 holders and 8 degrees with strict documented schemas, review-before-submit, and per-row failure reporting. The platform already has a client-side CSV pattern (`parseCsv` in InvoiceRegister — the ERP invoice import) and a proposal-kind registry for approvals.

**Tech stack:** apps/api (two batch proposal kinds + two batch routes + per-row report; **no core change** — row validation reuses core's `validateMetadata`/`canCreateUser`/`holderPolicyAllows` exactly as the single-row paths do) + apps/web (two upload→review→submit surfaces reusing the existing `parseCsv`). No new dependency (CSV parsing stays client-side, matching the invoice-import precedent; the API accepts JSON row arrays).

---

## The seam

A batch is **one proposal containing N rows**, not N proposals. This keeps the checker's experience sane (one approval decision per batch, exactly like TalentPass's manager verifying a draft batch), reuses the proposal-kind registry unchanged, and gives a natural home for the per-row report: the executor processes rows independently, never aborts the batch on a row failure, and records `{ index, status, error? }` per row. Rows that fail (holder not found, duplicate email, invalid claims) simply fail — succeeded rows stand, mirroring TalentPass's "Successful: 7 | Failed: 1".

CSV parsing lives in the **web** (the invoice-import precedent): the browser parses + canonicalizes headers, renders the review table, and POSTs a JSON `rows: [...]` array. The API never sees CSV bytes — it validates structured rows, which keeps the routes schema-typed and testable.

## Batch onboarding

**Route:** `POST /users/batch` (auth; same caller policy as `POST /users` — the effective role/use-case gates via `canCreateUser` apply per row against the CALLER, exactly as the single path).

**Body:** `{ rows: [{ email, password, role, useCaseKey?, walletAddress?, kyc? }...] }` — each row the same shape as the single onboarding body. Caps: 1–200 rows.

**Pre-validation (draft time, before the proposal exists):** every row is checked — email format + uniqueness (against the DB AND within the batch), role assignable by the caller for the row's domain, use-case existence. Any invalid row ⇒ **400 with a per-row problems list** (`{ index, error }[]`) and NO proposal — the desk fixes the CSV and re-submits (validation failures are cheap; execution failures are the runtime ones).

**Proposal kind `onboard-user-batch`:** payload = the validated rows (passwords bcrypt-hashed at DRAFT time, like the single path — never plaintext in a stored proposal). `required` = the same approval depth as a single onboarding. On approve, the executor runs each row through the **same code path as the single onboard executor** (DID provisioning, membership VC where applicable) row-independently; a throw marks that row `failed` with the error message and continues. The proposal's stored result carries the full report; the approve response returns it: `{ total, succeeded, failed, rows: [{ index, email, status, error? }] }`.

## Batch issuance

**Route:** `POST /credential-use-cases/:key/credentials/batch` (auth; the same `resolveIssuer` scoped-operator/org gate as the single issuance route).

**Body:** `{ credentialType, rows: [{ subjectEmail, claims }...] }` — one credential **type** per batch (the CSV's columns are that type's claim schema, TalentPass-style). Caps: 1–200 rows.

**Row shape from the schema:** the web derives the CSV template header as `subjectEmail,<claim keys in schema order>` and coerces types from the claim schema (`number`/`boolean` columns parsed, same coercion as the single issue form). The API re-validates every row's claims via `validateMetadata(claims, spec.claimSchema)` at draft time — invalid claims ⇒ 400 per-row problems, no proposal. `subjectEmail` resolution is deliberately **deferred to execution** ("Holder not found" is a runtime failure in TalentPass too — the user may be onboarded between draft and approve).

**Proposal kind `issue-usecase-credential-batch`:** payload = `{ useCaseKey, credentialType, rows }`. `required` = the credential type's `requiredApprovals` (resolved fresh at draft). On approve, the executor re-resolves the use case fresh (never-sign-stale-config), then per row: resolve `subjectEmail` → user with a DID (else `failed: "holder not found"`), check `holderPolicyAllows`, and call the **same `issueCredentialFor`** as the single path — including ID-L's `initialAcceptance` (batch-issued credentials are born pending under `holderAcceptance` use cases, unchanged semantics). Per-row report identical in shape to onboarding's.

**Org subjects:** out of scope for v1 — batch rows target users by email (the TalentPass model); `subjectOrgId` batches can be a later column variant.

## Web

- **Identity desk — "Batch onboard" surface** (entry beside Add User in UserManagement for identity-capable managers, and on the identity desk): file input (`.csv`) → `parseCsv` → header canonicalization (`email,password,role,useCaseKey?,walletAddress?` — documented in an info box exactly like the invoice importer's) → review table with per-row client-side validation flags → **Submit batch** → 202 with the proposal → the Approvals inbox shows one `onboard-user-batch` entry summarized as "Onboard N holders (use case X)". After approval, the desk sees the report (fetch the proposal / response passthrough) rendered TalentPass-style: totals + failed-row list.
- **IssueUsecaseCredential — "Batch issue" mode**: toggle next to the single form; pick credential type → the UI shows the exact expected header (derived live from the claim schema) + a **Download CSV template** link (client-generated) → upload → review table (type-coerced values, invalid cells flagged) → Submit → 202 → approval → report dialog with totals + per-row failures.
- **ApprovalsPanel `summarize()`**: readable arms for both new kinds ("Onboard 8 holders — education-…", "Issue 8 DegreeCredential — …").

## Error handling

- Draft-time validation is all-or-nothing (400 + problems list, no proposal) — a desk never gets a half-valid batch pending.
- Execution is row-independent and never throws the batch: each row's failure is caught into the report; the proposal executes successfully with a report containing failures (matching TalentPass's completed-with-failures dialog). A catastrophic executor error (config vanished) fails the whole proposal via the existing proposal-failure path.
- Passwords: hashed at draft, plaintext never persisted (same rule as provisioning's one-time desk passwords — but here the CSV *supplies* passwords, so nothing needs returning).
- Batch caps (200) enforced at the route schema; empty rows ⇒ 400.
- Duplicate `subjectEmail` rows within an issuance batch are allowed (re-issuance is legitimate); duplicate emails within an onboarding batch are a draft-time 400.

## Testing

- **api (onboarding):** valid batch → 202 one proposal → approve → all users exist with DIDs + report all-succeeded; batch with an in-batch duplicate email → 400 problems, no proposal; batch where one row's email collides with an existing user at EXECUTION time (user created between draft and approve) → report shows that row failed, others succeeded; role-escalation row → draft-time 400; caps.
- **api (issuance):** valid batch under a claim schema → 202 → approve → N credentials held (and born `pending` when the use case has `holderAcceptance`); a row with unknown `subjectEmail` → report `failed: holder not found`, others issued (the TalentPass Divya Nair case); invalid claims row → draft-time 400 problems; `requiredApprovals: 2` type → two approvals needed before execution; scoped-operator gate applies.
- **web:** tsc + build; live walkthrough — batch-onboard 5 holders from a CSV (review table → submit → approve → report), then batch-issue 5 DomicileCredentials where 1 subject doesn't exist → report "Successful: 4 | Failed: 1 — holder not found"; holder logs in and sees their pending credential (ID-L intact).

## Verification / done

Full core (untouched) + api suites green + web tsc/build + the live walkthrough, then finish the branch (`feat/csv-batch` → main).

## Alternatives considered

- **N individual proposals per batch** — floods the checker's inbox and loses the batch report home; one-proposal-per-batch matches both TalentPass and the checker's real decision ("this batch is legit").
- **Server-side CSV parsing (multipart)** — new dependency + content-type surface for zero gain; the client-parse precedent (invoice importer) already works and keeps the API JSON-typed.
- **Abort batch on first row failure at execution** — punishes 199 good rows for one bad one and contradicts the reference behavior; row-independent execution with a report is the TalentPass semantic.
- **Resolve subjects at draft time** — would make the draft stale against onboarding races and diverge from TalentPass (where "Holder not found" is an execution-time failure); claims validate at draft (cheap, static), subjects resolve at execution.
