# Pluggable DID/VC Identity Gate for Tokenization (ID-H) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `compliance.requireVerifiedIdentity` toggle on a tokenization use case; when on, a wallet may only receive/hold the token if its user holds an unrevoked `KycCredential`.

**Architecture:** Extend the existing `ComplianceProvider` seam — add `hasVerifiedIdentity(account)` beside `jurisdictionOf`, a `compliance.requireVerifiedIdentity` flag on `UseCaseDefinition`, and one engine enforcement branch called at the same receive points as `requireJurisdiction`. The API provider impl checks held credentials + revocation. Fully back-compatible (flag off = unchanged).

**Tech Stack:** packages/core (TS, vitest), apps/api (Fastify + Prisma, vitest), apps/web (React).

**Spec:** `docs/superpowers/specs/2026-07-29-tokenization-identity-gate-design.md`

**Conventions:** tests from repo root: `pnpm -s --filter @tokenlayer/core test`, `... @tokenlayer/api test`, `... @tokenlayer/web typecheck`. Commit after each task. Never touch `apps/api/prisma/dev.db*`.

---

## Task H1: Core — flag + provider method + engine enforcement + validation

**Files:**
- Modify: `packages/core/src/types.ts` (UseCaseDefinition.compliance + ComplianceProvider interface, ~line 257)
- Modify: `packages/core/src/lifecycle-engine.ts` (enforcement, ~line 463 + the 6 `requireJurisdiction` call sites)
- Modify: `packages/core/src/validation.ts` (validateCompliance, ~line 158)
- Test: `packages/core/test/lifecycle-engine.test.ts` (or the existing compliance test file — grep `requireJurisdiction`/`JURISDICTION_NOT_ALLOWED` in `packages/core/test`)

- [ ] **Step 1: Failing test**

Add tests (mirror the existing jurisdiction test) using an in-test `ComplianceProvider` stub. Cases: a use case with `compliance.requireVerifiedIdentity: true` — a `to` account for which `hasVerifiedIdentity` returns `false` makes mint/transfer/buy throw `PolicyError("IDENTITY_NOT_VERIFIED")`; returns `true` ⇒ succeeds; with the flag off (`false`/absent) `hasVerifiedIdentity` is never consulted and the op succeeds even if the stub would return false. Run → FAIL.

- [ ] **Step 2: Types** (`types.ts`)
- In `UseCaseDefinition.compliance` (the object literal ~line 186), add: `/** Require the receiver to hold a valid, unrevoked identity (KYC) credential. */ requireVerifiedIdentity?: boolean;`
- In `ComplianceProvider` (line 257), add a method: `/** True iff the account's user holds a valid, unrevoked identity (KYC) credential. */ hasVerifiedIdentity(account: string): Promise<boolean>;`

- [ ] **Step 3: Engine enforcement** (`lifecycle-engine.ts`)
- Add a private method beside `requireJurisdiction` (~line 463):
```ts
private async requireVerifiedIdentity(useCase: UseCaseDefinition, to: string): Promise<void> {
  if (!useCase.compliance.requireVerifiedIdentity || !this.compliance) return;
  const ok = await this.compliance.hasVerifiedIdentity(to);
  if (!ok) {
    throw new PolicyError(
      "IDENTITY_NOT_VERIFIED",
      `account '${to}' has no valid verified identity (DID/VC) credential`,
      { useCase: useCase.key, account: to },
    );
  }
}
```
- Immediately after EACH of the 6 `await this.requireJurisdiction(useCase, to);` calls (lines 144, 157, 185, 250, 275, 288 — verify by grep), add `await this.requireVerifiedIdentity(useCase, to);`. (Keeping them adjacent means the identity gate fires on exactly the same receive paths as jurisdiction. Do not consolidate the two into one helper unless you replace all 6 sites identically.)

- [ ] **Step 4: Validation** (`validation.ts`, `validateCompliance` ~line 158)
- Add an optional-boolean check: `if (compliance.requireVerifiedIdentity !== undefined && typeof compliance.requireVerifiedIdentity !== "boolean") fail(\`use case '${key}' compliance.requireVerifiedIdentity must be a boolean\`);`

- [ ] **Step 5: Fix core test stubs**
- Adding a required method to `ComplianceProvider` breaks any existing test that constructs a provider literal. Grep `ComplianceProvider` / `jurisdictionOf:` in `packages/core/test` and add `hasVerifiedIdentity: async () => true` (or the case-appropriate value) to each stub. Engine tests that leave `compliance` undefined are unaffected.

- [ ] **Step 6: Run + commit**
- `pnpm -s --filter @tokenlayer/core test` green; `typecheck` clean. Commit: `feat(core): compliance.requireVerifiedIdentity gate + ComplianceProvider.hasVerifiedIdentity`.

---

## Task H2: API — ComplianceProvider.hasVerifiedIdentity impl + wiring

**Files:**
- Modify: `apps/api/src/compliance-provider.ts` (deps + impl)
- Modify: `apps/api/src/context.ts:113` (pass `credentials` into `createComplianceProvider`)
- Test: `apps/api/test/identity-gate.test.ts` (new)

- [ ] **Step 1: Failing test**

Model on the existing jurisdiction/compliance API tests. Setup: create a tokenization use case with `compliance.requireVerifiedIdentity: true` (a fungible/DvP one so `buy` is exercised — reuse the `generic-asset` or an invoice config with the flag added), onboard a buyer with a wallet + a DID, credit cash, allowlist. Cases:
- Buyer holds an unrevoked `KycCredential` (issue one via the identity path — reuse the credential-issuance test helper / `credentials` repo directly in-test) → `buy` succeeds.
- Buyer holds none → `buy` fails with `IDENTITY_NOT_VERIFIED` (4xx).
- Buyer's `KycCredential` is revoked (`credentials.setRevoked`) → `buy` fails `IDENTITY_NOT_VERIFIED`.
- Flag off → the same buyer with no KYC VC can buy (back-compat).
Run → FAIL.

- [ ] **Step 2: Impl** (`compliance-provider.ts`)
- Extend `ComplianceProviderDeps`: add `credentials: CredentialRepository;` (import the type from `./persistence/types.js`).
- In the returned object add:
```ts
async hasVerifiedIdentity(account: string): Promise<boolean> {
  const acct = (await accounts.list()).find((a) => a.address === account);
  if (!acct) return false;
  const user = (await users.list()).find((u) => u.accountId === acct.id);
  if (!user?.did) return false;
  const held = await credentials.listByHolder(user.did);
  return held.some((c) => !c.revoked && c.type.includes("KycCredential"));
}
```
Confirm `CredentialRecord.type` holds the credential type string and how "KycCredential" appears (grep an existing check — e2e uses `c.type.includes("KycCredential")`). Adjust the predicate to the real shape (exact match vs includes).

- [ ] **Step 3: Wire** (`context.ts:113`)
- The provider is built as `createComplianceProvider({ audit, users: complianceRepos.users, accounts: complianceRepos.accounts })`. Add `credentials: <the credentials repo on deps/complianceRepos>` (grep how `credentials` is constructed in context.ts — it's the ID-A/B/C credential repo). Ensure every `createComplianceProvider` call passes it (there is one real site + confirm no others via grep).

- [ ] **Step 4: Run + commit** — api suite green (new + existing). `feat(api): hasVerifiedIdentity via held KYC credential + revocation`.

---

## Task H3: Web — builder compliance toggle + config + error surfacing

**Files:**
- Modify: `apps/web/src/types.ts` (UseCase compliance type)
- Modify: `apps/web/src/components/UseCaseBuilder.tsx` (compliance editor)
- Modify wherever the buy/issue error is surfaced (grep `JURISDICTION_NOT_ALLOWED` / the AssetDetail buy handler) to render `IDENTITY_NOT_VERIFIED` nicely.

- [ ] **Step 1: types** — add `requireVerifiedIdentity?: boolean` to the web `UseCase`/config `compliance` type (find it in types.ts near `allowlist`/`allowedJurisdictions`).

- [ ] **Step 2: builder** — in `UseCaseBuilder.tsx`'s compliance section (grep `allowlist`/`transferRestrictions` checkboxes), add a **"Require verified identity (DID/VC)"** checkbox bound to `compliance.requireVerifiedIdentity`, with helper text ("Only holders with a valid KYC credential may receive this asset."). Ensure it's included in the POSTed config and shown in any compliance summary/read view.

- [ ] **Step 3: error surface** — where a failed `buy` (and issue) error is displayed (AssetDetail / InvestorPortal buy handler), map `IDENTITY_NOT_VERIFIED` to a clear message ("This asset requires a verified DID/VC identity — you need a valid KYC credential to participate.").

- [ ] **Step 4: run + commit** — `pnpm -s --filter @tokenlayer/web typecheck` clean; `build` succeeds. `feat(web): tokenization compliance 'require verified identity' toggle + error`.

---

## Task H4: Verify — suites + live walkthrough + finish

- [ ] `pnpm -s typecheck` (5 pkgs); `pnpm -s --filter @tokenlayer/core test`; `pnpm -s --filter @tokenlayer/api test`; `pnpm -s --filter @tokenlayer/web build`. All green.
- [ ] **Live walkthrough** (fast-boot: throwaway DB, `CHAIN_STRICT=0`, no chain env): create/configure a tokenization use case with **Require verified identity** on; onboard a buyer (wallet, no KYC VC), credit cash, allowlist, attempt buy → refused with the identity message; issue that buyer a `KycCredential` via the identity desk (ID-B/F) or the identity-mint/verify flow; retry buy → succeeds; (optional) revoke the credential → buy refused again. Screenshots.
- [ ] **Final review** — whole-implementation review (spec compliance + quality; focus: the gate fires on all receive paths, flag-off is a true no-op, revocation is honored, no bypass via a wallet with no linked user). Fix findings.
- [ ] **Finish** — `superpowers:finishing-a-development-branch` (merge `feat/tokenization-identity-gate` to main).

---

## Notes / risks

- **Back-compat is the headline invariant**: with the flag off/absent, `hasVerifiedIdentity` must never be consulted — every existing compliance test must stay green untouched. The `if (!useCase.compliance.requireVerifiedIdentity ...) return;` guard is load-bearing.
- **Adding a required method to `ComplianceProvider`** breaks provider literals in tests — H1 Step 5 must fix every core stub; H2 the api impl. `tsc` will surface any missed one.
- **`c.type.includes("KycCredential")`** — verify the stored credential-type shape; a use-case-issued credential type is arbitrary, but the built-in identity KYC is `KycCredential`. The gate is specifically the KYC identity credential (per the simple-toggle decision).
- **Receiver with no linked user/DID** (e.g. an external wallet) ⇒ `hasVerifiedIdentity` returns false ⇒ refused. That is correct for a gated asset (unverifiable receiver).
- **Enforcement points**: exactly the 6 `requireJurisdiction` sites — do not add the gate to sender-side or issuance-desk paths (out of scope).
