# Gated Onboarding + Identity Lifecycle — Design

**Date:** 2026-07-20
**Status:** Approved for planning
**Scope:** Maker-checker user onboarding with automatic DID/VC issuance, a gated identity-revoke flow, and the two UI gaps found during the live demo (full Add-User form, holder-side sell).

## Goal

Make user onboarding enterprise-grade: adding a user is a proposal that a second
user-manager approves; approval mints the user's custodial DID and issues their
KycCredential in one atomic step; revoking identity is an equally gated flow that
revokes credentials chain-first. Round out the UI so the whole lifecycle —
onboard, verify, hold, sell — is drivable from the console.

Decisions locked with the user:

1. **Checker** = any second user-manager in the same scope; the proposer can
   never approve their own proposal (segregation of duties, as everywhere else).
2. **On approval**: mint custodial DID + issue a KycCredential from the KYC data
   in the onboarding form. The checker's approval IS the verification act.
   No KYC data → user + DID created `pending`; the existing verify-later flow
   still applies.
3. **Revoke = identity only**: credentials revoked (chain-first) + KYC flipped;
   the login stays active. Account deactivation remains a separate manual action.
4. Item 3 of the request = the demo's UI gaps: Add-User must support all roles +
   wallet + KYC data; holders must be able to sell from their portal.

## Architecture

Everything rides the existing, proven machinery — no new approval surface:

- **Proposal kind registry** (`apps/api/src/proposal-kinds.ts`) gains two kinds:
  `onboard-user` and `revoke-user-identity`. The Approvals inbox, SoD
  enforcement, audit, and failure handling come with the registry.
- **Keystore** (`apps/api/src/keystore.ts`) already provides custodial seed
  custody (`newSeed`/`encryptSeed`/`keyOf`) and `issueOrgCredential` (signs any
  registered credential type, embeds the `credentialStatus` URL).
- **Anchoring/revocation** reuse the issue = sign→anchor→persist and
  revoke = chain-first-then-DB paths from the credential kinds (#2/#4 of the
  identity arc), extracted into shared helpers.
- **Market listings API** (`POST /assets/:id/listings`, `DELETE /listings/:id`)
  already exists; the holder-sell UI is a thin client over it.

## Components

### 1. `onboard-user` proposal kind

**Propose.** `POST /users` called by a user-manager no longer creates the user.
It validates exactly as today (role targets per the user policy, email format,
supported role for the caller), hashes the password immediately
(`bcrypt.hashSync` at request time — plaintext never enters the proposal store),
checks the email is unused (`409 EMAIL_EXISTS`), then creates a proposal:

```jsonc
{
  "kind": "onboard-user",
  "useCaseKey": "<scope>",          // the target user's use case (nullable for platform-level)
  "payload": {
    "email": "...", "passwordHash": "...", "role": "Buyer",
    "useCaseKey": "...", "walletAddress": "0x… | null",
    "kyc": { "legalName": "...", "country": "IN", "idType": "...", "idNumber": "...", "documentRef": "..." } // optional block
  }
}
```

Response: `202 { proposal }` — the same contract as gated token actions.

**Visibility/approval.** `canView`/`canApprove` = users with user-management
rights over the proposal's scope (PlatformAdmin always; UseCaseAdmin of the same
`useCaseKey`). The existing proposal route already refuses the proposer as
approver.

**Execute (on approve).** One ordered sequence; failures mark the proposal
`failed` with the outcomes defined in *Error handling* below:

1. Re-check the email is still unused (a race → proposal `failed`, typed error).
2. Create the wallet account if `walletAddress` is present (linking as today).
3. Create the user row (`active: true`).
4. Mint the custodial DID: `newSeed()` → `encryptSeed` → store
   `didSeedEncrypted` + `did` on the user (identical to org-member minting).
5. If the `kyc` block is present: resolve the issuer (see §2), issue a
   `KycCredential` over `{legalName, country, idType?, idNumber?, documentRef?}`
   via the shared issuance helper (sign → anchor on-chain when the registry is
   present → persist credential row), then set `kycStatus: "approved"` and the
   `kyc` metadata including `issuerDid` and `credentialId`.
6. If no `kyc` block: leave `kycStatus: "pending"` (DID still minted; the
   existing `identity/challenge`→`verify` flow completes KYC later).
7. Audit `user-onboarded` (userId, did, issuerDid?, country?).

**Reject.** Nothing was created; compensation is a no-op. Audit records the
rejection with the reason.

### 2. Issuer resolution + platform issuer org

Order of preference when issuing the onboarding KycCredential:

1. `useCase.ownerOrgId` set → that organization's parent DID signs (custodial
   signing via `keyOf`, exactly like org credential issuance).
2. Otherwise → the **"TokenLayer Platform"** issuer org: seeded idempotently at
   boot (`orgType: "verifier"`, `verified: true`, status active) with its own
   custodial DID. When the on-chain registry is present its DID is registered in
   the DidRegistry at boot (absent-tolerant — never fails boot; mirrors
   `resolveIdentityRegistry`'s degradation). `KycCredential`'s allowed issuer
   org types already include `verifier`, so no registry changes are needed.

Verifier/presentation flows trust the platform org through the on-chain
DidRegistry (`registered && active`). When Besu is absent, operators who need
third-party verifiability of onboarding VCs add the platform DID to
`TRUSTED_KYC_ISSUERS`; this is documented, not enforced.

### 3. `revoke-user-identity` proposal kind

**Propose.** `POST /users/:id/revoke-identity { reason }` (reason required) by a
user-manager of the target's scope → `202 { proposal }` with payload
`{ userId, reason }`. Refuse (409 `ALREADY_PENDING`) if the user already has a
pending revoke proposal. Any other state is proposable — executing against a
user with no active credentials simply performs the KYC flip.

**Execute (on approve).**

1. For every non-revoked credential whose `holderDid` = the user's DID: revoke
   via the shared helper — **chain-first** where anchored (an on-chain
   revocation failure fails the proposal; the DB is never ahead of the chain),
   then mark revoked in the DB.
2. Set `kycStatus: "rejected"` and record `kyc.revokedAt` + `kyc.revokeReason`.
3. Audit `user-identity-revoked` (userId, credentialIds, reason).

A user with no DID (legacy) simply gets the KYC flip. The login stays `active`:
they can sign in and view their portfolio, but every compliance gate
(`KYC_NOT_APPROVED`, jurisdiction, allowlisting) now refuses them.

### 4. Shared credential helpers (targeted refactor)

Extract from `apps/api/src/credential-kinds.ts` into a small module (e.g.
`apps/api/src/credential-issuance.ts`):

- `issueCredentialFor(deps, issuerOrg, subject { did, userId? }, type, claims)`
  — id-before-sign, `issueOrgCredential`, anchor-when-registry, persist. Used by
  the `issue-credential` kind (unchanged behaviour) and the onboarding executor.
- `revokeCredentialById(deps, credentialId, reason)` — chain-first revoke +
  DB mark. Used by the `revoke-credential` kind and the revoke-identity
  executor.

Behaviour-preserving for the existing kinds; their tests must pass unedited.

### 5. Web

- **Add-User form** (`UserManagement.tsx`): role picker driven by the caller's
  allowed targets (PlatformAdmin/UseCaseAdmin see Buyer, Issuer, Auditor,
  UseCaseAdmin), optional wallet address, optional KYC block (legal name,
  country, ID type/number, document ref). Submit → 202 → success note
  "Onboarding proposal submitted — pending a second approver" and the proposal
  is visible in the Approvals inbox.
- **Approvals inbox** (`ApprovalsPanel.tsx`): readable summaries for the two new
  kinds — e.g. `Onboard Buyer alice@… (KYC: IN)` and
  `Revoke identity — bob@… ("left the fund")`.
- **Manage Users**: the current one-click **Revoke** (direct PATCH) is replaced
  by **Revoke identity** which creates the gated proposal; a small "pending"
  pill shows users with an in-flight onboarding or revoke proposal.
- **Holder sell** (`InvestorPortal.tsx`): each holding row gains **Sell**
  (quantity, unit price, currency → `POST /assets/:id/listings`); a
  **My listings** section lists the caller's open listings across their held
  assets (`GET /assets/:id/listings` filtered by seller wallet) with **Cancel**
  (`DELETE /listings/:id`). Taking listings stays in the existing market UI.

### 6. API surface (summary)

| Route | Change |
|---|---|
| `POST /users` (user-manager) | now `202 { proposal }` (`onboard-user`) |
| `POST /users/:id/revoke-identity` | new — `202 { proposal }` (`revoke-user-identity`) |
| `POST /proposals/:id/approve` / `reject` | unchanged — handles the new kinds via the registry |
| `PATCH /users/:id` `kycStatus` | still exists (used by identity-verify flow); the web UI no longer calls it for revocation |
| org path `POST /orgs/:id/users` | **unchanged** (direct, membership VC) |

## Error handling

- Propose-time: `EMAIL_EXISTS` 409, `FORBIDDEN` 403 (role targets), schema 400s.
- Execute-time: email race → proposal `failed` with `EMAIL_EXISTS`; issuance or
  anchoring failure → proposal `failed`, **no user row persists** (creation is
  ordered so the user row is only committed after DID mint succeeds; credential
  failure after user creation marks the proposal failed and leaves the user
  `pending` with a clear audit trail — never a half-approved KYC).
- Revoke execute: chain revocation failure → proposal `failed`, DB untouched
  (fail-closed, chain-first — the DB is never "more revoked" than the chain).
- SoD: proposer approving → the registry's existing refusal.

## Out of scope (explicit)

- Gating the org-member path (`/orgs/:id/users`) — follow-up cycle.
- Self-service registration; configurable per-use-case onboarding workflows.
- Changing how listings are taken; escrow mechanics (already built).
- Per-claim selective disclosure of the onboarding VC (deferred with the arc).

## Testing

**API (vitest, in-process app):**
1. Happy path: propose → second manager approves → user exists with DID,
   KycCredential row (status URL set), `kycStatus: approved`; audit entries.
2. SoD: proposer approving → refused; a second UseCaseAdmin of the same use
   case succeeds; a UseCaseAdmin of a *different* use case cannot see it.
3. Reject → no user row, no account, no credential.
4. Duplicate email at propose (409) and at execute (proposal `failed`).
5. No-KYC onboarding → user `pending` + DID minted, no credential; the existing
   identity-verify flow then approves them.
6. Revoke: propose+approve → credential revoked (verify with the registry test
   double that the chain call happened **before** the DB flip), `kycStatus:
   rejected`, login still succeeds, `allow` on an asset now fails
   `KYC_NOT_APPROVED`.
7. Issuer resolution: use case with `ownerOrgId` → org DID signs; without →
   platform org DID signs; platform org seeded idempotently across two boots.
8. Refactor guard: existing credential-kind tests pass unedited.
9. Existing e2e harness scripts updated to propose→approve where they created
   users directly.

**Live E2E (`scripts/onboarding-e2e.mjs`):** against real Besu — onboard with
KYC (propose → approve) → VC independently signature-checked + anchored
(`eth_call`) → user transacts (allowlist + buy) → revoke identity (propose →
approve) → on-chain revocation flips, compliance gates refuse the user, login
still works.

**Browser:** drive Add-User → Approvals → approve → user active with DID;
Sell + cancel a listing from the portal.
