# Asset Due Diligence & Listing — Design

**Status:** approved by user 2026-09-05, pending spec self-review sign-off
**Scope:** real due-diligence documents on an asset, a maker-checker review workflow before it can be bought, risk classification, and a curated investor-facing display. This is the second of the two remaining sub-projects from the original three-item request (email integration and KYC are both already shipped).

## Why

Today, issuing an asset is a one-click act: `POST /assets` creates the asset and mints supply synchronously unless the use case happens to have opted into a generic `workflow.approvals.issue` gate — and even then, an approver sees only sale terms (initial supply, treasury, price), never any diligence material. There is no document concept for an asset at all (only for KYC/KYB), no risk classification, and the asset detail/listing pages show nothing beyond a raw, uncurated dump of the use case's free-form metadata. An investor browsing the marketplace has no prospectus, no legal opinion, no risk signal, and no way to know whether anyone ever reviewed the asset before it went live — exactly the gap KYC closed for user identity, now open on the asset side.

## Non-goals

- Automated document verification (OCR, fact-checking, fraud detection) — review is entirely human, mirroring KYC's human-only PEP declaration.
- Risk tier driving any automatic behavior (buy limits, auto-freeze, tier-gated visibility) — it is a signal for investors and admins to act on manually, the same posture KYC took with its own risk tier. Automated enforcement is a reasonable future follow-up, explicitly deferred.
- Changing the secondary market (`ListingRecord`/take flow) in any way — the review gate applies to *primary issuance* only. An already-approved asset's secondary-market resale works exactly as today.
- Forced retroactive review of already-issued assets — explicitly grandfathered; the new requirement only applies to assets created after this ships.
- Removing or repurposing the existing per-use-case `workflow.approvals.issue` flag — it becomes redundant for issuance (the new gate is always-on and strictly stronger) but is left alone as out-of-scope cleanup, since other code may still reference it.
- A fixed, closed taxonomy of due-diligence document types beyond the two named slots below — anything past a prospectus and a legal opinion is free-form, issuer-labeled.

## A. Data model

`Asset` gains a new nullable column, `dueDiligence String?` (JSON-encoded, the same convention `metadata` already uses on this same table) — **this requires a Prisma migration**, unlike `KycDetails`, which only ever extended an existing JSON column (`User.kyc`). `Asset` has no equivalent general-purpose JSON column to reuse; `metadata` is already spoken for (it is the use case's own `metadataSchema`-validated free-form data, and mixing due-diligence fields into it would pollute investor-facing metadata display and complicate that validation).

```ts
export interface AssetDueDiligence {
  prospectus?: { id: string; sha256: string } | null;      // named slot
  legalOpinion?: { id: string; sha256: string } | null;    // named slot
  additionalDocuments?: { id: string; sha256: string; label: string }[]; // open-ended, issuer-labeled
  riskTier?: "low" | "medium" | "high" | null;   // set by the reviewer on approval
  reviewedBy?: string | null;                    // the approving UseCaseAdmin's user id
  reviewedAt?: string | null;
  rejectionReason?: string | null;               // set by the reviewer on rejection
}
```

All fields optional. `AssetRecord` (`apps/api/src/persistence/types/tokenization.ts`) gains `dueDiligence?: AssetDueDiligence | null`, round-tripped via `JSON.stringify`/`JSON.parse` the same way `metadata` already is in the Prisma repository layer.

## B. Document storage

Reuse the existing `Document` table exactly as KYC did: widen `DocumentPurpose` (`apps/api/src/persistence/types/shared.ts`) from `"brand-logo" | "kyc"` to add `"asset-diligence"`. `storeUploadedDocument` is reused unchanged.

- `POST /assets/:id/diligence/documents` — the Issuer (or anyone who can administer the asset's use case) uploads one document at a time, specifying which slot it fills: `{ slot: "prospectus" | "legalOpinion" | "additional", label?: string }` (`label` required and free-text when `slot: "additional"`). Stored with `ownerOrgId` = the use case's owning org, `purpose: "asset-diligence"`, `uploadedBy: claims.id`.
- A read path scoped to **anyone who can see the asset at all** — unlike KYC's uploader-or-PlatformAdmin gate, due-diligence documents exist to be read by prospective investors, not kept private. The gate is: the asset is visible to this caller under the same rule that already governs `GET /assets/:id` (use-case membership / marketplace visibility), **regardless of the asset's approval status** for the asset's own use case's Issuer/UseCaseAdmin (so a reviewer can see documents on a still-pending asset), but only for `status: "active"` assets for an ordinary buyer (a pending or rejected asset's diligence package is not yet public). This is a **new, dedicated gate** — not a reuse of `canReadDoc`/the `"issue"` RBAC flag, following the exact lesson KYC's own design already learned from this codebase's history.
- `GET /documents/:id` (the generic, ownership-free route) gets a third refusal branch: `if (doc.purpose === "asset-diligence") return 403`, directing callers to the dedicated route above — mirroring the existing `"kyc"` refusal already in that handler.

## C. Submission flow

Both new routes below carry the same `authScoped("assets:issue")` gate `POST /assets` already uses — deliberately consistent with today's issuance authorization rather than introducing a second standard, and because this platform has real API-key-driven issuance pipelines (e.g. the invoice-register's ERP pull) that this feature must not silently lock out. Section D's review/decision routes are a different matter: those follow KYC's `apiScope: null` posture (no API key may ever decide a review), since a decision is a governance act a machine should never be trusted to make, whereas assembling and submitting a paperwork package is not.

Issuance becomes a two-phase act, reusing the existing gated-issuance machinery this codebase already has (today conditional on `workflow.approvals.issue`; from here on, unconditional):

- `POST /assets` creates the `AssetRecord` at `status: "pending_approval"` for **every** new asset — no supply is minted yet. (Today this only happens for use cases that opted into the old gate; that opt-in becomes moot going forward since the new gate always applies.)
- `POST /assets/:id/diligence/documents` (section B) attaches documents to the pending asset, any number of times, in any order.
- `POST /assets/:id/submit-for-review` — the Issuer's explicit "ready for review" action. Requires at least the `prospectus` slot to be filled (the legal opinion and additional documents are optional, per the chosen document-type scope); a 400 `PROSPECTUS_REQUIRED` otherwise. Available whether this is a first-time submission or a resubmission after rejection — same endpoint, same validation, every time (matching KYC's own resubmission posture). This drafts the `asset-review` proposal described in section D.

No proposal is created at document-upload time — attaching documents is a self-service act on the issuer's own pending asset; submitting for review is where maker-checker applies.

## D. Review workflow

A new proposal kind, `"asset-review"`, following the exact pattern already used for `kyc-decision`, `org-capability-change`, and this codebase's existing `issue` kind:

- **Payload:** `{ assetId: string, decision: "approved" | "rejected", riskTier?: "low" | "medium" | "high", rejectionReason?: string }`.
- **`apiScope`:** `null` — no API key may ever decide an asset review, matching every other governance-shaped decision in this codebase.
- **`canView`/`canApprove`:** a **UseCaseAdmin scoped to the asset's own use case** (`claims.useCaseKey === asset.useCaseKey && claims.role === "UseCaseAdmin"`) — deliberately narrower than PlatformAdmin-wide, per the explicit choice to keep this decision at the use-case level rather than centralizing it like KYC.
- **Approval count:** `required: 1`. The existing generic `SELF_APPROVAL` rule (enforced at the `/proposals/:id/approve` route, proposer ≠ approver) already prevents the Issuer who proposed from also being the one UseCaseAdmin who decides — no extra check needed, and no requirement that a use case have more than one UseCaseAdmin, since the Issuer and UseCaseAdmin are already different roles/people in every case this applies to.
- **`execute`:** re-checks the asset is still `status === "pending_approval"` at execution time (the same re-assert-before-mutate pattern `kyc-kinds.ts` and the existing `issueKind` both already use, guarding against a race between propose and approve). On approval: sets `dueDiligence.riskTier`, `reviewedBy`, `reviewedAt` (clearing any stale `rejectionReason`), mints the initial supply and applies sale terms by reusing the existing `executeIssueActivation` path, and flips `status: "active"`. On rejection: sets `dueDiligence.rejectionReason` (clearing any stale `riskTier`/`reviewedBy`/`reviewedAt`), flips `status: "rejected"`, mints nothing.
- **Notification:** reuses `createProposalAndNotify` (best-effort email to the relevant UseCaseAdmin(s)) the same way `kyc-decision` does, plus a new decision-notification email to the Issuer mirroring `kycDecisionEmail`'s shape.

A pending or rejected asset is frozen from buy/list/secondary-market actions, exactly as `status: "pending_approval"` already is today for gated use cases.

## E. Listing & detail display

- **Asset detail page** (`AssetDetail.tsx`): a new "Due Diligence" panel placed above the existing raw-metadata grid, showing the prospectus and legal opinion as named download links, any additional documents with their labels, and a risk-tier badge once reviewed (or a "Pending review" / "Rejected — \<reason\>" status banner otherwise, mirroring the existing `pending_approval`/`rejected` banners already on this page). Documents open via the authenticated-fetch-to-blob-URL pattern established by KYC's `KycReviewPanel` (`API_BASE` + Bearer token, a synchronously-opened window to avoid popup blockers) — never a plain `<a href>`.
- **Asset Ledger / list table** (`AssetList.tsx`): a new risk-tier column (Low/Medium/High badge, or "Pending review" while `status === "pending_approval"`), next to the existing availability pill.
- **A "Review Assets" screen for UseCaseAdmins**, filtered to their own use case's `pending_approval` assets, mirroring `UserManagement.tsx`'s inline-expand `KycReviewPanel` pattern: the full diligence package (documents + any existing metadata) plus propose-approve/reject controls with a required-reason field for rejection.
- **`ApprovalsPanel.tsx`** gains a `summarize()` case for `"asset-review"`, mirroring the existing `"kyc-decision"` case exactly.

## Testing

- Unit/API tests for `POST /assets/:id/diligence/documents`: happy path (each slot fills correctly); rejects a document upload from someone who isn't the asset's issuer/use-case staff.
- `POST /assets/:id/submit-for-review`: 400 `PROSPECTUS_REQUIRED` when no prospectus is attached; succeeds and drafts an `asset-review` proposal once one is; works identically on a resubmission after rejection.
- The document read gate: a UseCaseAdmin/Issuer of the asset's own use case can read a still-pending asset's documents; an ordinary buyer cannot read a pending or rejected asset's documents but can once it is `active`; the generic `GET /documents/:id` refuses an `asset-diligence`-purposed document outright.
- The `asset-review` proposal kind: propose→approve sets `active` + `riskTier` + mints supply/applies sale terms; propose→reject sets `rejected` + `rejectionReason` and mints nothing; a UseCaseAdmin from a *different* use case cannot propose or approve; the proposing Issuer cannot also approve (SELF_APPROVAL).
- A pending or rejected asset is refused by the existing buy/list/secondary-market routes, exactly as `pending_approval` already is today.
- An asset issued before this ships (no `dueDiligence` field at all) continues to work on every existing route with no behavior change.
