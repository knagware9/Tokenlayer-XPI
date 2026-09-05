# KYC Enhancement — Design

**Status:** approved by user 2026-09-05, pending spec self-review sign-off
**Scope:** richer KYC data, real document upload, a maker-checker review workflow, and risk tiering + expiry. This is the second of three sub-projects requested together (asset due-diligence/listing is the third, separate, later spec).

## Why

Today's KYC is a flat, admin-attested `kyc` object (legal name, country, ID type/number, a free-text `documentRef` string with nothing behind it) and a binary `kycStatus` that a single PlatformAdmin flips with one `PATCH /users/:id` call. There is no real document upload, no richer identity/AML fields, no second reviewer, no risk classification, and no expiry — a KYC decision made once, years ago, on unverified self-reported data, never comes up for review again.

## Non-goals

- Automated sanctions/PEP screening against a third-party watchlist — this adds a self-declared PEP flag only, not automated checking. A real screening integration is a distinct, later project.
- Tier-driven expiry lengths (e.g. High-risk expiring sooner than Low-risk) — the user explicitly chose a single fixed expiry period regardless of tier, to keep the rules engine at zero.
- Forced re-verification of already-approved users — explicitly grandfathered; the new flow only applies going forward.
- Admin-mediated KYC entry (an admin filling in a holder's data on their behalf) — explicitly out of scope; the user chose holder self-service only. Existing admin-attestation paths (VC-based verification, the admin `issue-kyc` endpoint for org-less seeded operators) are untouched, separate mechanisms — this project does not touch them.
- Changing `KycStatus`'s three values (`pending`/`approved`/`rejected`) — unchanged.

## A. Data model

Extend `KycDetails` (`packages/core`'s shared types / `apps/api/src/persistence/types/shared.ts`) with:

```ts
export interface KycDetails {
  // existing fields, unchanged:
  legalName?: string;
  country?: string;
  idType?: string;
  idNumber?: string;
  documentRef?: string;      // legacy free-text reference — kept for old rows, no longer written by new submissions
  issuerDid?: string;
  credentialId?: string;
  verifiedAt?: string;
  revokedAt?: string;
  revokeReason?: string;

  // new fields:
  dateOfBirth?: string;              // ISO date
  address?: { street: string; city: string; postalCode: string };
  occupation?: string;
  sourceOfFunds?: string;
  pepDeclaration?: boolean;          // self-declared, not automated
  idDocument?: { id: string; sha256: string } | null;      // real uploaded document
  addressDocument?: { id: string; sha256: string } | null; // real uploaded document
  riskTier?: "low" | "medium" | "high" | null;   // set by the reviewer on approval
  expiresAt?: string | null;         // ISO date; null = grandfathered / never expires
  rejectionReason?: string | null;   // set by the reviewer on rejection
}
```

All new fields are optional, so existing rows (and the admin-attestation/VC paths, which populate only the original fields) remain valid without a migration.

## B. Document storage

Reuse the existing `Document` table and `storeUploadedDocument` helper — no new table. `DocumentRecord.uploadedBy` already exists for exactly this shape ("an org-less desk operator... references a document they personally uploaded"), so a KYC document is stored with `ownerOrgId: null` (a holder isn't necessarily in an org) and `uploadedBy: claims.id`.

Two new endpoints, classified `shared` (KYC applies to both tokenization and identity domain users):

- `POST /users/me/kyc/documents` — any authenticated human uploads one document (ID or address proof), returns `{ id, sha256, size }`, same shape as the existing KYB upload endpoint.
- A read path scoped to **exactly two audiences**: the uploader themselves, or a PlatformAdmin reviewing the pending submission. This is a **new, dedicated gate** — not a reuse of `canReadDoc`/the `"issue"` RBAC flag, which this codebase has already been burned by overloading once (an unrelated widening of that flag leaked KYB/invoice documents to OrgAdmins earlier in this project's history). The gate is a direct check: `doc.uploadedBy === caller.id || caller.role === "PlatformAdmin"`.

## C. Self-service submission

A new "Complete KYC" panel in My Profile, available to any authenticated human user regardless of role. The holder fills the full field set (existing + new) and uploads both documents, then submits via `POST /users/me/kyc/submit`. This call:

- Validates both documents were uploaded and belong to the caller (`uploadedBy` check).
- Stores the submission into the caller's own `kyc` field and sets `kycStatus: "pending"`.
- Is available whether this is a first-time submission or a re-submission (e.g., after rejection, or after expiry) — same endpoint, same validation, every time.

No proposal is created at submission time — submitting is a self-service act on your own record, not an action requiring maker-checker; the review that follows is where maker-checker applies.

## D. Maker-checker review

A new proposal kind, `"kyc-decision"`, following the exact pattern already used for org approval, credential issuance, and use-case creation elsewhere in this codebase:

- **Payload:** `{ userId: string, decision: "approved" | "rejected", riskTier?: "low" | "medium" | "high", rejectionReason?: string }`.
- **Propose:** any PlatformAdmin, reviewing a `pending` submission, proposes a decision (approve with a risk tier, or reject with a reason — both required for their respective decision).
- **Approve (the second admin):** re-validates the target user is still `pending` (re-check at execution time, mirroring this codebase's standard maker-checker re-check discipline), then applies the decision: on approval, sets `kycStatus: "approved"`, stores the `riskTier`, and computes `expiresAt` as **today + 1 year** (a single fixed period, no per-tier variation, per the approved design); on rejection, sets `kycStatus: "rejected"` and stores the `rejectionReason`.
- **Notification:** reuses the existing `kycDecisionEmail` (already built) — extended to optionally include the rejection reason in its body when one is present.

A new "Pending KYC reviews" screen in the Platform Admin console lists every `pending` submission and, on selecting one, shows the full field set plus both uploaded documents (fetched via the new read-gated endpoint) side by side, with propose-approve/reject actions in place of the old one-click PATCH.

## E. Expiry & re-verification

- `expiresAt` is set **only** by a decision made under this new system — an old, grandfathered `approved` row keeps `expiresAt: null` (meaning "never expires under the old rules") until the day it's re-approved through this flow for any reason (voluntary re-submission, or a future policy decision to force one — out of scope here).
- A new "KYC expiring / expired" list in the Platform Admin console: any user with `kycStatus: "approved"` and a non-null `expiresAt` in the past, or within a configurable warning window (e.g. 30 days) of expiring. This is a read-only list for admins to act on (e.g., contact the holder) — it does not automatically revoke or downgrade `kycStatus` when `expiresAt` passes; expiry is surfaced, not enforced automatically, to avoid silently locking out a holder over an admin oversight. Automatic enforcement is a reasonable future follow-up, explicitly deferred here.

## F. Removing the one-click approve/reject path

`PATCH /users/:id`'s ability to set `kycStatus` directly (`b.kycStatus === "approved" || "rejected"`) is **removed**. Once maker-checker review exists, leaving a single-admin bypass would defeat its purpose. The route keeps setting `password`/`active` as it does today; `kycStatus` is no longer among the fields it accepts — and a request that includes it fails loudly (400) rather than silently applying `password`/`active` while quietly dropping the `kycStatus` the caller asked for, matching this codebase's general preference for an explicit refusal over a silent partial success. The **other** existing paths that set `kycStatus` are untouched, because they are legitimately different mechanisms, not one-click admin shortcuts around review:

- The VC-based self-verification route (`POST /users/:id/identity/verify`) — the holder presents an externally-issued, cryptographically verified credential; trust comes from the credential's issuer, not an admin's click.
- The admin `issue-kyc` attestation endpoint (`POST /users/:id/identity/issue-kyc`) — explicitly for "a seeded operator/investor with no organization onboarding behind them," a narrow operational/demo path, not the general holder-KYC flow this project is improving.
- Any creation-time auto-approval inside onboarding (`onboardSingle`, org-member creation) — these are provisioning-time defaults, not post-hoc review decisions on an already-pending submission, and were explicitly scoped out of the email-notification work for the same reason.

## Testing

- Unit/API tests for `POST /users/me/kyc/submit`: happy path (sets pending, stores all fields); rejects a submission missing a required document; rejects a document reference the caller didn't upload (someone else's `uploadedBy`).
- The new document read gate: uploader can read their own; a different non-admin user cannot; PlatformAdmin can.
- The `kyc-decision` proposal kind: propose→approve sets `approved` + `riskTier` + `expiresAt` (~1 year out); propose→approve with `rejected` sets the reason and no `expiresAt`; a non-PlatformAdmin cannot propose or approve; the same proposer cannot also approve (self-approval block, matching this codebase's standard SoD rule).
- `PATCH /users/:id` no longer accepts `kycStatus` — a request that includes it 400s (rather than silently applying `active`/`password` while dropping `kycStatus`).
- Expiry list: a user with a past `expiresAt` appears; one with a future `expiresAt` outside the warning window does not; a grandfathered `null`-`expiresAt` approved user never appears.
