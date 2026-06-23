# KYC / User Onboarding — Design (Sub-project B)

**Date:** 2026-06-23
**Status:** Approved (pending written-spec review)

## Context

User provisioning currently captures only email/password/role/use-case/wallet. We want a
**KYC / onboarding** step at user creation: capture KYC details, run an approve/reject flow,
and make KYC approval a **gate on participation** — a user's wallet can only be allowlisted on
an asset once that user is KYC-approved.

This is sub-project **B** of a two-part effort. Sub-project **A** (buyer Buy + CBDC payment /
DvP) builds on this and is specced separately afterward. KYC establishes "who is eligible to
hold/buy" before the buy flow is added.

## Decisions (confirmed)

1. **KYC fields:** legal name, country, ID type, ID number, document reference.
2. **Flow:** new users via Add User start `kycStatus: "pending"`; a UseCaseAdmin/PlatformAdmin
   **Approves** or **Rejects** in Manage Users.
3. **Gate:** allowlisting a user's wallet on an asset requires that user be `approved`; wallets
   with no linked platform user (demo wallets) are ungated. Enforced on the `allow` action, not
   at login.

## 1. Data model

`User` gains:
- `kycStatus String @default("approved")` — `"pending" | "approved" | "rejected"`. The DB default
  is `approved` so existing rows, seeded rosters, and admins keep working unchanged; the
  `POST /users` route explicitly sets `"pending"` for newly-onboarded users.
- `kyc String?` — JSON blob `{ legalName, country, idType, idNumber, documentRef }` (nullable;
  stored as a JSON string like other JSON columns).

`UserRecord` (persistence) gains `kycStatus: KycStatus` and `kyc: KycDetails | null`.
`KycStatus = "pending" | "approved" | "rejected"`; `KycDetails = { legalName?, country?, idType?,
idNumber?, documentRef? }`. Repos (memory + prisma) map both; `update`'s patch widens to include
`kycStatus`. Prisma serialises `kyc` to/from JSON.

## 2. API

- `POST /api/v1/users` — body gains optional `kyc: KycDetails`. Created users are persisted with
  `kycStatus: "pending"` and the supplied `kyc`. (All roles created this way are `pending`; since
  the gate is on allowlisting, a pending admin/issuer with no wallet is unaffected.)
- `PATCH /api/v1/users/:id` — body gains `kycStatus?: "approved" | "rejected"`. Same scope guard
  as the existing PATCH (PlatformAdmin any; UseCaseAdmin only own-use-case, non-UseCaseAdmin
  targets). Reuses `users.update`.
- `GET /api/v1/users` — summary gains `kycStatus` and `kyc`.
- **Allow gate:** in the action route's `allow` branch (setAllowed=true), resolve the target
  address → account → owning user (via `deps.users.list()` + `accountId` match). If a linked user
  exists and is not `approved`, return `400 { error: "KYC_NOT_APPROVED" }` before calling the
  engine. If no linked user (demo/unlinked wallet), proceed as today. `disallow` is never gated.

This keeps the chain-agnostic `LifecycleEngine` untouched — KYC is an API-layer concern that wraps
the existing compliance action.

## 3. Web (User Management)

- **Add User** (`UserManagement.AddUser`): add inputs for legal name, country, ID type, ID number,
  document reference. Sent as `kyc` in the create payload. (Optional fields; no hard client
  requirement beyond what the admin chooses to enter.)
- **Manage Users** (`UserManagement.ManageUsers`): a **KYC** column showing a status badge
  (pending = amber, approved = emerald, rejected = red). For `pending`/`rejected` rows the admin
  sees **Approve**; for `pending`/`approved` rows, **Reject** — wired to `api.updateUser(id,
  { kycStatus })`. The captured details are shown (inline or via the existing row).
- `api.ts`: `createUser` input gains optional `kyc`; `users()` return type gains `kycStatus` +
  `kyc`; `updateUser` patch gains `kycStatus`.

## 4. Seed / compatibility

Seeded rosters keep the DB default `kycStatus: "approved"` (no `kyc` details needed). This means
the carbon/gold/bond demos, `e2e-tenancy`, `e2e-carbon`, and `seed-carbon-projects` continue to
pass unchanged — they allowlist wallets of already-approved seeded users, and the deliberately
unlinked demo wallet (Carol) is ungated. Only users onboarded via Add User must clear KYC before
their wallet can be allowlisted.

## 5. Testing

- **API:** `POST /users` → `kycStatus: "pending"` + stored `kyc`; `PATCH` approve → `approved`,
  reject → `rejected`; allowlisting a pending user's linked wallet → `400 KYC_NOT_APPROVED`; after
  approval the same allow → 200; an unlinked address still allowlists; a UseCaseAdmin cannot change
  KYC for another use case's user (403). `GET /users` exposes `kycStatus`/`kyc`.
- **Web:** typecheck clean; live preview — add a user with KYC (pending), approve in Manage Users,
  then allowlist their wallet succeeds; before approval it is blocked.

## Out of scope

Document upload/storage (only a reference string is kept); KYC providers / sanctions screening;
per-field validation beyond presence; re-KYC/expiry; gating login or non-allowlist actions on KYC.
The Buy + CBDC payment flow is sub-project A (separate spec).
