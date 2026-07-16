# Richer VC Issuance + Maker-Checker Approval — Design

**Date:** 2026-07-16
**Status:** Approved (brainstorm decisions locked with user)
**Predecessor:** `2026-07-11-organizations-identity-design.md` (sub-project #1, merged)
**Reference:** `~/did-vc-project` — we take the *shape* of its request/approve flow and deliberately
reject its crypto, its broken stage machine, and its free-form type vocabulary (see "What we reject").

## Goal

Sub-project #2 of four. Orgs can issue a **catalog of real credential types** to subjects, gated by
**per-type maker-checker approval**, and can **revoke** them with a reason. First-class credential
types replace the single self-issued `OrganizationMembership` from #1.

## Locked decisions

1. **Compliance-driving credential set** — `KycCredential`, `AccreditedInvestor`, `AuthorizedSignatory`
   (not the reference repo's India trade-finance set, which presumes government issuers we lack).
2. **Refactor the existing Proposal system to be scope-agnostic** rather than building a second
   approval flow — reuse its concurrency core, extract its three token-coupled seams.
3. **Off-ledger revocation now** — with a mandatory reason + maker-checker + a `credentialStatus`
   pointer on issued VCs. On-chain anchoring stays in #4.
4. **Issue only; compliance does NOT consume VCs yet** — rewiring a fail-closed compliance path to a
   new source of truth is its own cycle.
5. **Per-type configurable approval depth** — the registry declares `requiredApprovals` per type.
6. **The registry declares allowed issuer orgTypes** — signed by the issuing org's parent DID.

## What we reject from the reference repo (and why)

Recorded so the implementation does not "helpfully" reintroduce these:

- **HMAC-as-signature.** It signs with `crypto.createHmac('sha256', privateKeyBytes)` while declaring
  `type: 'EcdsaSecp256k1Signature2019'`. HMAC is symmetric, so verification needs the issuer's private
  key — no third party can verify those VCs. Two of its paths HMAC only `{id, holderDid}`, leaving
  `credentialSubject` uncovered by the proof. We keep real Ed25519 over the full payload via
  `identity.ts`, and every proof/status type name we emit must be honest.
- **The two-status stage machine.** Its `status` (draft|pending|approved|rejected) + `corp_status`
  (submitted|maker_reviewed|checker_approved|signatory_approved) split exists to hide drafts from an
  *external* issuer. Here the issuing org IS the approving org, so there is nothing to hide: **one
  status**. Its chain is also broken as built — `'submitted'` is never written, and the signatory stage
  is unreachable because the checker already flipped `status` to `'pending'`. We ship no dead stages.
- **No segregation of duties.** Its VC flow never compares approver to requester, and `super_admin`
  bypasses every gate. We reuse our existing `SELF_APPROVAL` rule; **no role bypasses a gated op**.
- **Free-form types + unvalidated claims.** `credential_type VARCHAR(100)` with no registry, and
  `credentialSubject: { ...request_data }` spread unvalidated. We ship a typed registry with a claim
  schema per type.
- **Revocation with no approval, no reason, no transaction.** Its issue path nominally needs
  maker+checker but *anyone* may revoke, with no reason recorded. We gate revocation the same way and
  require a reason.

## Core (`packages/core`)

### `credential-types.ts` (new)

A declarative catalog — the piece the reference repo lacks entirely. Modelled on the one good
centralised vocabulary in that codebase (`permissions.ts`'s `PERMISSION_CATALOG`).

```ts
export type CredentialType = "KycCredential" | "AccreditedInvestor" | "AuthorizedSignatory";

export interface CredentialTypeDefinition {
  type: CredentialType;
  description: string;
  /** orgTypes permitted to issue this credential. */
  allowedIssuerOrgTypes: OrgType[];
  /** Approvals required before issuance/revocation (>= 1). */
  requiredApprovals: number;
  /** Per-type claim validation — reuses the existing MetadataSchema. */
  claimSchema: MetadataSchema;
  validityDays: number;
  /** When true, the issuing org must be the subject's own org. */
  selfIssuedOnly?: boolean;
}

export const CREDENTIAL_TYPES: Record<CredentialType, CredentialTypeDefinition>;
export function credentialTypeDef(type: string): CredentialTypeDefinition; // throws PolicyError UNKNOWN_CREDENTIAL_TYPE
```

**Key reuse:** `validateMetadata(claims, def.claimSchema)` is already exported from `@tokenlayer/core`
(`validation.ts:283`) and already supports enums, min/max, patterns and required fields. Per-type claim
validation needs **no new validation code**, and it closes the reference repo's unvalidated-claims hole.

`OrgType` (`bank|corporate|msme|government|verifier`) currently lives in `apps/api/src/persistence/
types.ts`. It moves to `packages/core/src/types.ts` so the registry can reference it; the API re-exports
it to avoid churn at existing import sites.

The catalog:

| Type | Issuers | Approvals | Claims | Validity |
|---|---|---|---|---|
| `KycCredential` | verifier, bank, government | 1 | `legalName` (req), `country` (req, 2-letter pattern), `idType?`, `idNumber?` | 365d |
| `AccreditedInvestor` | verifier, bank | 1 | `basis` (req, enum: `income`\|`net-worth`\|`professional`), `jurisdiction` (req) | 365d |
| `AuthorizedSignatory` | any org (`selfIssuedOnly`) | 2 | `role` (req), `scope` (req, enum: `issuance`\|`treasury`\|`all`) | 365d |

`AuthorizedSignatory` earns 2 approvals because it declares who may act for the org — the highest-stakes
claim in the set. `OrganizationMembership` (#1) stays outside the registry: it is minted automatically
on member creation and is not requestable.

## API (`apps/api`)

### Proposal refactor — `proposal-kinds.ts` (new)

The Proposal persistence layer is already generic and stays untouched: `claimDecided`'s one-shot CAS,
`addApproval`'s optimistic-retry append, the `SELF_APPROVAL` rule, and execution under the proposer's
identity. Everything *above* it is token-coupled in exactly three places. Extract them into a registry:

```ts
export interface ProposalKindHandler {
  kind: string;
  /** Scoping strategy — use-case for token ops, org for credential ops. */
  canView(deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean>;
  /** Eligibility to approve — replaces the closed CAPABILITY_FOR map. */
  canApprove(deps: AppDeps, claims: TokenClaims, p: ProposalRecord): Promise<boolean>;
  /** Side effect on threshold — replaces executeProposal's if/else token fallback. */
  execute(deps: AppDeps, proposer: Actor, p: ProposalRecord): Promise<void>;
}
export function proposalKind(kind: string): ProposalKindHandler; // throws on unknown
```

Registered handlers:
- **Token kinds** (`issue`, `mint`, `transfer`, `burn`, `freeze`, `unfreeze`, `cashflow-execute`) —
  `canView` = `scopedToCaller(claims, p.useCaseKey)`; `canApprove` = the existing `CAPABILITY_FOR` +
  `deps.rbac.can`; `execute` = the existing `executeIssueActivation`/`executeCashflowCore`/
  `runGatedAction` bodies, moved verbatim. **Behaviour must be identical** — the existing token-proposal
  tests are the gate.
- **`issue-credential`** — `canView`/`canApprove` = org-scoped (`PlatformAdmin`, or an `OrgAdmin` of
  `p.orgId`); `execute` = issue + persist the VC (below).
- **`revoke-credential`** — same scoping; `execute` = mark revoked with reason/at/by.

`executeProposal`'s dispatch becomes `proposalKind(p.kind).execute(...)` — a registry lookup that
**throws on an unknown kind** instead of silently falling through to the token branch.

### Persistence

`Proposal`: `useCaseKey String?` (was NOT NULL), add `orgId String?`, add `@@index([orgId, status])`.
Existing `@@index([useCaseKey, status])` stays. `ProposalRecord.useCaseKey` becomes `string | null`.
`ProposalRepository` gains `listByOrg(orgId, status?)`.

`Credential`: add `revokedAt DateTime?`, `revokedReason String?`, `revokedBy String?`, and
`proposalId String?` (provenance: which approved request produced it). `CredentialRepository.create`
accepts an **explicit `id`** (see the chicken-and-egg note below) and gains
`revoke(id, { reason, by, at })`.

### Keystore

`issueMembershipCredential` generalizes to:

```ts
issueOrgCredential(input: {
  orgEncSeed: string; orgDid: string; subjectDid: string;
  type: string; claims: Record<string, unknown>;
  credentialId: string; statusUrl: string;
  validityDays: number; now: number;
}): { vcJwt: string; expiresAt: number }
```

It sets `jti` to `credentialId`, `vc.type = ["VerifiableCredential", type]`, and
`vc.credentialStatus = { id: statusUrl, type: "SimpleRevocationStatus2024" }`.
`issueMembershipCredential` becomes a thin wrapper over it (365d, type `OrganizationMembership`, no
status pointer) so #1's two call sites and its tests are unaffected.

**Chicken-and-egg:** `credentialStatus.id` must contain the credential's id, but the VC is signed before
the row exists. The executor therefore **generates the id first** (`randomUUID()`), embeds it in both
`jti` and the status URL, signs, then creates the row with that explicit id. This is why
`CredentialRepository.create` must accept an id.

**`credentialStatus` honesty:** `SimpleRevocationStatus2024` is **our own non-standard type**, not
StatusList2021 and not to be labelled as such. It resolves via `GET /credentials/:id/status` →
`{ revoked, revokedAt, reason }`. Sub-project #4 replaces it with a real on-chain status list.

### Routes

- `GET /credential-types` (auth read) — the catalog for UI form rendering (type, description, claim
  schema, requiredApprovals, allowedIssuerOrgTypes).
- `POST /credentials/requests` (PlatformAdmin or OrgAdmin) `{ type, subjectUserId, claims, issuerOrgId? }`
  → the issuing org is `claims.orgId` for an OrgAdmin (any `issuerOrgId` in the body is **ignored**, not
  honoured — an OrgAdmin may only ever issue as their own org); a PlatformAdmin has no `orgId` and so
  **must** supply `issuerOrgId` (400 `ISSUER_ORG_REQUIRED` if absent). Then, in order:
  404 unknown subject · 400 `UNKNOWN_CREDENTIAL_TYPE` · 403 `ISSUER_NOT_PERMITTED` (org's orgType not in
  `allowedIssuerOrgTypes`) · 403 `SELF_ISSUED_ONLY` (selfIssuedOnly and subject is not in the issuing
  org) · 400 `VALIDATION_ERROR` (claims fail `validateMetadata`) · 400 `SUBJECT_HAS_NO_DID`.
  Creates a Proposal `{ kind: "issue-credential", orgId, useCaseKey: null, required: def.requiredApprovals }`
  → **202** with the proposal. (Every type has `requiredApprovals >= 1`, so issuance is always gated —
  there is no unapproved path.)
- `POST /credentials/:id/revoke` `{ reason }` (required, non-empty) → **only the issuing org may revoke**:
  the proposal's `orgId` is the org whose parent DID is the credential's `issuerDid`, and the caller must
  be a PlatformAdmin or that org's OrgAdmin (else 403). `required` comes from the *credential's own type*
  definition (`credentialTypeDef(credential.type).requiredApprovals`), so revoking an
  `AuthorizedSignatory` needs the same 2 approvals that issuing it did. → 202. 409 if already revoked.
- `GET /credentials/:id/status` (**public, no auth** — a verifier must resolve it) →
  `{ revoked, revokedAt, reason }`. 404 unknown. Returns no claims, no holder, no VC: revocation state only.
- `GET /orgs/:id/credentials` (org-scoped) — credentials issued BY this org.
- Approval reuses the **existing** `POST /proposals/:id/approve` + `/reject` and `GET /proposals`.
  `GET /proposals` returns the union of the caller's use-case-scoped and org-scoped proposals (both
  indexed) instead of forcing the `__none__` sentinel that made org proposals invisible.

`/me/credentials` (#1) gains `revoked`/`revokedAt`/`revokedReason` in its projection.

## Data flow / trust

A holder presents a VC; a verifier resolves the issuer's `did:key` from the `iss` string alone and
checks the Ed25519 signature (already true in #1), then dereferences `credentialStatus.id` to check
revocation. The issuing org's parent DID is the cryptographic identity — individual approvers never
appear as `iss`; they appear in the Proposal's approval trail, which is the auditable record of *who*
authorised issuance.

## Error handling

- Unknown credential type → 400 `UNKNOWN_CREDENTIAL_TYPE`; claims failing the schema → 400 with the
  field-level detail `validateMetadata` already produces.
- Issuer org lacks the orgType → 403 `ISSUER_NOT_PERMITTED`; cross-org → 403 (never a 404 leak).
- Proposer approving their own request → the existing 403 `SELF_APPROVAL`. No role bypasses it.
- Signing/persistence failure during `execute` → the proposal goes `failed` with the coded error (the
  existing executor contract); no partial credential row.
- Revoking an already-revoked credential → 409.

## Testing

- **Core** (`packages/core/test/credential-types.test.ts`): every catalog entry has a valid schema and
  `requiredApprovals >= 1`; `credentialTypeDef` throws on unknown; per-type claim validation accepts a
  good claim set and rejects a bad one (missing required, bad enum, bad country pattern).
- **API** (`apps/api/test/credential-issuance.test.ts`): request → approve → VC issued, signature
  verifies against the **issuer org's** DID, `credentialSubject.id` is the subject's sub-DID, and
  `jti === credential.id`; wrong issuer orgType → 403; bad claims → 400; `AuthorizedSignatory` needs 2
  distinct approvers (1 approval leaves it pending); self-approval → 403; an OrgAdmin of another org can
  neither see nor approve the proposal; revoke requires a reason and flips `/credentials/:id/status`;
  the status endpoint is reachable **without a token**; `/me/credentials` shows revoked state.
- **Regression (the refactor's real risk):** every existing token-proposal test in
  `approvals.test.ts` must stay green unchanged — that is the proof the seam extraction preserved
  behaviour. Full suite (376 today) stays green.
- **Live E2E** (`scripts/credential-issuance-e2e.mjs`): a verifier org issues a KycCredential to a
  bank's member through the real approval chain; a 2-approval AuthorizedSignatory; independent
  signature verification against the issuer DID outside the API; revoke → status flips; cross-org
  isolation.
- **Browser**: the Approvals inbox (mounted for the first time), request a credential from Members,
  approve it, see it in the subject's "My identity", revoke it and see the state change.

## Web (`apps/web`)

- **Mount `ApprovalsPanel`** — it exists but is imported nowhere, so the maker-checker UI has never been
  reachable. Drop its `useCase` prop (it keys its reload on `useCase.key`) so it lists everything the
  caller may view; add `summarize()` arms for `issue-credential` / `revoke-credential`. Surface it as an
  **Approvals** section for any user who can approve.
- **Organizations → Members**: "Issue credential" — a type picker driven by `GET /credential-types`,
  with the claim form rendered from the type's `claimSchema` (the same schema-driven rendering
  `IssuePanel` already does for use-case metadata).
- **Organizations → Credentials**: credentials issued by the org, with a Revoke action (reason required).
- **My identity**: already lists held credentials; add the revoked/expired state and the credential type.
- Client: `credentialTypes`, `requestCredential`, `orgCredentials`, `revokeCredential`,
  `credentialStatus` + types.

## Out of scope (later sub-projects)

Compliance consuming VCs (deferred by decision #4 — its own cycle) · verifier request/presentation +
selective disclosure + credential sharing (#3) · on-chain DIDRegistry/VCRegistry + StatusList anchoring,
replacing `SimpleRevocationStatus2024` (#4) · external/government issuers (MCA/GSTN) · credential
renewal/re-issuance.
