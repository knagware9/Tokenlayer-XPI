# Organizations + User Management + Identity Foundation — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorm decisions locked with user)
**Reference:** `~/did-vc-project` (org = parent DID, employees = sub-DIDs, custodial keys, on-chain
registries — we align on the identity model, reuse our off-ledger `identity.ts`).

## Goal

Make the platform enterprise-grade: **Organizations** as the top tenant, **proper user
management** scoped to an org, and a **custodial DID + a first Verifiable Credential for every org
and every user**. First of four sub-projects (this = structure + DIDs + membership VC; then richer
VC issuance + maker-checker; then verifier flows; then on-chain DID/VC registry).

## Locked decisions

1. **Org owns use cases** — Organization is the top tenant; an org owns ≥1 use case; users belong to
   an org with org-scoped roles; per-asset compliance/scoping still runs per `useCaseKey` (unchanged).
2. **Reuse `packages/core/src/identity.ts`** — did:key + Ed25519 (VC-JWT), no new crypto deps.
3. **Admin-created onboarding** — PlatformAdmin creates + verifies orgs and their OrgAdmin.
4. **Custodial keys** — the platform holds each DID's Ed25519 seed (encrypted) and signs on its behalf.
5. **#1 issues a membership VC** — the org's parent DID issues each member an `OrganizationMembership` VC.

## Data model (Prisma; `prisma db push`, no migration files)

- **`Organization`** (new): `id, name, orgType (bank|corporate|msme|government|verifier), registrationId?,
  jurisdiction?, did String @unique, didSeedEncrypted String, status (active|suspended) @default(active),
  verified Boolean @default(false), verifiedAt?, createdAt`. `@@index([status])`.
- **`User`** (extend): `orgId String?` (FK-by-convention to Organization.id), `didSeedEncrypted String?`
  (the user's sub-DID seed). `did` already exists (now populated for every user on create). Role gains
  `OrgAdmin`. `useCaseKey` unchanged.
- **`UseCase`** (extend): `ownerOrgId String?` — nullable; **use-case creation stays PlatformAdmin-only
  in #1** (they set `ownerOrgId` on `POST /use-cases`). An OrgAdmin does NOT create use cases yet — that
  moves to a later sub-project; here they only *see* their org's use cases (`GET /use-cases` filtered to
  `ownerOrgId === claims.orgId` for OrgAdmin, unchanged for everyone else). Legacy use cases keep
  `ownerOrgId: null` and behave exactly as today.
- **`Credential`** (new): `id, holderDid, issuerDid, type, vcJwt String, subjectClaims String (JSON),
  issuedAt, expiresAt?, revoked Boolean @default(false)`. `@@index([holderDid])`.
- Memory-repo mirrors for all of the above (tests + sim).

## Core (`packages/core`)

No new crypto. Add `Role` member `"OrgAdmin"` to `packages/core/src/types.ts` and the RBAC matrix
(`packages/core/src/rbac.ts`): `OrgAdmin` gets `["read"]` lifecycle actions (org admins manage
people/config, not token ops directly — like UseCaseAdmin they can be granted more later; keeping it
`read` avoids widening token authority unintentionally). Membership-VC claim shape is documented here,
issued via the existing `issueCredential`.

## API (`apps/api`)

### Keystore — `apps/api/src/keystore.ts` (new)
- `newSeed(): Buffer` — 32 random bytes.
- `encryptSeed(seed: Buffer): string` / `decryptSeed(enc: string): Buffer` — AES-256-GCM with a 32-byte
  master key from `DID_MASTER_KEY` (hex). Absent → a fixed **dev** key with a loud one-time warning
  (same real-or-absent pattern as the KYC issuer seed); production MUST set `DID_MASTER_KEY`. Format:
  `base64(iv | authTag | ciphertext)`.
- `keyOf(encSeed): DidKey` — `didKeyFromSeed(decryptSeed(encSeed))` (reconstructs did + Ed25519 keys).
- `issueMembershipCredential(orgEncSeed, orgDid, userDid, claims, now): { vcJwt, expiresAt }` — signs a
  VC (`type: ["VerifiableCredential","OrganizationMembership"]`, `credentialSubject: { id: userDid,
  organization, orgId, role, memberSince }`, 1-year expiry) with the org's key.
- Injected into `AppDeps` as `keystore` + `didMasterConfigured: boolean`.

### Persistence
`OrganizationRepository` (create/get/list/listForOrgAdmin/setVerified/setStatus), `CredentialRepository`
(create/listByHolder/get/setRevoked), and `UserRepository` widened to persist `orgId`/`didSeedEncrypted`;
`UseCaseRepository` round-trips `ownerOrgId`. Prisma + Memory impls, wired into AppDeps + all construction
sites (server.ts, helpers.ts, demo/e2e scripts).

### Routes (`routes.ts` + `schemas.ts`)
Scope guard `orgScoped(request, orgId)`: PlatformAdmin → any; OrgAdmin → only `claims.orgId === orgId`;
else 403.
- `POST /orgs` (PlatformAdmin) `{ name, orgType, registrationId?, jurisdiction? }` → mint parent DID
  (seed → encrypt → store), `verified:true, verifiedAt`. Returns `{ id, name, did, orgType, verified }`.
- `GET /orgs` — PlatformAdmin: all; OrgAdmin: `[their org]`.
- `GET /orgs/:id` — org-scoped.
- `POST /orgs/:id/users` (PlatformAdmin or that org's OrgAdmin) `{ email, password, role, useCaseKey?,
  walletAddress?, kyc? }` → create user with `orgId`, mint **sub-DID** (seed → encrypt → store `did`),
  issue + store the **OrganizationMembership VC** (org DID → user DID). `canCreateUser` extended so an
  OrgAdmin may create the org-internal roles (Issuer/Trader/Buyer/Auditor/UseCaseAdmin) but not
  PlatformAdmin/another OrgAdmin unless PlatformAdmin. Returns the user + `did` + `membershipVc: true`.
- `GET /orgs/:id/members` — org-scoped list: `{ id, email, role, useCaseKey, did, active, kycStatus }[]`.
- `GET /me/credentials` — the caller's held credentials from `CredentialRepository.listByHolder(claims.did)`
  (decoded claims + type + issuer + expiry + revoked).
- `GET /dids/:did/document` (auth read) — resolve a `did:key` into a W3C DID document JSON
  (`id`, `verificationMethod: [{ id: did#0, type: Ed25519VerificationKey2020, controller, publicKeyMultibase }]`,
  `authentication`, `assertionMethod`). Pure from the DID string via `publicKeyFromDidKey`; 400 on a
  non-did:key.
- JWT: `signToken`/claims gain `orgId` (from the user record); `requireUser` surfaces it.
- The existing `POST /users` (use-case-scoped create) stays for back-compat but now also mints a
  sub-DID + membership VC **when the creator/target has an org** (else behaves as today — no org, no DID).

## Web (`apps/web`)

- **Organizations** area (PlatformAdmin: list + create orgs; OrgAdmin: their org): org card (name, DID
  with copy, `verified` Pill, orgType, registrationId, jurisdiction) + **Members** table (email · role ·
  use case · DID short · KYC/active Pills) with "Add member" (email, password, role, use-case scope) that
  shows the minted DID + membership-VC confirmation. The existing `UserManagement` is folded into this as
  the Members table (org-scoped).
- **My identity** (any signed-in user, in a header menu or a tab): my DID (+ DID-document view via
  `/dids/:did/document`) and my held credentials from `/me/credentials` (type, issuer org, issued/expiry,
  a green "valid" Pill). Reuses `ui.tsx` primitives + `ContractCodeView`-style mono block for the DID doc.
- Client: `api.orgs`, `api.createOrg`, `api.org`, `api.orgMembers`, `api.createMember`, `api.myCredentials`,
  `api.didDocument` + types.

## Data flow / trust

Custodial: the platform generates + holds each seed (encrypted at rest), so it can sign org→member VCs
server-side. A membership VC is verifiable by anyone: its `iss` is the org's parent DID (self-describing
did:key), so `verifyPresentation`/`verifyJwtSignature` confirm the org actually issued it — no external
trust list needed for self-issued membership (the org DID IS the authority for its own membership claims).

## Error handling

- `DID_MASTER_KEY` absent in production → refuse org/DID creation with a clear 503 (dev → warn + proceed).
- Org routes: 403 cross-org (never 404-leak within PlatformAdmin), 404 unknown org, 409 duplicate
  registrationId/name.
- Member create: duplicate email → 400 EMAIL_TAKEN (existing); DID/VC minting failure rolls back the
  user row (no orphan).

## Testing

- **API** (`apps/api/test/organizations.test.ts`): org create mints a resolvable parent DID; member
  create mints a sub-DID + a membership VC whose signature verifies against the org DID and whose
  `credentialSubject.id === member.did`; org-scoped RBAC (OrgAdmin A can't create/list in org B → 403;
  OrgAdmin can't mint a PlatformAdmin); `/me/credentials` returns the membership VC; `/dids/:did/document`
  resolves + a non-did:key → 400; back-compat (a user created with no org gets no DID and existing flows
  pass). Full suite stays green.
- **Live E2E** (`scripts/org-identity-e2e.mjs`): PlatformAdmin onboards an org → parent DID; creates an
  OrgAdmin (sub-DID + membership VC); OrgAdmin adds an Issuer + a Buyer (each sub-DID + VC); assert every
  membership VC verifies against the org DID and appears in each member's `/me/credentials`; assert
  cross-org isolation.
- **Browser**: create an org, add members, see DIDs + verified/membership Pills; open "My identity" for a
  member and see its DID document + membership credential.

## Out of scope (later sub-projects)

Richer credential types + maker-checker/signatory VC issuance (#2) · verifier request/presentation +
selective disclosure + credential sharing (#3) · on-chain DIDRegistry/VCRegistry on Besu + revocation
list anchoring (#4) · self-service org signup · government-registry (MCA/GSTN) org verification · MFA/SSO.
