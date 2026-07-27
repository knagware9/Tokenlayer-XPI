# Identity Domain — Issuer/Holder/Verifier Runtime (ID-B) — Design

**Goal:** Make the ID-A `CredentialUseCase` config *live*. Today it is authored, validated and persisted but **nothing at issue or verify time reads it**. ID-B wires a config-driven runtime on top of the existing DID/VC primitives: a bound **Issuer** issues a configured credential type to a **Holder**'s wallet (via maker-checker), the holder **holds** it (existing My Credentials), and a bound **Verifier** requests a proof and **verifies** it (extending the existing verifiable-presentation flow). The credential type's claim schema, validity and approval depth come from the use case; the Issuer / Holder / Verifier bindings are enforced.

**Program context:** ID-B is sub-project 2 of the 5-part Identity program (one XI app, two pluggable domains — Tokenization + Identity, sharing one core): **ID-A** configurable credential use-case engine (MERGED) · **ID-B** issuer/holder/verifier runtime (this spec) · **ID-C** entity wallet + My Credentials · **ID-D** QR-code login · **ID-E** pluggable domain shell.

**Tech stack:** packages/core (pure resolvers/predicates), apps/api (Fastify + Prisma/SQLite + Vitest — routes, a proposal kind, persistence deltas), apps/web (React + Vite + Tailwind — an issue surface + a verifier picker). Parallels and reuses the existing closed-catalog credential runtime (`credentialTypeDef`, `issueCredentialFor`, the `issue-credential`/`revoke-credential` proposal kinds, the `VerificationRequest` flow, `presentCredentials`/`verifyPresentationCredentials`).

---

## Scope

**In scope (ID-B):**
- A config-driven **issuance** path: a bound issuer issues a configured credential type to an eligible holder, gated by the Issuer + Holder bindings, through **maker-checker** (a new org-scoped proposal kind).
- A per-credential-type **approval depth** (`requiredApprovals`) added to the ID-A config (small extension).
- Config-driven **verification**: the existing verification-request flow made use-case-aware, gated by the Verifier binding.
- **Revocation** of use-case-issued credentials (reuse the existing kind; resolve depth from the use case).
- Core pure functions for the resolver + the three binding predicates.
- Web: an "Issue credential" surface reachable by the bound issuer's operators; a use-case picker on the verifier request form.

**Out of scope (later sub-projects / deferred):**
- **Org-as-holder / entity wallet** (a credential held by an organization's own DID rather than a user's sub-DID) — **ID-C**. In ID-B the holder is always a *user* with a DID whose org satisfies the holder policy.
- Richer My Credentials / wallet UI — **ID-C**. Holder side is left as-is (credentials appear in My Credentials, requests in the consent inbox).
- QR-code login — **ID-D**. Domain selector / per-deployment enablement — **ID-E**.
- Holder-initiated credential *applications* (holder submits evidence, issuer reviews). ID-B issuance is issuer-initiated maker-checker; an application flow is a possible later cycle.
- Per-claim selective disclosure (credentials remain atomic, presented whole — unchanged from the existing VP flow).

---

## Architecture

A **config-driven runtime layered on the existing primitives** — no parallel machinery:

1. **Core** (`packages/core/src/credential-use-cases.ts`) — pure resolver + binding predicates; add `requiredApprovals` to `CredentialTypeSpec`.
2. **Issuance (api)** — a new route `POST /credential-use-cases/:key/credentials` + a new org-scoped proposal kind `issue-usecase-credential`; generalize the `issueCredentialFor` primitive to take an explicit `validityDays`.
3. **Revocation (api)** — reuse the `revoke-credential` kind; stamp the credential's originating use-case key so its depth resolves correctly.
4. **Verification (api)** — extend `VerificationRequestRecord` + `POST /verification-requests` with an optional `credentialUseCaseKey`; gate by the Verifier binding.
5. **Web** — an "Issue credential" panel from a use-case card (Identity nav opened to OrgAdmins); a use-case picker on the verifier request form.

The consuming principle: the runtime resolves the credential type's `claimSchema` / `validityDays` / `requiredApprovals` from the **use case** (not the closed catalog), and enforces the **Issuer / Holder / Verifier** bindings the closed catalog has no notion of.

---

## 1. Config change — approval depth (core)

`CredentialTypeSpec` gains `requiredApprovals: number` (default 1):

```ts
export interface CredentialTypeSpec {
  name: string;
  title: string;
  claimSchema: MetadataSchema;
  validityDays: number;
  requiredApprovals: number;   // NEW — maker-checker depth for issuing this type; >= 1
}
```

- Stored inside the existing `credentialTypes` JSON column — **no Prisma migration**.
- `validateCredentialUseCase` rejects a non-integer or `< 1` `requiredApprovals` (`INVALID_USECASE`).
- `CREDENTIAL_TEMPLATES` entries all set `requiredApprovals: 1`.
- **Backward compatibility:** already-persisted use cases (e.g. the seeded `corp-trade-credentials`) have no `requiredApprovals` in their stored JSON. The resolver (`credentialUseCaseType`) defaults a missing/invalid value to `1`, so existing config keeps working without a data backfill. The web builder writes the field on the next save.

## 2. Core — resolver + binding predicates (pure, no I/O)

New exports in `packages/core/src/credential-use-cases.ts`:

```ts
// Resolve a credential type within a use case by name; throws PolicyError
// UNKNOWN_CREDENTIAL_TYPE if absent. Normalises requiredApprovals to >= 1.
export function credentialUseCaseType(def: CredentialUseCaseDefinition, typeName: string): CredentialTypeSpec;

// May the caller act as this use case's issuer?
//   platform binding -> only the platform issuer org (isPlatformOrg)
//   org binding      -> orgId === binding.orgId
export function issuerBindingAllows(binding: IssuerBinding, ctx: { orgId: string; isPlatformOrg: boolean }): boolean;

// May this holder org hold a credential of this use case?
//   any-onboarded -> true (holderOrg may be null)
//   orgType       -> holderOrg != null && orgTypes.includes(holderOrg.orgType)
//   specific      -> holderOrg != null && orgIds.includes(holderOrg.id)
export function holderPolicyAllows(policy: HolderPolicy, holderOrg: { id: string; orgType: OrgType } | null): boolean;

// May this verifier org request proofs for this use case?
//   any  -> true (any onboarded org)
//   orgs -> orgIds.includes(verifierOrgId)
export function verifierBindingAllows(binding: VerifierBinding, verifierOrgId: string): boolean;
```

Each is a total function over its binding union; unit-tested per branch. The API layer supplies the `isPlatformOrg` / `holderOrg` facts (I/O stays in the route).

## 3. Issuance runtime (api)

**Route:** `POST /credential-use-cases/:key/credentials`, body `{ credentialType: string; subjectUserId: string; claims: Record<string, unknown> }` (schema `additionalProperties:false`).

Handler order (each step maps to one error code):
1. Caller must be PlatformAdmin or OrgAdmin — else `403 FORBIDDEN`.
2. `def = credentialUseCases.get(key)` — else `404 UNKNOWN_USECASE`.
3. Resolve the **issuer org from the binding**: `platform` → the platform issuer org, read by name (`organizations.findByName(PLATFORM_ORG_NAME)` — it is seeded at boot, so this is a pure read, never a write on the request path); `org` → `organizations.get(binding.orgId)` (absent → `400 ISSUER_ORG_MISSING`, a config inconsistency the caller cannot fix but must not 500 on). Establish `isPlatformOrg` (issuer org is the platform org).
4. **Issuer authorization:** PlatformAdmin may act as any bound issuer; an OrgAdmin only when `claims.orgId === issuerOrg.id`. Enforced via `issuerBindingAllows(def.issuer, { orgId: claims.orgId ?? "", isPlatformOrg })` combined with the role check — else `403 ISSUER_NOT_PERMITTED`.
5. `spec = credentialUseCaseType(def, b.credentialType)` — else `400 UNKNOWN_CREDENTIAL_TYPE`.
6. `subject = users.findById(b.subjectUserId)` — else `404` (`UNKNOWN_SUBJECT`); `if (!subject.did)` → `400 SUBJECT_HAS_NO_DID`.
7. **Holder eligibility:** resolve the subject's org (`subject.orgId ? organizations.get : null`), then `holderPolicyAllows(def.holderPolicy, holderOrg)` — else `403 HOLDER_NOT_ELIGIBLE`.
8. `validateMetadata(b.claims, spec.claimSchema)` — else `400 INVALID_METADATA`.
9. Park a proposal: `proposals.create({ useCaseKey: null, orgId: issuerOrg.id, assetId: null, kind: "issue-usecase-credential", payload: { credentialUseCaseKey: key, credentialType, subjectUserId, subjectDid, issuerOrgId: issuerOrg.id, claims }, proposerId, proposerLabel, required: spec.requiredApprovals })`. Return `202 { proposal }`.

**Proposal kind** (`apps/api/src/credential-usecase-kinds.ts`): `issueUsecaseCredentialKind`, **org-scoped** (`canView`/`canApprove = orgScopedView` on `p.orgId` = the issuer org — so the second approver is another operator of that org; for a platform-bound use case that means a second PlatformAdmin). `execute`:
- Re-resolve `def = credentialUseCases.get(payload.credentialUseCaseKey)` and `spec = credentialUseCaseType(def, payload.credentialType)` (config may have changed since propose → fail the proposal cleanly rather than sign stale config); re-resolve `issuerOrg`.
- Call the generalized `issueCredentialFor(deps, { issuerOrg, subjectDid, type: spec.name, claims, validityDays: spec.validityDays, credentialUseCaseKey: key, proposalId: p.id })` — the single sign → on-chain anchor → persist path.

**Generalize the primitive:** `issueCredentialFor`'s args gain an explicit `validityDays: number` and an optional `credentialUseCaseKey?: string | null`. The two existing callers (`POST /credentials/requests` handler and `onboardUserKind`) pass `credentialTypeDef(type).validityDays` and no use-case key — behaviour unchanged. This keeps one issuance primitive (no fork of the sign/anchor/persist logic).

## 4. Revocation (api)

Reuse the existing `POST /credentials/:id/revoke` route + `revoke-credential` proposal kind. The only gap is depth resolution: the route currently does `credentialTypeDef(cred.type).requiredApprovals`, which throws `UNKNOWN_CREDENTIAL_TYPE` for a use-case credential type absent from the closed catalog.

Fix: `CredentialRecord` gains an optional `credentialUseCaseKey: string | null` (Prisma column, nullable — stamped at issuance in §3). The revoke route resolves `required` as: if `cred.credentialUseCaseKey` is set → `credentialUseCaseType(credentialUseCases.get(key), cred.type).requiredApprovals`; else → `credentialTypeDef(cred.type).requiredApprovals`. Everything else (chain-first revoke, org scoping to the issuing org) is unchanged.

## 5. Verification extension (api)

- `VerificationRequestRecord` gains `credentialUseCaseKey: string | null`.
- `POST /verification-requests` body gains optional `credentialUseCaseKey`. When present:
  - Require `claims.orgId` (creating a request is an org action) and resolve `def`; gate via `verifierBindingAllows(def.verifier, claims.orgId)` — else `403 VERIFIER_NOT_PERMITTED`. This **replaces** the global `org.orgType === "verifier"` gate for use-case requests (so `verifier: { kind: "any" }` lets any onboarded org verify, per the binding's meaning).
  - Every `requestedType` must be a `credentialTypes[].name` of `def` — else `400 TYPES_NOT_IN_USECASE`.
  - Persist `credentialUseCaseKey` on the record.
- When **absent**: unchanged — the global verifier-org-type gate still applies (backward compatible with the ID-A/earlier VP flow).
- Consent (`POST /:id/consent`), verify (`GET /:id/verify`), `eligibleCredentials`, and the on-chain trust + revocation composition are **unchanged** — all keyed by `CredentialRecord.type` string equality, which use-case credential type names satisfy (a `CredentialTypeSpec.name` is stored verbatim as the credential's `type`, exactly as catalog type names are today).

## 6. Web

- **Issue credential surface** — a panel opened from a credential-use-case card:
  - credential-type `<select>` (from `def.credentialTypes`),
  - holder `<select>` — users that have a DID, narrowed to holder-policy-eligible (resolved against each user's org),
  - a claims form rendered from the selected type's `claimSchema` (reuse the existing metadata form renderer used by token issuance / the closed-catalog credential form),
  - submit → `POST /credential-use-cases/:key/credentials`; surface the coded error inline; on `202` show "pending approval".
- **Identity nav visible to OrgAdmins** — currently `IdentityHome` is PlatformAdmin-only. Open the Identity area to OrgAdmins (read the list; the "Issue credential" action enabled only where their org is the bound issuer). This is the one nav-gating change; it follows the established rule of adding the item to both `PlatformHome`'s tab list and the role branch that early-returns its own shell (the recurring nav gotcha).
- **Verifier** — the existing verification-request form gains an optional "credential use case" picker; selecting one scopes the requestable types to that use case and sends `credentialUseCaseKey` so the binding gate applies server-side.
- **Holder** — no new UI. Issued credentials appear in My Credentials; verification requests in the existing consent inbox. (Showing the use-case name on a held credential is deferred to ID-C.)

## Data flow

Author (ID-A) configures a credential use case → an operator of the bound **Issuer** opens Issue-credential, picks a type + an eligible holder + fills claims → `POST …/credentials` validates (issuer binding, holder policy, claim schema) and parks a proposal → a second operator of the issuer org approves → `issueCredentialFor` signs (issuer org's custodial key), anchors on-chain, persists → the credential appears in the **Holder**'s My Credentials. Later a bound **Verifier** creates a use-case verification request → the holder consents (signs a VP of their eligible credentials) → the verifier calls verify → trust (on-chain DidRegistry / trustedKycIssuers) + revocation (chain/DB) composed around the pure crypto → structured result.

## Error handling

Coded, HTTP-mapped: `FORBIDDEN` (403), `UNKNOWN_USECASE` (404), `ISSUER_NOT_PERMITTED` (403), `ISSUER_ORG_MISSING` (400/409, config error), `UNKNOWN_CREDENTIAL_TYPE` (400), `UNKNOWN_SUBJECT` (404), `SUBJECT_HAS_NO_DID` (400), `HOLDER_NOT_ELIGIBLE` (403), `INVALID_METADATA` (400) for issuance; `VERIFIER_NOT_PERMITTED` (403), `TYPES_NOT_IN_USECASE` (400) for verification. The web issue/verify forms surface the coded message inline. A proposal whose `execute` re-resolution fails (config deleted/changed) marks the proposal `failed` — never signs stale config.

## Testing

- **core:** `credentialUseCaseType` (found / unknown / missing-`requiredApprovals`-defaults-to-1); `issuerBindingAllows`, `holderPolicyAllows`, `verifierBindingAllows` — each union branch, including null holder org and platform binding.
- **api (behavioural):** issue → approve → credential held by the subject (round-trip via `GET /me/credentials`); each gate rejected independently (wrong issuer → `ISSUER_NOT_PERMITTED`; ineligible holder → `HOLDER_NOT_ELIGIBLE`; bad claims → `INVALID_METADATA`; unknown type → `UNKNOWN_CREDENTIAL_TYPE`); maker-checker depth honored (a `requiredApprovals: 2` type needs two approvals; proposer ≠ approver); a use-case verification request gated by the Verifier binding (allowed org 200, disallowed 403 `VERIFIER_NOT_PERMITTED`; non-use-case type 400); full request → consent → verify of a use-case credential returns `valid:true`, and flips after revocation; revocation depth resolved from the use case.
- **web:** tsc + build; a live-Besu browser walkthrough — issue a credential against the seeded `corp-trade-credentials` use case, approve it, see it in the holder's wallet, then run a verifier request → consent → verify.

## Verification / done

Full suite green (core + api + web tsc/build) with the new tests + a live browser walkthrough of the full issue → approve → hold → verify loop on real Besu, then finish the branch. ID-C (entity wallet) builds on the held credentials this produces.
