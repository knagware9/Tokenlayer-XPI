# Corporate Self-Service Onboarding — Design

**Date:** 2026-07-20
**Status:** Approved for planning
**Scope:** A public marketing homepage + corporate self-registration → PlatformAdmin approval (org DID on-chain + OrgAdmin membership VC) → self-service, PlatformAdmin-gated use-case configuration, so a corporate can start tokenizing.

## Goal

Let a corporate register itself from a public page, be approved by a platform
admin (which establishes its on-chain identity), and then configure its own
tokenization use cases under a platform-admin approval gate — the full
self-service journey modelled on the reference site's homepage + signup.

Locked decisions (user-confirmed 2026-07-20):
1. **Sequencing** — built AFTER [[gated-onboarding]] merged (done, main 5ede0a4).
2. **Signup → approval** — self-registration creates a PENDING Organization + a
   PENDING OrgAdmin (no login yet); a PlatformAdmin approves (single approver,
   NOT maker-checker); approval establishes the org's on-chain DID + the
   OrgAdmin's membership VC and activates the login. Reject → nothing activated.
3. **Gated use-case config** — a new `create-use-case` proposal kind: the OrgAdmin
   configures a use case, a PlatformAdmin approves, then it deploys.
4. **Signup scope** — company legal name, org type, registration id, jurisdiction,
   and the admin's name/email/password. No KYB document upload this cycle.

## Architecture

Three subsystems in one journey, all riding existing machinery:
- **Public web + `POST /orgs/register`** — the first UNAUTHENTICATED routes/endpoint.
- **Org approval queue** — a direct PlatformAdmin action (single approver) that
  reuses the existing `POST /orgs` DID-mint + on-chain register + member-VC mint.
- **`create-use-case` proposal kind** — on the existing maker-checker proposal
  registry (like onboard-user), so the Approvals inbox, SoD, and audit come free.

### Identity refinement (avoids a nullability migration)
Self-signup mints the org's custodial DID immediately (encrypted seed, exactly
like `POST /orgs`) but leaves the org `status:"pending"`, `verified:false`, and
does NOT register the DID on-chain. Verifier trust already keys off the on-chain
DidRegistry (`registered && active`), so a pending org's DID is trusted nowhere
until approval. `OrganizationRecord.did`/`didSeedEncrypted` stay non-nullable.
`OrgStatus` gains `"pending"` if it doesn't already have it.

## Components

### 1. Public homepage + signup (web)
- App routing gains a public branch: an unauthenticated visitor at `/` sees a
  **marketing homepage** (`Home.tsx`) — hero, a short "what this is" / how-it-works,
  and **Login** + **Register your company** CTAs — in the house style (ui.tsx
  primitives, brand palette). Authenticated users still get the app shell.
- **`/signup`** (`Signup.tsx`) — a public corporate registration form: company
  legal name, org type (`bank | corporate | msme | government`; NOT `verifier`),
  registration id, jurisdiction, admin full name, admin email, admin password
  (min 8). Submit → `POST /orgs/register` → a "Submitted — a platform admin will
  review your registration" confirmation with a Back-to-home link.
- The existing `Login.tsx` gains a "Register your company" link; the header logo
  routes to `/`.

### 2. `POST /orgs/register` (public API)
No auth. Body `{ company: { name, orgType, registrationId?, jurisdiction? }, admin: { name, email, password } }`.
- Reject `orgType: "verifier"` (reserved for platform-issued orgs) → 400.
- 409 `NAME_TAKEN` / `REGISTRATION_TAKEN` (reuse `findByName`/`findByRegistrationId`);
  409 `EMAIL_TAKEN` if the admin email exists.
- Mint the org DID (seed → encrypt), create the Organization `status:"pending"`,
  `verified:false` (DID present, NOT registered on-chain).
- Create the OrgAdmin user: `role:"OrgAdmin"`, `orgId: <org>`, `active:false`,
  `kycStatus:"pending"`, password bcrypt-hashed, `kyc:{ legalName: admin.name }`,
  no sub-DID yet.
- Audit `org-registered`. Respond `202 { organizationId, status:"pending" }` — no
  token, no login. A pending/inactive user cannot authenticate (the login route
  already refuses `active:false`; verify and add the guard if missing).

### 3. Org approval queue (PlatformAdmin)
- `GET /orgs?status=pending` (extend the existing list route with an optional
  status filter; PlatformAdmin only) → pending orgs with their proposed admin.
- `POST /orgs/:id/approve` (PlatformAdmin) — atomic:
  1. Register the org DID on-chain (`registry.anchor.registerDid`); if a registry
     is configured and the call fails → 502 `REGISTRY_UNAVAILABLE`, nothing
     changes (same contract as `POST /orgs`). Absent registry ⇒ skip.
  2. Set org `status:"active"`, `verified:true`, `verifiedAt`.
  3. Mint the OrgAdmin's sub-DID + issue the OrganizationMembership VC (reuse the
     existing `mintMembership` path), set the user `active:true`.
  4. Audit `org-approved`. Respond the activated org.
  Order = chain-first (register before activating) so a chain failure leaves the
  org pending. If sub-DID/VC mint fails after activation, roll back the org to
  pending (mirror the onboarding rollback discipline) — never a half-approved org.
- `POST /orgs/:id/reject { reason }` (PlatformAdmin) — set org `status:"rejected"`;
  the OrgAdmin stays inactive (cannot log in). Audit `org-rejected`.

### 4. `create-use-case` proposal kind (gated use-case config)
- New kind in `apps/api/src/user-kinds.ts`'s sibling or its own `usecase-kinds.ts`,
  registered in `proposal-kinds.ts`. Scope: `canView`/`canApprove` = PlatformAdmin
  OR the OrgAdmin of the proposing `orgId` (org-scoped, never null-matching).
- **Propose** — the existing `POST /use-cases` gains a caller branch (ONE route,
  no new path): a **PlatformAdmin** keeps the current DIRECT create+deploy
  (unchanged, 201); an **OrgAdmin** caller instead gets validate +
  `normalizeUseCaseDefinition`, `ownerOrgId: claims.orgId` stamped, and a
  `create-use-case` proposal created (payload = the normalized definition) →
  `202 { proposal }`. Any other role → 403.
- **Execute (on approve)** — create the use case owned by the org and deploy its
  contract on every available allowed chain (reuse `deployUseCaseContracts`);
  `NO_DEPLOYABLE_CHAIN` if none succeed → proposal `failed`. Idempotent on the
  use-case key (409 `USECASE_EXISTS` at propose and re-checked at execute).
- Web: the Create-use-case wizard, when the caller is an OrgAdmin, submits the
  proposal and shows "submitted — pending platform approval"; the Approvals inbox
  summarises `create-use-case` (`configure use case <name> (<SYMBOL>) for <org>`).

### 5. The payoff (reused, no new work)
Once the org is active and its use case approved+deployed, the OrgAdmin uses the
EXISTING org-member onboarding (`POST /orgs/:id/users` — direct sub-DID +
membership VC) to add an Issuer/Buyer, and issues assets through the existing
flow. The corporate is now tokenizing.

## API surface (summary)

| Route | Auth | Change |
|---|---|---|
| `POST /orgs/register` | public | new — pending org + pending OrgAdmin |
| `GET /orgs?status=pending` | PlatformAdmin | list gains a status filter |
| `POST /orgs/:id/approve` | PlatformAdmin | new — DID on-chain + member VC + activate |
| `POST /orgs/:id/reject` | PlatformAdmin | new |
| `POST /use-cases` (OrgAdmin caller) | OrgAdmin | branch — 202 create-use-case proposal (PlatformAdmin path unchanged) |
| `POST /proposals/:id/approve` | — | unchanged — handles the new kind |
| `POST /orgs`, `POST /orgs/:id/users`, issuance | — | UNCHANGED |

## Error handling
- Register: 400 (verifier orgType / schema), 409 (name/registration/email taken).
- Approve: 502 `REGISTRY_UNAVAILABLE` (chain-first, no state change); post-activation
  member-mint failure → roll org back to pending.
- create-use-case: 409 `USECASE_EXISTS` (propose + execute re-check);
  `NO_DEPLOYABLE_CHAIN` → proposal `failed`; SoD via the registry's SELF_APPROVAL.
- Public endpoints must be rate-limited (reuse the existing login rate-limit
  pattern for `/orgs/register`) to prevent signup spam.

## Out of scope (explicit)
- KYB document upload/review at signup (deferred — hook exists via the doc store).
- Self-service org signup for `verifier`-type orgs (platform-issued only).
- Maker-checker (2-admin) org approval — single PlatformAdmin approver, per the
  locked decision.
- Billing/quotas; email notifications; password reset for pending admins.
- Changing org-member onboarding or asset issuance (reused as-is).

## Testing
**API (vitest):**
1. Register → 202, org `pending`, DID present but NOT on-chain (registry double:
   `dids` map has no entry), OrgAdmin `active:false`, cannot log in (401).
2. Approve → org `active`+`verified`, DID registered on-chain (double), OrgAdmin
   `active:true` with a sub-DID + a membership VC (`GET /me/credentials`), can log
   in. Reject → org `rejected`, admin still can't log in.
3. Approve chain-first: registry double `failNext="registerDid"` → 502, org stays
   pending, admin still inactive.
4. Duplicate name/registration/email at register → 409s. `verifier` orgType → 400.
5. `create-use-case`: OrgAdmin proposes → 202; PlatformAdmin approves → use case
   exists with `ownerOrgId`, deployed contract; the OrgAdmin sees only their org's
   proposal; OrgAdmin self-approve refused (SELF_APPROVAL); a PlatformAdmin direct
   `POST /use-cases` still deploys immediately (unchanged).
6. A pending/rejected org's OrgAdmin cannot propose a use case (no active session).

**Live Besu E2E (`scripts/corporate-e2e.mjs`):** register a corporate → (as admin)
approve → independent `eth_call didRegistration` proves the org DID is registered
+ active on-chain → (as the org admin) propose a use case → (as admin) approve →
the use case is deployed → the org onboards an Issuer and mints an asset.

**Browser:** public homepage → Register your company → submit → (as PlatformAdmin)
approve in the org queue → log in as the corporate admin → configure a use case →
"pending approval" → (as PlatformAdmin) approve → the use case appears deployed.
