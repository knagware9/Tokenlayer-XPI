# Asset Due Diligence & Listing — Design

**Status:** approved by user 2026-09-05, corrected 2026-09-05 (see the note at the top of section D), pending spec self-review sign-off
**Scope:** real due-diligence documents on an asset, a single-UseCaseAdmin review decision before it can be bought, risk classification, and a curated investor-facing display. This is the second of the two remaining sub-projects from the original three-item request (email integration and KYC are both already shipped).

## Why

Today, issuing an asset is a one-click act: `POST /assets` creates the asset and mints supply synchronously unless the use case happens to have opted into a generic `workflow.approvals.issue` gate — and even then, an approver sees only sale terms (initial supply, treasury, price), never any diligence material. There is no document concept for an asset at all (only for KYC/KYB), no risk classification, and the asset detail/listing pages show nothing beyond a raw, uncurated dump of the use case's free-form metadata. An investor browsing the marketplace has no prospectus, no legal opinion, no risk signal, and no way to know whether anyone ever reviewed the asset before it went live — exactly the gap KYC closed for user identity, now open on the asset side.

## Non-goals

- Automated document verification (OCR, fact-checking, fraud detection) — review is entirely human, mirroring KYC's human-only PEP declaration.
- Risk tier driving any automatic behavior (buy limits, auto-freeze, tier-gated visibility) — it is a signal for investors and admins to act on manually, the same posture KYC took with its own risk tier. Automated enforcement is a reasonable future follow-up, explicitly deferred.
- Changing the secondary market (`ListingRecord`/take flow) in any way — the review gate applies to *primary issuance* only. An already-approved asset's secondary-market resale works exactly as today.
- Forced retroactive review of already-issued assets — explicitly grandfathered; the new requirement only applies to assets created after this ships.
- Removing the existing per-use-case `workflow.approvals.issue` flag, its `"issue"` proposal kind, or `proposeIfGated` — none are deleted, and a use case that still has the flag set keeps whatever other effects it has. But for any asset issued after this ships, `issueAssetCore` stops calling `proposeIfGated` for issuance and unconditionally takes the path this feature defines instead (section C) — so `workflow.approvals.issue` becomes **inert for new assets specifically**: due-diligence review is the only gate a new asset goes through, never the old issuance-proposal one, regardless of the flag's value. Running both gates on the same asset would mean two different, uncoordinated approval mechanisms both had to clear it, which is not a design this spec builds. This is a real behavior change for any use case that has the flag set, not a no-op — flagged here precisely so it is not mistaken for a leave-alone.
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
  // The issuer's own requested activation parameters, captured at POST /assets
  // time. `issueAssetCore` already defers minting/sale-terms whenever an asset
  // is created pending — today that deferred data rides inside the old
  // gatedIssue proposal's payload; with no proposal in this design, it has to
  // be stashed somewhere durable until POST /assets/:id/review-decision
  // approves and needs it to call executeIssueActivation. This is the only
  // place that durable storage can live, since `metadata` is investor-facing
  // and must not carry it.
  pendingInitialSupply?: string | null;
  pendingSale?: { unitPrice: string; currency: string } | null;
}
```

All fields optional. `AssetRecord` (`apps/api/src/persistence/types/tokenization.ts`) gains `dueDiligence?: AssetDueDiligence | null`, round-tripped via `JSON.stringify`/`JSON.parse` the same way `metadata` already is in the Prisma repository layer. `AssetRepository` needs a new method to persist changes to it — `setDueDiligence(id: string, dueDiligence: AssetDueDiligence): Promise<void>` — mirroring the existing narrow `setStatus`/`setSaleTerms` methods rather than a general-purpose update.

## B. Document storage

Reuse the existing `Document` table exactly as KYC did: widen `DocumentPurpose` (`apps/api/src/persistence/types/shared.ts`) from `"brand-logo" | "kyc"` to add `"asset-diligence"`. `storeUploadedDocument` is reused unchanged.

- `POST /assets/:id/diligence/documents` — the Issuer (or anyone who can administer the asset's use case) uploads one document at a time, specifying which slot it fills: `{ slot: "prospectus" | "legalOpinion" | "additional", label?: string }` (`label` required and free-text when `slot: "additional"`). Stored with `ownerOrgId` = the use case's owning org, `purpose: "asset-diligence"`, `uploadedBy: claims.id`.
- A read path scoped to **anyone who can see the asset at all** — unlike KYC's uploader-or-PlatformAdmin gate, due-diligence documents exist to be read by prospective investors, not kept private. The gate is: the asset is visible to this caller under the same rule that already governs `GET /assets/:id` (use-case membership / marketplace visibility), **regardless of the asset's approval status** for the asset's own use case's Issuer/UseCaseAdmin (so a reviewer can see documents on a still-pending asset), but only for `status: "active"` assets for an ordinary buyer (a pending or rejected asset's diligence package is not yet public). This is a **new, dedicated gate** — not a reuse of `canReadDoc`/the `"issue"` RBAC flag, following the exact lesson KYC's own design already learned from this codebase's history.
- `GET /documents/:id` (the generic, ownership-free route) gets a third refusal branch: `if (doc.purpose === "asset-diligence") return 403`, directing callers to the dedicated route above — mirroring the existing `"kyc"` refusal already in that handler.

## C. Submission flow

Both new routes below carry the same `authScoped("assets:issue")` gate `POST /assets` already uses — deliberately consistent with today's issuance authorization rather than introducing a second standard, and because this platform has real API-key-driven issuance pipelines (e.g. the invoice-register's ERP pull) that this feature must not silently lock out. Section D's review/decision routes are a different matter: those follow KYC's `apiScope: null` posture (no API key may ever decide a review), since a decision is a governance act a machine should never be trusted to make, whereas assembling and submitting a paperwork package is not.

Issuance becomes a two-phase act. This reuses only the existing **status-freeze** behavior a `pending_approval` asset already gets today (refused by buy/list/secondary-market routes) — not the proposal-based mechanism `workflow.approvals.issue` currently drives, which section D deliberately replaces rather than reuses:

- `POST /assets` creates the `AssetRecord` at `status: "pending_approval"` for **every** new asset — no supply is minted yet. (Today this only happens for use cases that opted into the old gate; that opt-in becomes moot going forward since the new gate always applies.) Any `initialSupply`/`sale` the caller requested is captured into `dueDiligence.pendingInitialSupply`/`pendingSale` (section A) rather than the old gated path's proposal payload, since section D reads it back from there instead of from a proposal.
- `POST /assets/:id/diligence/documents` (section B) attaches documents to the pending asset, any number of times, in any order.
- `POST /assets/:id/submit-for-review` — the Issuer's explicit "ready for review" action. Requires at least the `prospectus` slot to be filled (the legal opinion and additional documents are optional, per the chosen document-type scope); a 400 `PROSPECTUS_REQUIRED` otherwise. Available whether this is a first-time submission or a resubmission after rejection — same endpoint, same validation, every time (matching KYC's own resubmission posture). This is a **plain, unilateral, no-proposal state transition** — it does not draft anything in the proposal system, exactly like KYC's own self-service `POST /users/me/kyc/submit`. The asset was already at `status: "pending_approval"` from creation (section C above); this call just marks the diligence package "ready to be looked at" (see `dueDiligence` shape in section A — no new field is actually needed for this, since the asset's own presence of a `prospectus` plus its `status` already fully describe "submitted, awaiting review").

## D. Review workflow — a direct decision, not the proposal system

**This is not maker-checker**, and deliberately does not use this codebase's generic `Proposal`/`/proposals/:id/approve` machinery at all. That machinery's `execute()` always acts on a payload fixed by whoever *proposed* — every existing kind (including `kyc-decision`) has the decision-maker also be the proposer, with a second person only rubber-stamping a decision already made. Here the roles split differently: the Issuer requests review (section C), but has no basis to supply the decision or risk tier themselves — only the reviewing UseCaseAdmin can, after reading the documents. Routing that through the proposal system would force a second, different eligible approver to rubber-stamp the UseCaseAdmin's own decision (via the generic `SELF_APPROVAL` check) — silently reintroducing the two-person maker-checker rule the "one UseCaseAdmin's decision is enough" choice explicitly rejected, and one that use cases with a single UseCaseAdmin could never satisfy at all.

Instead: `POST /assets/:id/review-decision`, body `{ decision: "approved" | "rejected", riskTier?: "low" | "medium" | "high", rejectionReason?: string }`.

- Refuses a machine caller outright (`machinePrincipal(request)` → 403 `MACHINE_PRINCIPAL`) — a decision is a governance act, mirroring KYC's decision route rather than the assets:issue-scoped upload/submit routes in section C.
- Requires `claims.role === "UseCaseAdmin" && claims.useCaseKey === asset.useCaseKey` — a UseCaseAdmin scoped to this asset's own use case, not PlatformAdmin-wide (the explicit choice to keep this at the use-case level, unlike KYC).
- Refuses the asset's own creator (`asset.createdBy === claims.id` → 403) — the direct analog of the proposal system's `SELF_APPROVAL`, needed explicitly here since there is no generic proposer/approver machinery to provide it for free. This is the same class of gap KYC's own final review caught and fixed (a subject able to be on both sides of their own decision) — built in from the start here rather than found afterward.
- Requires `asset.status === "pending_approval"` (409 `NOT_PENDING` otherwise) and, on approval, `b.riskTier` present (400 `RISK_TIER_REQUIRED`, symmetric to rejection's `rejectionReason` requirement) and `b.decision === "rejected"` requires `b.rejectionReason` (400 `REASON_REQUIRED`) — both required-field guards KYC's own final review had to add after the fact are specified here from the start.
- On approval: sets `dueDiligence.riskTier`, `reviewedBy: claims.id`, `reviewedAt` (clearing any stale `rejectionReason`), then calls the existing `executeIssueActivation(deps, actor, asset, { initialSupply: asset.dueDiligence?.pendingInitialSupply, treasury, sale: asset.dueDiligence?.pendingSale })` — reading back exactly what `POST /assets` stashed in section C (`treasury` itself is never stashed; it is re-derived fresh from the use case's own registered treasury, the same way `issueAssetCore` already does today) — which mints supply, applies sale terms, and flips `status: "active"` as a side effect. Executed synchronously in this one request, since there is no second approval step to wait for.
- On rejection: sets `dueDiligence.rejectionReason` (clearing any stale `riskTier`/`reviewedBy`/`reviewedAt`), flips `status: "rejected"`, mints nothing.
- **Notification:** a best-effort email to the Issuer on either outcome, mirroring `kycDecisionEmail`'s shape (a new template, since this reuses no proposal-system notification helper).

A pending or rejected asset is frozen from buy/list/secondary-market actions, exactly as `status: "pending_approval"` already is today for gated use cases.

## E. Listing & detail display

- **Asset detail page** (`AssetDetail.tsx`): a new "Due Diligence" panel placed above the existing raw-metadata grid, showing the prospectus and legal opinion as named download links, any additional documents with their labels, and a risk-tier badge once reviewed (or a "Pending review" / "Rejected — \<reason\>" status banner otherwise, mirroring the existing `pending_approval`/`rejected` banners already on this page). Documents open via the authenticated-fetch-to-blob-URL pattern established by KYC's `KycReviewPanel` (`API_BASE` + Bearer token, a synchronously-opened window to avoid popup blockers) — never a plain `<a href>`.
- **Asset Ledger / list table** (`AssetList.tsx`): a new risk-tier column (Low/Medium/High badge, or "Pending review" while `status === "pending_approval"`), next to the existing availability pill.
- **A "Review Assets" screen for UseCaseAdmins**, filtered to their own use case's `pending_approval` assets, mirroring `UserManagement.tsx`'s inline-expand `KycReviewPanel` pattern: the full diligence package (documents + any existing metadata) plus approve/reject controls (a risk-tier selector for approval, a required-reason field for rejection) that call `POST /assets/:id/review-decision` directly. This is the **only** place a pending asset is visible for review — since section D deliberately does not use the proposal system, pending assets do **not** appear in the shared `ApprovalsPanel.tsx` inbox alongside other proposal kinds.

## Testing

- Unit/API tests for `POST /assets/:id/diligence/documents`: happy path (each slot fills correctly); rejects a document upload from someone who isn't the asset's issuer/use-case staff.
- `POST /assets/:id/submit-for-review`: 400 `PROSPECTUS_REQUIRED` when no prospectus is attached; succeeds (no proposal is created — assert directly on the asset's own state) once one is; works identically on a resubmission after rejection.
- The document read gate: a UseCaseAdmin/Issuer of the asset's own use case can read a still-pending asset's documents; an ordinary buyer cannot read a pending or rejected asset's documents but can once it is `active`; the generic `GET /documents/:id` refuses an `asset-diligence`-purposed document outright.
- `POST /assets/:id/review-decision`: approving sets `active` + `riskTier` + mints supply/applies sale terms, synchronously, in one call; rejecting sets `rejected` + `rejectionReason` and mints nothing; a UseCaseAdmin from a *different* use case is refused; a machine principal is refused outright; the asset's own creator is refused even if they hold the UseCaseAdmin role; approving with no `riskTier` is refused (`RISK_TIER_REQUIRED`); rejecting with no `rejectionReason` is refused (`REASON_REQUIRED`); deciding on an asset that is not `pending_approval` is refused (`NOT_PENDING`).
- A pending or rejected asset is refused by the existing buy/list/secondary-market routes, exactly as `pending_approval` already is today.
- An asset issued before this ships (no `dueDiligence` field at all) continues to work on every existing route with no behavior change.
- A pending asset never appears in `GET /proposals` or the `ApprovalsPanel` UI — this feature creates no `Proposal` rows at all.
