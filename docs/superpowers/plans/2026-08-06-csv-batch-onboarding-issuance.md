# CSV Batch Onboarding + Batch Issuance (ID-M) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /users/batch` and `POST /credential-use-cases/:key/credentials/batch` — each creating ONE batch proposal (`onboard-user-batch` / `issue-usecase-credential-batch`); draft-time all-or-nothing validation (400 + per-row problems); row-independent execution recording `{ index, status, error? }` per row into a new generic `Proposal.result`; web upload→review→submit surfaces reusing the invoice importer's `parseCsv`, with a schema-derived CSV template for issuance and a TalentPass-style report ("Successful: 7 | Failed: 1").

**Architecture:** No core change. M1 adds an additive `result Json?` to Proposal (+ `setResult` repo method + view exposure) as the report's home — `decide()` is untouched; batch executors write their own result via `ctx.deps.proposals.setResult`. M2/M3 add the two kinds + routes, each reusing the single-path checks and executors verbatim per row (incl. ID-L `initialAcceptance`). M4 is web. **Memory-vs-prisma parity rule from ID-L applies: every new persisted field goes into schema + row-type + mapper + create/update in BOTH repos.**

**Tech Stack:** apps/api (Fastify + Prisma, vitest), apps/web (React). Core untouched.

**Spec:** `docs/superpowers/specs/2026-08-06-csv-batch-onboarding-issuance-design.md`
**Plan refinements (locked here):** (1) The report's home is the new `Proposal.result` (spec said "the proposal's stored result" — this is it, made concrete). (2) The batch onboarding route ALWAYS uses the proposal path — the single route's org-member direct-create branch (`claims.orgId`) is NOT replicated in batch; an org-scoped caller's batch still drafts a proposal (documented divergence, keeps one executor path). (3) The approve response already returns `{ proposal }` — with M1, that proposal carries `result`, so the web reads the report straight from the approve response / proposal fetch.

**Conventions:** tests from repo root — `pnpm -s --filter @tokenlayer/api test`, web `typecheck`/`build`. Commit after each task. **Never touch `apps/api/prisma/dev.db*`.** Kill demo APIs by port (`lsof -ti tcp:4000 | xargs kill -9`), never pkill.

**Key facts already verified:**
- `decide()` in routes.ts (~2940s): threshold → `executeProposal(request, p, proposer)` → `setStatus("executed")`; executor return value discarded; failure path sets `failed` with the code. `ProposalRecord` (persistence/types.ts:294-311) has NO result field today.
- `onboardUserKind` (`apps/api/src/user-kinds.ts`): payload `OnboardUserPayload { email, passwordHash, role, useCaseKey, walletAddress, kyc }`; executor re-checks EMAIL_TAKEN, upserts account, creates user, mints custodial DID + KycCredential via `issueCredentialFor`; `userScopedView` for canView/canApprove; `resolveIssuerOrg(deps, useCaseKey)` helper in the same file. Registered in `apps/api/src/proposal-kinds.ts` via `registerProposalKind(...)`.
- Single onboarding draft: `POST /users` (routes.ts) — targetUseCaseKey resolution (PlatformAdmin takes body's, others their own), `useCaseDomainOf` + 404, `assignableRoles("PlatformAdmin", domain)` 400 ROLE_DOMAIN_MISMATCH, `canCreateUser` 403, `findByEmail` 400 EMAIL_TAKEN, bcrypt at draft (`bcrypt.hash(b.password, BCRYPT_ROUNDS)`), org-member direct branch when `claims.orgId` (NOT replicated in batch), otherwise creates the `onboard-user` proposal (mirror its exact `required` computation + proposal fields — read the rest of that handler).
- Single issuance draft: `POST /credential-use-cases/:key/credentials` (routes.ts:781+) — `resolveIssuer(reply, claims, def, key)` gate, `credentialUseCaseType(def, b.credentialType)`, subject checks, `holderPolicyAllows`, `validateMetadata(b.claims, spec.claimSchema)`, proposal kind `issue-usecase-credential` with `required: spec.requiredApprovals`. Executor `issueUsecaseCredentialKind` (`apps/api/src/credential-usecase-kinds.ts:29-46`) re-resolves fresh config and calls `issueCredentialFor` with `initialAcceptance: def.holderAcceptance ? "pending" : "accepted"`.
- Proposal views: grep `proposalView` / how `GET /proposals` + `/proposals/:id` project records (add `result` there).
- Prisma `model Proposal` (schema.prisma — grep): payload is a JSON-encoded String column; follow the same encode/decode pattern for `result`.
- Web: `parseCsv(text)` + header `canonicalize` + file-input pattern in `apps/web/src/components/InvoiceRegister.tsx:56,275,317`; ApprovalsPanel `summarize()` (grep `summarize` in `apps/web/src/components/ApprovalsPanel.tsx`); Add-User surface in `UserManagement.tsx`; single-issue form `IssueUsecaseCredential.tsx` (loads the desk's use case + claim schema).
- Test harness: `apps/api/test/holder-acceptance.test.ts` has the freshest patterns (use-case create, onboard, issue 202→approve, admin/admin2 double-approve).

---

## Task M1: API — generic `Proposal.result` (the report's home)

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model Proposal)
- Modify: `apps/api/src/persistence/types.ts` (`ProposalRecord` + `ProposalRepository.setResult`)
- Modify: `apps/api/src/persistence/memory.ts` + `prisma.ts` (both repos — parity rule!)
- Modify: `apps/api/src/http/routes.ts` (proposal view projection)
- Test: `apps/api/test/csv-batch.test.ts` (new, minimal for M1)

- [ ] **Step 1: Failing test** — using any existing proposal flow (e.g. a single onboarding 202), assert `GET /proposals/:id` (or the approve response's `proposal`) includes `result: null` before execution; then, after adding a temporary direct repo call in the test (`deps` not reachable from inject tests — instead test via M2 later; for M1 keep it simple): assert the FIELD EXISTS as `null` on a fetched proposal view. Run → FAIL (field absent).
- [ ] **Step 2: Schema** — `model Proposal` gains `result String?` (JSON-encoded, like `payload`).
- [ ] **Step 3: Types** — `ProposalRecord` gains `result: Record<string, unknown> | null;`; `ProposalRepository` gains `setResult(id: string, result: Record<string, unknown>): Promise<ProposalRecord>;`.
- [ ] **Step 4: Repos** — memory: store/`setResult` (throw on missing, file style); prisma: row-type + mapper (`result: r.result ? JSON.parse(r.result) : null`) + create literal (`result: null`) + `setResult` via update (`result: JSON.stringify(result)`). Run `pnpm --filter @tokenlayer/api exec prisma generate`.
- [ ] **Step 5: View** — wherever proposal records are projected to responses (grep `proposalView` or the `GET /proposals` handler), include `result: p.result`. If proposals' response schemas are strict, loosen/add the field (check schemas.ts; most are `additionalProperties: true`).
- [ ] **Step 6: Run + commit** — full api suite green (field defaults null everywhere; no behavioral change).
```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/ apps/api/src/http/ apps/api/test/csv-batch.test.ts
git commit -m "feat(api): generic Proposal.result for executor reports"
```

---

## Task M2: API — `onboard-user-batch` kind + `POST /users/batch`

**Files:**
- Modify: `apps/api/src/user-kinds.ts` (new kind + payload type)
- Modify: `apps/api/src/proposal-kinds.ts` (register)
- Modify: `apps/api/src/http/routes.ts` (route) + `schemas.ts` (schema)
- Test: extend `apps/api/test/csv-batch.test.ts`

- [ ] **Step 1: Failing tests**
1. **Happy batch:** admin POSTs `{ rows: [ {email,password,role:"Holder",useCaseKey:<identity uc>} × 3 ] }` to `/users/batch` → 202 `{ proposal }` with `kind: "onboard-user-batch"`; admin2 approves → proposal `executed`; all 3 users exist (login works), each has a DID; the approve response's `proposal.result` deep-includes `{ total: 3, succeeded: 3, failed: 0 }` and 3 `rows` entries with `status: "ok"`.
2. **Draft-time rejects, no proposal:** batch with an in-batch duplicate email → 400 with `problems: [{ index, error }]`; batch with a row whose email already exists → 400; a role-escalation row (e.g. a UseCaseAdmin caller submitting a `UseCaseAdmin` row) → 400/403 per-row problem; `rows: []` → 400; >200 rows → 400.
3. **Execution-time row failure:** draft a valid 2-row batch; BEFORE approval, create one row's user directly (admin single onboarding + approve); then approve the batch → proposal `executed`, `result` shows that row `failed` with an EMAIL_TAKEN-ish message and the other `ok`.
Run → FAIL.

- [ ] **Step 2: Kind** (`user-kinds.ts`)
```ts
export interface OnboardUserBatchPayload { rows: OnboardUserPayload[]; }

export const onboardUserBatchKind: ProposalKindHandler = {
  kind: "onboard-user-batch",
  canView: userScopedView,
  canApprove: userScopedView,
  async execute(ctx, proposer, p) {
    const deps = ctx.deps;
    const pl = p.payload as unknown as OnboardUserBatchPayload;
    const rows: { index: number; email: string; status: "ok" | "failed"; error?: string }[] = [];
    for (let i = 0; i < pl.rows.length; i++) {
      const row = pl.rows[i]!;
      try {
        await onboardSingle(deps, proposer, row, p);   // extracted from onboardUserKind.execute — see below
        rows.push({ index: i, email: row.email, status: "ok" });
      } catch (err) {
        rows.push({ index: i, email: row.email, status: "failed", error: (err as Error).message });
      }
    }
    const result = { total: rows.length, succeeded: rows.filter((r) => r.status === "ok").length, failed: rows.filter((r) => r.status === "failed").length, rows };
    await deps.proposals.setResult(p.id, result);
  },
};
```
**Refactor first (behavior-preserving):** extract the BODY of `onboardUserKind.execute` into `async function onboardSingle(deps, proposer, pl: OnboardUserPayload, p: ProposalRecord)` and have the single kind call it — so batch rows run the byte-same path (EMAIL_TAKEN re-check, account upsert, user create, DID mint, KYC credential). Existing onboarding tests must stay green.
Register in `proposal-kinds.ts`: `registerProposalKind(onboardUserBatchKind);` (import beside `onboardUserKind`).

- [ ] **Step 3: Route** (routes.ts, after `POST /users`) — mirror the single route's per-row checks exactly:
```ts
  app.post("/users/batch", { schema: S.createUsersBatch, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const { rows } = request.body as { rows: { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; kyc?: KycDetails }[] };
    const tokKeys = (await deps.useCases.list()).map((u) => u.key);
    const credKeys = (await deps.credentialUseCases.list()).map((u) => u.key);
    const problems: { index: number; error: string }[] = [];
    const seen = new Set<string>();
    const prepared: OnboardUserPayload[] = [];
    for (let i = 0; i < rows.length; i++) {
      const b = rows[i]!;
      const targetUseCaseKey = claims.role === "PlatformAdmin" ? (b.useCaseKey ?? null) : claims.useCaseKey;
      const targetDomain = targetUseCaseKey ? useCaseDomainOf(targetUseCaseKey, { tokenizationKeys: tokKeys, credentialKeys: credKeys }) : undefined;
      if (targetUseCaseKey && !targetDomain) { problems.push({ index: i, error: `no use case '${targetUseCaseKey}'` }); continue; }
      if (targetDomain && !assignableRoles("PlatformAdmin", targetDomain).includes(b.role)) { problems.push({ index: i, error: `role '${b.role}' is not valid for a ${targetDomain} use case` }); continue; }
      if (!canCreateUser({ role: claims.role, useCaseKey: claims.useCaseKey }, b.role, targetUseCaseKey, targetDomain ?? "tokenization")) { problems.push({ index: i, error: `not allowed to create role '${b.role}'` }); continue; }
      if (!b.email?.includes("@")) { problems.push({ index: i, error: "invalid email" }); continue; }
      if (seen.has(b.email)) { problems.push({ index: i, error: "duplicate email within batch" }); continue; }
      seen.add(b.email);
      if (await deps.users.findByEmail(b.email)) { problems.push({ index: i, error: "email already registered" }); continue; }
      prepared.push({ email: b.email, passwordHash: await bcrypt.hash(b.password, BCRYPT_ROUNDS), role: b.role, useCaseKey: targetUseCaseKey, walletAddress: b.walletAddress ?? null, kyc: b.kyc ?? null });
    }
    if (problems.length) return reply.code(400).send({ error: "BATCH_INVALID", message: `${problems.length} row(s) failed validation`, problems });
    // One proposal for the whole batch — mirror the single route's proposal fields/required exactly
    // (read the tail of POST /users for proposerLabel/useCaseKey/required and copy that construction).
    const proposal = await deps.proposals.create({ /* same fields as single onboard proposal, kind: "onboard-user-batch", payload: { rows: prepared }, useCaseKey: <the single-common targetUseCaseKey if all rows share one, else null> */ } as never);
    await deps.audit.append({ actorId: claims.id, action: "user-batch-proposed" as LifecycleAction, payload: { proposalId: proposal.id, total: prepared.length } });
    return reply.code(202).send({ proposal });
  });
```
(IMPLEMENTER: replace the `create({...} as never)` sketch with the real construction copied from the single `POST /users` proposal branch — same `required`, `proposerId/proposerLabel`, `status: "pending"` etc. `useCaseKey` on the proposal: use the shared per-row target when uniform, else `null` — `userScopedView` still gates by proposal.useCaseKey, so a mixed-use-case batch is PlatformAdmin-only to approve; that's acceptable and worth a comment.)

- [ ] **Step 4: Schema** (`schemas.ts`)
```ts
  createUsersBatch: {
    tags: ["Users"], summary: "Batch-onboard users from parsed CSV rows (one maker-checker proposal)", security: bearer,
    body: { type: "object", additionalProperties: false, required: ["rows"], properties: {
      rows: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", additionalProperties: true,
        required: ["email", "password", "role"], properties: { email: { type: "string" }, password: { type: "string", minLength: 8 }, role: { type: "string" }, useCaseKey: { type: "string" }, walletAddress: { type: "string" }, kyc: { type: "object", additionalProperties: true } } } } } },
    response: { 202: { type: "object", additionalProperties: true }, ...errs(400, 401, 403) },
  },
```
(Match the single `createUser` schema's role enum if it has one — reuse the same enum list.)

- [ ] **Step 5: Run + commit** — full suite green (incl. all existing onboarding tests after the `onboardSingle` extraction).
```bash
git add apps/api/src/user-kinds.ts apps/api/src/proposal-kinds.ts apps/api/src/http/ apps/api/test/csv-batch.test.ts
git commit -m "feat(api): onboard-user-batch kind + POST /users/batch with per-row report"
```

---

## Task M3: API — `issue-usecase-credential-batch` kind + batch route

**Files:**
- Modify: `apps/api/src/credential-usecase-kinds.ts` (new kind; extract `issueSingle` from the existing execute)
- Modify: `apps/api/src/proposal-kinds.ts` (register)
- Modify: `apps/api/src/http/routes.ts` + `schemas.ts`
- Test: extend `apps/api/test/csv-batch.test.ts`

- [ ] **Step 1: Failing tests**
1. **Happy batch:** identity use case (claimSchema with a number field) → `POST /credential-use-cases/:key/credentials/batch` `{ credentialType, rows: [{ subjectEmail, claims } × 3] }` as the scoped Issuer → 202 one proposal `issue-usecase-credential-batch` with `required` = the type's `requiredApprovals`; approve → 3 credentials held by the right holders; `result` = `{ total: 3, succeeded: 3, failed: 0 }`.
2. **Holder-not-found row:** one row's `subjectEmail` doesn't exist → after approve, that row `failed: "holder not found"`, others `ok` (the TalentPass Divya Nair case).
3. **Draft-time claim rejects:** a row violating the claimSchema (wrong type/missing required) → 400 `BATCH_INVALID` with that row's index; no proposal.
4. **ID-L composition:** use case with `holderAcceptance: true` → batch-issued credentials are born `acceptance: "pending"`.
5. **Gate:** a non-scoped user → 403 (same `resolveIssuer` denial as single); unknown credentialType → 400/404 as the single route does.
Run → FAIL.

- [ ] **Step 2: Kind** (`credential-usecase-kinds.ts`) — first extract the existing execute body into `async function issueSingle(deps, def, spec, subjectDid, holderOrg, claims..., p)`-style helper such that the SINGLE kind is behavior-preserving (existing issuance tests green). Then:
```ts
export const issueUsecaseCredentialBatchKind: ProposalKindHandler = {
  kind: "issue-usecase-credential-batch",
  canView: /* same predicate as the single kind */,
  canApprove: /* same */,
  async execute(ctx, proposer, p) {
    const deps = ctx.deps;
    const pl = p.payload as unknown as { useCaseKey: string; credentialType: string; rows: { subjectEmail: string; claims: Record<string, unknown> }[] };
    const def = await deps.credentialUseCases.get(pl.useCaseKey);            // fresh — never sign stale config
    if (!def) throw coded(404, "USE_CASE_MISSING", "credential use case vanished");
    const spec = credentialUseCaseType(def, pl.credentialType);
    const issuerOrg = /* resolve exactly as the single executor does (org binding / platform) */;
    const rows: { index: number; subjectEmail: string; status: "ok" | "failed"; credentialId?: string; error?: string }[] = [];
    for (let i = 0; i < pl.rows.length; i++) {
      const row = pl.rows[i]!;
      try {
        const user = await deps.users.findByEmail(row.subjectEmail);
        if (!user?.did) throw coded(404, "HOLDER_NOT_FOUND", "holder not found");
        /* holderPolicyAllows check exactly as single (user's org or null) */
        const cred = await issueCredentialFor(deps, { /* same args as single, claims: row.claims, subjectDid: user.did, initialAcceptance: def.holderAcceptance ? "pending" : "accepted" */ });
        rows.push({ index: i, subjectEmail: row.subjectEmail, status: "ok", credentialId: cred.id });
      } catch (err) {
        rows.push({ index: i, subjectEmail: row.subjectEmail, status: "failed", error: (err as Error).message });
      }
    }
    await deps.proposals.setResult(p.id, { total: rows.length, succeeded: rows.filter((r) => r.status === "ok").length, failed: rows.filter((r) => r.status === "failed").length, rows });
  },
};
```
(IMPLEMENTER: mirror the single executor's issuer-org resolution, validity days (`spec.validityDays`), and `credentialUseCaseKey` stamping exactly — read `issueUsecaseCredentialKind` and the shared helpers it uses. Register the kind.)

- [ ] **Step 3: Route** (after the single issuance route):
```ts
  app.post("/credential-use-cases/:key/credentials/batch", { schema: S.issueUsecaseCredentialsBatch, ...auth }, async (request, reply) => {
    const claims = request.user as TokenClaims;
    const key = (request.params as { key: string }).key;
    const def = await deps.credentialUseCases.get(key).catch(() => null);
    if (!def) return notFound(reply, "credential use case not found");
    const issuer = await resolveIssuer(reply, claims, def, key);            // same gate as single (sends 403 itself)
    if (!issuer) return reply;
    const b = request.body as { credentialType: string; rows: { subjectEmail: string; claims: Record<string, unknown> }[] };
    let spec; try { spec = credentialUseCaseType(def, b.credentialType); } catch { return reply.code(400).send({ error: "UNKNOWN_CREDENTIAL_TYPE", message: `no type '${b.credentialType}'` }); }
    const problems: { index: number; error: string }[] = [];
    for (let i = 0; i < b.rows.length; i++) {
      try { validateMetadata(b.rows[i]!.claims, spec.claimSchema); } catch (err) { problems.push({ index: i, error: (err as Error).message }); }
      if (!b.rows[i]!.subjectEmail?.includes("@")) problems.push({ index: i, error: "invalid subjectEmail" });
    }
    if (problems.length) return reply.code(400).send({ error: "BATCH_INVALID", message: `${problems.length} row(s) failed validation`, problems });
    const proposal = await deps.proposals.create({ /* mirror the single issuance proposal construction: kind "issue-usecase-credential-batch", payload { useCaseKey: key, credentialType: b.credentialType, rows: b.rows }, required: spec.requiredApprovals, useCaseKey/orgId as the single route sets them */ } as never);
    await deps.audit.append({ actorId: claims.id, action: "credential-batch-proposed" as LifecycleAction, payload: { proposalId: proposal.id, useCaseKey: key, total: b.rows.length } });
    return reply.code(202).send({ proposal });
  });
```

- [ ] **Step 4: Schema** — `issueUsecaseCredentialsBatch` mirroring the single issuance schema's style; rows `minItems: 1, maxItems: 200`, items `{ required: ["subjectEmail", "claims"], additionalProperties: false, properties: { subjectEmail: {type:"string"}, claims: {type:"object", additionalProperties:true} } }`; responses `202` loose + `errs(400, 401, 403, 404)`.

- [ ] **Step 5: Run + commit**
```bash
git add apps/api/src/credential-usecase-kinds.ts apps/api/src/proposal-kinds.ts apps/api/src/http/ apps/api/test/csv-batch.test.ts
git commit -m "feat(api): issue-usecase-credential-batch kind + batch route with per-row report"
```

---

## Task M4: Web — batch surfaces + report + approval summaries

**Files:**
- Modify: `apps/web/src/types.ts` (Proposal type gains `result?`; batch row/report types)
- Modify: `apps/web/src/api.ts` (`onboardUsersBatch`, `issueCredentialsBatch`, `proposal` fetch if absent)
- Create: `apps/web/src/components/BatchCsv.tsx` (shared: file input → parseCsv → header mapping → review table → submit → report dialog)
- Modify: `apps/web/src/components/UserManagement.tsx` (Batch onboard entry) + `IssueUsecaseCredential.tsx` (Batch issue mode + CSV template download)
- Modify: `apps/web/src/components/ApprovalsPanel.tsx` (`summarize` arms)

- [ ] **Step 1: Shared piece** — extract/reuse `parseCsv` (either export it from InvoiceRegister.tsx or lift it into a small `apps/web/src/lib/csv.ts` used by both — lifting is preferred; keep InvoiceRegister importing from the new module so there's ONE parser). `BatchCsv.tsx` props: `{ expectedHeaders: string[], optionalHeaders?: string[], coerce?: (row) => row, onSubmit(rows) => Promise<{ proposalId }>, templateName: string }` — renders: info box with the exact expected header line, **Download CSV template** link (`data:text/csv` of the header row), file input, review table (first ~50 rows + count), per-row client validation flags (missing required cells), Submit button, and after submit a "pending approval" note with the proposal id.
- [ ] **Step 2: Onboarding surface** — in UserManagement (identity/tokenization managers), a "Batch onboard (CSV)" toggle: headers `email,password,role,useCaseKey,walletAddress`; submit → `api.onboardUsersBatch(token, rows)`.
- [ ] **Step 3: Issuance surface** — in IssueUsecaseCredential, a "Batch issue (CSV)" toggle: pick credential type → expected headers = `subjectEmail,<claim keys>` (from the loaded spec's claimSchema, schema order); coerce number/boolean cells per property type (same coercion the single form uses); submit → `api.issueCredentialsBatch(token, key, credentialType, rows)`.
- [ ] **Step 4: Report** — after the checker approves, the desk can open the proposal (ApprovalsPanel "Recent decisions" already lists it): show `result` when present — a TalentPass-style dialog/inline block: "Total: N | Successful: S | Failed: F" + failed-row list (`index+1. <email/subjectEmail>: <error>`). Wire it wherever proposals are rendered post-decision (ApprovalsPanel row expand is fine — keep minimal).
- [ ] **Step 5: Summaries** — `summarize()` arms: `onboard-user-batch` → "Onboard N users…", `issue-usecase-credential-batch` → "Issue N × <credentialType> — <useCaseKey>".
- [ ] **Step 6: Verify + commit** — `typecheck` + `build` clean.
```bash
git add apps/web/src/
git commit -m "feat(web): CSV batch onboarding + batch issuance surfaces with per-row report"
```

---

## Task M5: Verify — suites + live Besu walkthrough + review + finish

- [ ] **Step 1: Full suites** — `pnpm -s typecheck` (5), core test (untouched count), api test, web build. All green.
- [ ] **Step 2: Live Besu walkthrough** (standard recipe; throwaway `dev-mdemo.db` in `apps/api/prisma/`; kill by port; Besu-restart remedy if seed deploys wedge):
  1. Provision a domicile program (ID-J); PATCH `holderAcceptance: true`.
  2. `POST /users/batch` — 5 Holder rows (one duplicate-email batch first to show the 400 problems) → approve → result 5/5; all can log in.
  3. `POST /credential-use-cases/:key/credentials/batch` — 5 rows where 1 subjectEmail is unknown → approve → result "Successful: 4 | Failed: 1 — holder not found"; the 4 credentials are born `pending` (ID-L); one holder accepts and downloads the certificate.
  4. eth_call: one issued credential anchored on Besu (statusOf exists).
  5. Teardown; dev.db untouched.
- [ ] **Step 3: Final review** — focus: single-path behavior preservation after the two executor extractions (existing onboarding/issuance tests untouched-green is the oracle); draft-vs-execute validation split; report correctness under partial failure; password hashing at draft; no dev.db; prisma parity for `Proposal.result` (schema+mapper+create/update both repos).
- [ ] **Step 4: Finish** — `superpowers:finishing-a-development-branch` (merge `feat/csv-batch` → main).

---

## Notes / risks

- **The two extractions (`onboardSingle`, `issueSingle`) are refactors of live executors** — behavior-preserving is non-negotiable; existing tests are the oracle and may not be edited.
- **`Proposal.result` parity**: apply the ID-L lesson — schema + row-type + mapper + create + update in BOTH repos, `prisma generate`, and remember memory tests can't catch a prisma-side drop; M5's live walkthrough must read a result from the real DB path.
- **Passwords in payloads**: the batch payload stores bcrypt hashes only (hashed at draft, same as single) — never plaintext in a proposal row.
- **Mixed-use-case onboarding batches** get `proposal.useCaseKey = null` ⇒ PlatformAdmin-only approval via `userScopedView` — comment it in the route.
- **Report size**: 200-row cap keeps `result` JSON small; don't echo full row payloads into the report (index + email/subjectEmail + error only).
- **Web `as never` sketches in this plan are for the ROUTE construction only** — implementers must copy the real proposal-construction fields from the single routes; leaving `as never` in committed code is a plan failure.
