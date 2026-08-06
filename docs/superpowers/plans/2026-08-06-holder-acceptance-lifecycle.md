# Holder Acceptance Lifecycle (ID-L) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in `holderAcceptance` per credential use case; issued credentials are born `pending` — the holder must **Accept** (fully live), **Reject** (chain-first auto-revoke, terminal), or **Request changes** (required note). Until accepted: not presentable (consent), fails the ID-H gate, no certificate; the public status endpoint reports the acceptance state.

**Architecture:** Core adds one optional flag + validation + template carry. API adds three additive `Credential` columns (default `"accepted"`), an `initialAcceptance` input on `issueCredentialFor` (only the use-case executor ever passes `"pending"`), three holder action routes, and `accepted`-gates on the four consumers. Web adds action-required cards + pills + a builder toggle. Flag off ⇒ byte-identical behavior; existing tests are the oracle and may not be edited.

**Tech Stack:** packages/core (TS, vitest), apps/api (Fastify + Prisma, vitest), apps/web (React).

**Spec:** `docs/superpowers/specs/2026-08-06-holder-acceptance-lifecycle-design.md`

**Conventions:** tests from repo root — `pnpm -s --filter @tokenlayer/core test`, `pnpm -s --filter @tokenlayer/api test`, `pnpm -s --filter @tokenlayer/web typecheck`/`build`. Commit after each task. **Never touch `apps/api/prisma/dev.db*`.** Prisma schema change is applied in tests automatically (test harness uses memory repos; the live DB gets it via `prisma db push` at walkthrough time).

**Key facts already verified:**
- `CredentialUseCaseDefinition` at `packages/core/src/credential-use-cases.ts:46-56` (post-ID-I numbering; fields `key,name,description?,credentialTypes,issuer,holderPolicy,verifier,ownerOrgId?`); `validateCredentialUseCase` with the `fail` helper; test file `packages/core/test/credential-use-cases.test.ts`.
- Templates: `UseCaseTemplate.body` at `packages/core/src/use-case-templates.ts` (`keyTemplate,nameTemplate,descriptionTemplate?,credentialTypes,holderPolicy,verifier`); `validateTemplate` (per-type loop exists since ID-J); `instantiateTemplate` returns the emitted definition at its final `return { key…, verifier }` block; test file `packages/core/test/use-case-templates.test.ts`.
- `CredentialRecord` at `apps/api/src/persistence/types.ts:400-415`; `CredentialRepository` at `:417-424` (`create/listByHolder/listByIssuer/get/setRevoked/revoke`). Prisma `model Credential` at `apps/api/prisma/schema.prisma:243+`. Prisma credential mapper/create at `apps/api/src/persistence/prisma.ts:~810-835`; memory repo spreads records (grep `MemoryCredentialRepository` in `apps/api/src/persistence/memory.ts`).
- `issueCredentialFor` at `apps/api/src/credential-issuance.ts:22-48` (args interface `IssueCredentialArgs` directly above; persist block at the end constructs the record literal). `revokeCredentialById(deps, credentialId, { reason, by, at })` at `:51-62` — chain FIRST then `credentials.revoke` (throws 409 ALREADY_REVOKED / 404).
- Use-case issuance executor: `apps/api/src/credential-usecase-kinds.ts:29-46` — re-resolves the use case fresh, then calls `issueCredentialFor`.
- Consent eligibility gate: `apps/api/src/http/routes.ts:2533-2541` — `if (!c || c.revoked || !r.requestedTypes.includes(c.type))` → 400 `CREDENTIAL_NOT_ELIGIBLE`.
- Holder inbox `GET /me/verification-requests` at routes.ts:2494-2506 — `eligibleCredentials` filter `(!c.revoked && r.requestedTypes.includes(c.type))`.
- `hasVerifiedIdentity` at `apps/api/src/compliance-provider.ts:45-53` — `held.some((c) => !c.revoked && c.type.includes("KycCredential"))`.
- `mapHeld` at routes.ts:~2028-2049 (includes `certificateAvailable` via `certOk`); certificate route `GET /credentials/:id/certificate.pdf` at ~2356 (404 branch `if (!def || !spec)`); public status route at ~2327 (`fromDb` object).
- Web: `HeldCredential` at `apps/web/src/types.ts:341+`; `CredentialCard.tsx` (pills row + details block); `MyIdentity.tsx` renders wallet cards + the Verification-requests inbox; `CredentialUseCaseBuilder.tsx` Step-3 Roles section (issuer/holder/verifier controls) + `buildDefinition()`; api client `apps/web/src/api.ts`.
- API test harness: `buildTestApp` from `apps/api/test/helpers.ts` (memory repos + FakeAnchor `fakeRegistry` optional); issuance flow pattern in `apps/api/test/credential-usecase.test.ts`; ID-H gate tests in the identity-gate test file (grep `hasVerifiedIdentity`/`IDENTITY_NOT_VERIFIED` under `apps/api/test`); certificate tests in `apps/api/test/credential-certificate.test.ts`.

---

## Task L1: Core — `holderAcceptance` flag + validation + template carry

**Files:**
- Modify: `packages/core/src/credential-use-cases.ts`
- Modify: `packages/core/src/use-case-templates.ts`
- Test: `packages/core/test/credential-use-cases.test.ts`, `packages/core/test/use-case-templates.test.ts`

- [ ] **Step 1: Failing tests**

In `credential-use-cases.test.ts` (reuse the existing `baseDef`-style builder from the certificate tests, adding a top-level field):
```ts
describe("holderAcceptance validation", () => {
  it("accepts a boolean holderAcceptance and absence (back-compat)", () => {
    expect(() => validateCredentialUseCase({ ...baseDef2(), holderAcceptance: true } as CredentialUseCaseDefinition, certCtx)).not.toThrow();
    expect(() => validateCredentialUseCase(baseDef2(), certCtx)).not.toThrow();
  });
  it("rejects a non-boolean holderAcceptance", () => {
    expect(() => validateCredentialUseCase({ ...baseDef2(), holderAcceptance: "yes" } as unknown as CredentialUseCaseDefinition, certCtx)).toThrow(/holderAcceptance/);
  });
});
```
(Adapt the builder/ctx names to what the file actually uses — grep `certCtx`/`baseDef`.)

In `use-case-templates.test.ts`:
```ts
describe("template holderAcceptance carry", () => {
  it("emits holderAcceptance from the template body", () => {
    const t = certTemplate(); (t.body as { holderAcceptance?: boolean }).holderAcceptance = true;
    const def = instantiateTemplate(t, { issuerOrgName: "Acme" });
    expect(def.holderAcceptance).toBe(true);
  });
  it("omits holderAcceptance when the body has none (back-compat)", () => {
    const def = instantiateTemplate(certTemplate(), { issuerOrgName: "Acme" });
    expect(def.holderAcceptance).toBeUndefined();
  });
  it("validateTemplate rejects a non-boolean body.holderAcceptance", () => {
    const t = certTemplate(); (t.body as { holderAcceptance?: unknown }).holderAcceptance = "yes";
    expect(() => validateTemplate(t)).toThrow(/holderAcceptance/);
  });
});
```
(`certTemplate` is the ID-J fixture already in that file.) Run both core suites → the new cases FAIL.

- [ ] **Step 2: Types + validation** (`credential-use-cases.ts`)

Add to `CredentialUseCaseDefinition` (after `verifier`):
```ts
  /** When true, issued credentials require explicit holder acceptance before
   *  they can be presented, satisfy identity gates, or expose a certificate. */
  holderAcceptance?: boolean;
```
In `validateCredentialUseCase`, after the credential-type loop (beside the issuer/holder/verifier org checks):
```ts
  if (def.holderAcceptance !== undefined && typeof def.holderAcceptance !== "boolean")
    fail("holderAcceptance must be a boolean");
```

- [ ] **Step 3: Template carry** (`use-case-templates.ts`)

Add to `UseCaseTemplate.body` (after `verifier`):
```ts
    /** Carried onto the emitted definition (ID-L holder acceptance ceremony). */
    holderAcceptance?: boolean;
```
In `validateTemplate` (after the per-type certificate loop):
```ts
  if (t.body.holderAcceptance !== undefined && typeof t.body.holderAcceptance !== "boolean")
    fail("body.holderAcceptance must be a boolean");
```
In `instantiateTemplate`'s final `return { … }`, add after `verifier`:
```ts
    ...(t.body.holderAcceptance !== undefined ? { holderAcceptance: t.body.holderAcceptance } : {}),
```

- [ ] **Step 4: Run + commit**

`pnpm -s --filter @tokenlayer/core test` all green; `typecheck` clean.
```bash
git add packages/core/src/credential-use-cases.ts packages/core/src/use-case-templates.ts packages/core/test/
git commit -m "feat(core): holderAcceptance flag on credential use cases + template carry"
```

---

## Task L2: API — acceptance persistence + born-pending issuance

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (Credential model)
- Modify: `apps/api/src/persistence/types.ts` (`CredentialRecord`, `CredentialRepository`)
- Modify: `apps/api/src/persistence/memory.ts` + `apps/api/src/persistence/prisma.ts`
- Modify: `apps/api/src/credential-issuance.ts` (`IssueCredentialArgs` + persist)
- Modify: `apps/api/src/credential-usecase-kinds.ts` (pass `"pending"` when flagged)
- Test: `apps/api/test/holder-acceptance.test.ts` (new)

- [ ] **Step 1: Failing tests** (`apps/api/test/holder-acceptance.test.ts`; harness copied from `credential-usecase.test.ts` — buildTestApp, admin login, create use case, onboard holder, issue via 202→approve)

Cases for L2 (routes come in L3 — these assert persistence-level behavior via existing read routes):
1. **Toggle off (back-compat):** create a use case WITHOUT `holderAcceptance`; issue+approve → `GET /me/credentials` as the holder shows the credential with `acceptance: "accepted"` (the field must be present in `mapHeld` — add that projection field in this task, Step 5).
2. **Toggle on:** same but the use case has `holderAcceptance: true` → the held credential has `acceptance: "pending"`, `acceptanceAt: null`.
3. Non-use-case issuance stays accepted: reuse an existing catalog/KYC issuance pattern from another test (e.g. the verifier-org KycCredential request flow) → `acceptance: "accepted"`.
Run → FAIL (unknown fields).

- [ ] **Step 2: Prisma** (`schema.prisma`, `model Credential` after `credentialUseCaseKey`)
```prisma
  acceptance     String    @default("accepted") // accepted | pending | rejected | changes_requested
  acceptanceAt   DateTime?
  acceptanceNote String?
```

- [ ] **Step 3: Types** (`persistence/types.ts`)

`CredentialRecord` gains:
```ts
  acceptance: "accepted" | "pending" | "rejected" | "changes_requested";
  acceptanceAt: string | null;
  acceptanceNote: string | null;
```
`CredentialRepository` gains:
```ts
  setAcceptance(id: string, patch: { acceptance: CredentialRecord["acceptance"]; at: string; note: string | null }): Promise<CredentialRecord>;
```
And the `create` input type (grep how `create` is typed — it takes the full record minus nothing; extend accordingly so `acceptance`/`acceptanceAt`/`acceptanceNote` are provided by the caller).

- [ ] **Step 4: Repos**

Memory (`memory.ts` `MemoryCredentialRepository`): store the new fields on create (spread already covers if create input carries them — verify); implement `setAcceptance` mutating the record (throw if missing, matching the file's style).
Prisma (`prisma.ts`): extend the row-type + mapper (`acceptance: r.acceptance as CredentialRecord["acceptance"], acceptanceAt: r.acceptanceAt?.toISOString() ?? null, acceptanceNote: r.acceptanceNote`) + the `create` data literal + implement `setAcceptance` via `prisma.credential.update`. Follow the exact per-field mapper style at prisma.ts:~810-835 (fields are listed individually — do not miss the create literal).

- [ ] **Step 5: Issuance + projection**

`credential-issuance.ts`: `IssueCredentialArgs` gains `initialAcceptance?: CredentialRecord["acceptance"];` and the persist literal sets `acceptance: a.initialAcceptance ?? "accepted", acceptanceAt: null, acceptanceNote: null` (also add these to any other `credentials.create` call sites — grep `credentials.create(` across apps/api/src; typecheck will find them).
`credential-usecase-kinds.ts` execute: after re-resolving `def`, pass `initialAcceptance: def.holderAcceptance ? "pending" : "accepted"` to `issueCredentialFor`.
`routes.ts` `mapHeld`: add `acceptance: c.acceptance, acceptanceAt: c.acceptanceAt, acceptanceNote: c.acceptanceNote` to the projection (loose response schemas pass them through — the wallet routes' response schemas are `additionalProperties: true`; verify, loosen if not).

- [ ] **Step 6: Run + commit**

`pnpm -s --filter @tokenlayer/api test` all green (new + existing — existing tests never mention acceptance and defaults keep them green); `typecheck` clean.
```bash
git add apps/api/prisma/schema.prisma apps/api/src/persistence/ apps/api/src/credential-issuance.ts apps/api/src/credential-usecase-kinds.ts apps/api/src/http/routes.ts apps/api/test/holder-acceptance.test.ts
git commit -m "feat(api): credential acceptance state — born pending under holderAcceptance use cases"
```

---

## Task L3: API — holder action routes + fail-closed consumer gates

**Files:**
- Modify: `apps/api/src/http/routes.ts` (3 routes + 4 gates)
- Modify: `apps/api/src/http/schemas.ts` (3 schemas + status field)
- Modify: `apps/api/src/compliance-provider.ts` (ID-H gate)
- Test: extend `apps/api/test/holder-acceptance.test.ts`

- [ ] **Step 1: Failing tests** (extend the L2 file; use a registry-backed app via `fakeRegistry(new FakeAnchor())` where chain assertions matter)

1. **Accept:** pending credential → `POST /me/credentials/:id/accept` as the holder → 200; held credential now `accepted` with `acceptanceAt` set.
2. **Reject revokes chain-first:** pending → `POST /me/credentials/:id/reject` `{ note: "wrong grade" }` → 200; credential `rejected` AND `revoked: true`; the FakeAnchor's `credentials.get(id).revoked === true` (chain revoke really happened).
3. **Request changes:** pending → `POST /me/credentials/:id/request-changes` `{}` → 400 (note required); with `{ note: "name misspelt" }` → 200, `changes_requested`, note stored; then `accept` from that state → 200 `accepted`.
4. **State machine:** accept on an `accepted` credential → 409 `INVALID_ACCEPTANCE_STATE`; reject on `rejected` → 409.
5. **Wrong holder:** another user's token → 404.
6. **Consent gate:** verification request for the type; holder consents with a PENDING credential id → 400 `CREDENTIAL_NOT_ELIGIBLE`; after accept → consent 200. Also `GET /me/verification-requests` excludes the pending credential from `eligibleCredentials`.
7. **ID-H gate:** mirror the existing identity-gate test setup but the KYC use case has `holderAcceptance: true` → buy refused `IDENTITY_NOT_VERIFIED` while pending; holder accepts → buy succeeds.
8. **Certificate:** cert-enabled + acceptance-enabled use case → while pending `certificateAvailable: false` and `GET /credentials/:id/certificate.pdf` → 404; after accept → 200 `%PDF-`.
9. **Status:** `GET /credentials/:id/status` includes `acceptance: "pending"` then `"accepted"`.
Run → FAIL.

- [ ] **Step 2: Schemas** (`schemas.ts`, near `myCredentials`)
```ts
  acceptCredential: { tags: ["Credentials"], summary: "Holder accepts a pending credential", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, properties: { note: { type: "string" } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(401, 404, 409) } },
  rejectCredential: { /* same shape, summary "Holder rejects a pending credential (revokes it)" */ },
  requestCredentialChanges: { tags: ["Credentials"], summary: "Holder requests changes on a pending credential", security: bearer,
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    body: { type: "object", additionalProperties: false, required: ["note"], properties: { note: { type: "string", minLength: 1 } } },
    response: { 200: { type: "object", additionalProperties: true }, ...errs(400, 401, 404, 409) } },
```
(Match the file's exact `errs`/bearer style. Also add `acceptance: { type: "string" }` to the `credentialStatus` 200 schema IF its response is strictly declared — check; if `additionalProperties: true`, nothing needed.)

- [ ] **Step 3: Routes** (routes.ts, beside `GET /me/credentials`; a shared helper keeps the three thin)
```ts
  /** Load a credential owned by the caller's DID, in one of `from` states. Null ⇒ reply sent. */
  async function holderCredentialInState(request: FastifyRequest, reply: FastifyReply, from: CredentialRecord["acceptance"][]): Promise<CredentialRecord | null> {
    const claims = request.user as TokenClaims;
    const { id } = request.params as { id: string };
    const cred = await deps.credentials.get(id);
    if (!cred || !claims.did || cred.holderDid !== claims.did) { notFound(reply, "credential not found"); return null; }
    if (!from.includes(cred.acceptance)) {
      reply.code(409).send({ error: "INVALID_ACCEPTANCE_STATE", message: `credential is '${cred.acceptance}'` });
      return null;
    }
    return cred;
  }

  app.post("/me/credentials/:id/accept", { schema: S.acceptCredential, ...auth }, async (request, reply) => {
    const cred = await holderCredentialInState(request, reply, ["pending", "changes_requested"]);
    if (!cred) return reply;
    const updated = await deps.credentials.setAcceptance(cred.id, { acceptance: "accepted", at: new Date().toISOString(), note: null });
    await deps.audit.append({ actorId: (request.user as TokenClaims).id, action: "credential-accepted" as LifecycleAction, payload: { credentialId: cred.id } });
    return { id: updated.id, acceptance: updated.acceptance, acceptanceAt: updated.acceptanceAt };
  });

  app.post("/me/credentials/:id/reject", { schema: S.rejectCredential, ...auth }, async (request, reply) => {
    const cred = await holderCredentialInState(request, reply, ["pending", "changes_requested"]);
    if (!cred) return reply;
    const claims = request.user as TokenClaims;
    const note = (request.body as { note?: string })?.note ?? null;
    // Chain-first revoke; a throw leaves the credential pending (never DB-revoked/chain-valid).
    await revokeCredentialById(deps, cred.id, { reason: note ? `holder rejected: ${note}` : "holder rejected", by: claims.id, at: new Date().toISOString() });
    const updated = await deps.credentials.setAcceptance(cred.id, { acceptance: "rejected", at: new Date().toISOString(), note });
    await deps.audit.append({ actorId: claims.id, action: "credential-rejected" as LifecycleAction, payload: { credentialId: cred.id, note } });
    return { id: updated.id, acceptance: updated.acceptance, revoked: true };
  });

  app.post("/me/credentials/:id/request-changes", { schema: S.requestCredentialChanges, ...auth }, async (request, reply) => {
    const cred = await holderCredentialInState(request, reply, ["pending"]);
    if (!cred) return reply;
    const { note } = request.body as { note: string };
    const updated = await deps.credentials.setAcceptance(cred.id, { acceptance: "changes_requested", at: new Date().toISOString(), note });
    await deps.audit.append({ actorId: (request.user as TokenClaims).id, action: "credential-changes-requested" as LifecycleAction, payload: { credentialId: cred.id, note } });
    return { id: updated.id, acceptance: updated.acceptance, acceptanceNote: updated.acceptanceNote };
  });
```
(`revokeCredentialById` is already imported in routes.ts? Grep — routes.ts imports from `../credential-issuance.js`? The revoke ROUTE at :2277 uses a proposal kind; import `revokeCredentialById` directly if absent. `FastifyRequest`/`FastifyReply` types already imported.)

- [ ] **Step 4: Consumer gates** (each one line)

1. Consent (routes.ts:2536): `if (!c || c.revoked || c.acceptance !== "accepted" || !r.requestedTypes.includes(c.type))` — message stays `CREDENTIAL_NOT_ELIGIBLE` but update the text to `…eligible, unrevoked, accepted, requested-type…`.
2. Inbox eligibleCredentials (routes.ts:2502): `.filter((c) => !c.revoked && c.acceptance === "accepted" && r.requestedTypes.includes(c.type))`.
3. `compliance-provider.ts:53`: `held.some((c) => !c.revoked && c.acceptance === "accepted" && c.type.includes("KycCredential"))`.
4. Certificate: in `mapHeld`'s `certOk` return `cred-accepted && …` (i.e. `c.acceptance === "accepted" && def.credentialTypes.some(…)`), and in the certificate route add after the `!def || !spec` 404: `if (cred.acceptance !== "accepted") return notFound(reply, "no certificate for this credential");`.
5. Status route: add `acceptance: cred.acceptance` into the `fromDb` object (it spreads into every return branch).

- [ ] **Step 5: Run + commit**

Full api suite green — every existing test untouched (back-compat is the invariant; existing credentials are born accepted so gates are no-ops). `typecheck` clean.
```bash
git add apps/api/src/http/ apps/api/src/compliance-provider.ts apps/api/test/holder-acceptance.test.ts
git commit -m "feat(api): holder accept/reject/request-changes routes + accepted-gates on consent, ID-H, certificate, status"
```

---

## Task L4: Web — action-required cards + pills + builder toggle

**Files:**
- Modify: `apps/web/src/types.ts` (HeldCredential + CredentialUseCase + CredentialStatusInfo)
- Modify: `apps/web/src/api.ts` (3 client calls)
- Modify: `apps/web/src/components/CredentialCard.tsx` (acceptance pill + action buttons)
- Modify: `apps/web/src/components/MyIdentity.tsx` + `apps/web/src/components/OrganizationWallet.tsx` (pass refresh callback if needed)
- Modify: `apps/web/src/components/CredentialUseCaseBuilder.tsx` (toggle + buildDefinition/buildTemplate)

- [ ] **Step 1: Types**
```ts
// HeldCredential +=
  acceptance?: "accepted" | "pending" | "rejected" | "changes_requested";
  acceptanceAt?: string | null;
  acceptanceNote?: string | null;
// CredentialUseCase +=
  holderAcceptance?: boolean;
// CredentialStatusInfo +=
  acceptance?: string;
```

- [ ] **Step 2: api client** (inside `api`)
```ts
  acceptCredential: (token: string, id: string) => request<{ id: string; acceptance: string }>(`/me/credentials/${encodeURIComponent(id)}/accept`, token, { method: "POST", body: "{}" }),
  rejectCredential2: (token: string, id: string, note?: string) => request<{ id: string; acceptance: string }>(`/me/credentials/${encodeURIComponent(id)}/reject`, token, { method: "POST", body: JSON.stringify(note ? { note } : {}) }),
  requestCredentialChanges: (token: string, id: string, note: string) => request<{ id: string; acceptance: string }>(`/me/credentials/${encodeURIComponent(id)}/request-changes`, token, { method: "POST", body: JSON.stringify({ note }) }),
```
(NAME CLASH: `api.rejectCredential` may not exist but `revokeCredential` does — check; name the holder one `rejectCredential2` only if `rejectCredential` is taken, else use the clean name. Match the existing `request` helper's POST style — grep a POST call for exact shape.)

- [ ] **Step 3: CredentialCard** — acceptance pill + holder actions

Add props: `onAcceptanceAction?: () => void` (refresh callback) and use `useAuth()` for the token (check whether CredentialCard already imports it; if not, import from the auth module used elsewhere).
- Pills row: when `c.acceptance && c.acceptance !== "accepted"`, add `<Pill tone={c.acceptance === "pending" ? "warn" : "danger"}>{c.acceptance.replace("_", " ")}</Pill>` (use an existing tone — grep Pill tones; `"warn"` may be `"muted"`/amber — match ui.tsx).
- When `c.acceptance === "pending" || c.acceptance === "changes_requested"`, render an action strip under the header (amber left-border box): text "This credential needs your review." + buttons **Accept** (calls `api.acceptCredential`, then `onAcceptanceAction?.()`), **Request changes** (toggles an inline textarea + submit, required non-empty), **Reject** (window.confirm "Rejecting permanently revokes this credential." → `api.rejectCredential2` with optional note). Show `acceptanceNote` when `changes_requested`.
- MyIdentity + OrganizationWallet pass `onAcceptanceAction={reload}` (each component already has a load/refresh function — grep how they fetch and reuse it).

- [ ] **Step 4: Builder toggle** (`CredentialUseCaseBuilder.tsx`)

State `const [holderAcceptance, setHolderAcceptance] = useState(false);` — a checkbox in the Step-3 Roles section (beside verifier controls): label **"Require holder acceptance"**, helper "Issued credentials stay pending until the holder accepts, rejects, or requests changes." `buildDefinition()` adds `...(holderAcceptance ? { holderAcceptance: true } : {})`. `buildTemplate()`: add `...(def.holderAcceptance ? { holderAcceptance: true } : {})` into the body literal (templates carry it per L1).

- [ ] **Step 5: Verify + commit**

`pnpm -s --filter @tokenlayer/web typecheck` clean; `build` succeeds.
```bash
git add apps/web/src/
git commit -m "feat(web): holder acceptance actions + pills + builder toggle"
```

---

## Task L5: Verify — suites + live Besu walkthrough + review + finish

- [ ] **Step 1: Full suites** — `pnpm -s typecheck` (5 pkgs), core test, api test, web build. All green.
- [ ] **Step 2: Live walkthrough** (Besu recipe: throwaway `DATABASE_URL="file:./dev-ldemo.db"` pushed from `apps/api` — file lands in `apps/api/prisma/` — root .env + `BESU_RPC_URL`/`BESU_OPERATOR_KEY=0x8f2a…be63`/`REGISTRY_CHAIN_ID=besu`/`CHAIN_STRICT=0`; unset MST vars; **dev.db untouched**; if boot wedges on a seed deploy, `docker restart besu-node1..5` then reboot):
  1. Create an acceptance-enabled Domicile use case (script or builder toggle); issue to a holder → wallet shows `pending`.
  2. While pending: consent → `CREDENTIAL_NOT_ELIGIBLE`; certificate → 404; status shows `acceptance: "pending"`.
  3. Holder **requests changes** with a note → desk sees `changes requested` + note.
  4. Holder **accepts** → present to the scoped Verifier → `valid: true` with the issuerResolution pill; certificate downloads.
  5. Issue a second credential → holder **rejects** → `eth_call VcRegistry.statusOf` shows `revoked: true` (chain-first) and status reports `acceptance: "rejected"`, `revoked: true`.
  6. Teardown: kill API, delete `apps/api/prisma/dev-ldemo.db*`, confirm dev.db clean.
- [ ] **Step 3: Final review** — whole-implementation review. Focus: toggle-off byte-equivalence (no existing test edited), reject's chain-first ordering (failure leaves `pending`), all four gates fire only on non-accepted, state machine (terminal accepted/rejected; changes_requested → accepted/rejected allowed), holder-only 404 posture, no dev.db writes.
- [ ] **Step 4: Finish** — `superpowers:finishing-a-development-branch` (merge `feat/holder-acceptance` → main).

---

## Notes / risks

- **Back-compat is the headline**: default `"accepted"` at every layer (Prisma default, `initialAcceptance ?? "accepted"`, non-use-case issuers untouched) means no existing test may need edits — if one fails, the change is wrong, not the test.
- **`credentials.create` call sites**: typecheck will surface every literal missing the new fields (memory/prisma repos, any test fixtures constructing records — fixtures MAY be extended since they're constructors, not behavioral assertions).
- **Reject ordering**: `revokeCredentialById` throws on chain failure BEFORE `setAcceptance` runs — pending is preserved; also note it throws 409 if already revoked (a race with an issuer revoke) — let that propagate as the route's 409.
- **`LifecycleAction` audit strings**: the file casts custom actions (`"verification-consented" as LifecycleAction`) — follow that pattern for the three new actions.
- **Pill tones**: grep `ui.tsx` for the actual tone union before using `"warn"` — use the closest existing tone (likely `"muted"` or an amber variant); do not extend ui.tsx unless trivial.
- **ID-N dependency**: this task deliberately stops at pills on existing surfaces; the status board/dashboard is ID-N.
