# KYB Documents + Platform DID Issuance + Review Flow — Design

**Date:** 2026-07-21
**Status:** Approved for planning
**Scope:** Extend the merged corporate self-service arc (main `182b595`) with: KYB
document upload at signup (CIN + GSTIN certificates), the corporate DID explicitly
ISSUED by the Platform Org at approval (on-chain registration + a platform-signed
OrganizationCredential), and a proper PlatformAdmin review experience.

## Goal

A corporate registers with statutory documents attached; a PlatformAdmin reviews
the full application (KYB fields + documents) and approves; approval is the DID
issuance ceremony — the Platform Org registers the corporate DID on-chain and
issues a signed, anchored OrganizationCredential attesting the KYB facts; both
sides see the issuance attributed to "TokenLayer Platform".

Locked decisions (user-confirmed 2026-07-21):
1. **DID issuance = ceremony at approval** — keep the custodial mint at signup
   (no nullability migration); approval performs on-chain `registerDid` PLUS a
   platform-issued OrganizationCredential. The web hides the DID until approved
   ("pending issuance") and labels it "Issued by TokenLayer Platform" after.
2. **Documents:** CIN certificate REQUIRED, GSTIN certificate OPTIONAL (offered
   when a GSTIN was entered). PDF/JPG/PNG, max 5 MB decoded, via a public
   rate-limited upload endpoint. No other documents this cycle.

## Architecture

Three additions riding existing machinery:
- **Public upload** — a thin public wrapper over the existing document store
  (`deps.documents`, invoice-evidence store: base64 JSON in, allowlisted types,
  MAX_DOC_BYTES, unguessable cuid ids, authenticated `GET /documents/:id` out).
- **Issuance ceremony** — the approve route composes the existing pieces:
  chain-first `registerDid` (unchanged) + `issueCredentialFor` with the platform
  org (`ensurePlatformIssuerOrg`) as issuer and the corporate org DID as subject.
- **Review UI** — the pending-queue row expands into a full review (KYB grid +
  document downloads); org views gain issuance attribution + credential status.

## Components

### 0. Core: `OrganizationCredential` joins the credential catalog
`CREDENTIAL_TYPES` (packages/core/src/credential-types.ts) is a CLOSED registry
(`credentialTypeDef` throws on unknown types), so the new type must be added:
- `type: "OrganizationCredential"`, description "Attests a legal entity's
  verified registration (KYB) and binds it to its organization DID."
- `allowedIssuerOrgTypes: ["verifier"]` (the platform org is a verifier),
  `requiredApprovals: 1`, `validityDays: 365`.
- `claimSchema`: required `name`, `cin`, `pan`; optional `gstin`, `state`,
  `pincode`, `dateOfIncorporation`, `category`, `orgType` (all strings). Absent
  optionals (e.g. a null GSTIN) are OMITTED from the claims, never passed null.
- Side effect (accepted): the type becomes REQUESTABLE via the existing
  maker-checker `POST /credentials/requests` path for verifier orgs — consistent
  with catalog semantics.

### 1. Public document upload — `POST /orgs/register/documents`
- No auth. Throttled by the same limiter as `POST /orgs/register`
  (`loginThrottled(ip)` → 429). `bodyLimit: 8 * 1024 * 1024` (5 MB decoded ≈
  6.8 MB base64).
- Body `{ contentType, dataBase64 }` — identical contract to the authenticated
  `POST /documents`. Same guards: 415 on a type outside `ALLOWED_DOC_TYPES`
  (pdf/jpeg/png), 400 on empty, 413 over `MAX_DOC_BYTES`.
- 201 `{ id, sha256, size }`. No URL is returned (the registrant cannot read it
  back; only authenticated readers can). Documents are not listable; ids are
  unguessable cuids. Orphaned uploads from abandoned signups are ACCEPTED this
  cycle (size-capped, rate-limited); no cleanup job.
- Reads stay on the existing `GET /documents/:id` (issue-capable roles +
  Auditor). PlatformAdmin is issue-capable, so the reviewer can download.

### 2. Register carries document references
- `CompanyProfile` gains
  `documents: { cinCertificate: { id, sha256 }; gstinCertificate: { id, sha256 } | null }`.
- `POST /orgs/register` body: `company.documents.cinCertificate.id` REQUIRED,
  `company.documents.gstinCertificate.id` optional. The route resolves each id
  via `deps.documents.get`; a missing/unknown id → 400 `DOCUMENT_NOT_FOUND`.
  The stored sha256 comes from the SERVER's document record (never trusted from
  the client body).
- Signup wizard Step 1 gains a "Documents" section: CIN certificate file picker
  (required to pass Step 1), GSTIN certificate picker shown when the GSTIN field
  is non-empty. Files upload on selection (base64 via the public endpoint) with
  per-file progress/error; the Review step lists name + sha256 prefix.

### 3. Approval = DID issuance ceremony
`POST /orgs/:id/approve` (PlatformAdmin, single approver — unchanged shell),
new order (org credential deliberately LAST):
1. Chain-first `registry.anchor.registerDid(org.did)` — failure → 502
   `REGISTRY_UNAVAILABLE`, nothing changed (unchanged).
2. Activate: `setStatus("active")` + `setVerified(true, now)` (unchanged).
3. Mint the OrgAdmin membership VC + `active:true` (unchanged, inside the
   existing try/catch with the admin-identity snapshot).
4. **Issue the OrganizationCredential** (same try/catch): issuer = the platform
   org from `ensurePlatformIssuerOrg(deps)` (self-heals its DID registration),
   subject = the corporate org DID, `type: "OrganizationCredential"`, claims =
   KYB facts `{ name, cin, pan, gstin, state, pincode, dateOfIncorporation,
   category, orgType }`, `proposalId: null`, via the existing
   `issueCredentialFor` — which signs → anchors (fail-closed when a registry is
   present) → persists, so a throw leaves NO credential row. Issuing LAST means
   a failure here needs only the EXISTING rollback (org → pending/unverified +
   admin identity restored from the snapshot) and no credential compensation.
   (Accepted residues, both pre-existing/negligible: an orphaned membership-
   credential row if the failure lands between the two steps, and an on-chain
   anchor without a row if the final DB write itself throws.)
5. Audit `org-approved` payload gains `{ orgCredentialId, issuerDid }`. The 200
   response gains `{ issuerDid, orgCredentialId }`.

### 4. Org views expose issuance
- `GET /orgs/:id` (and the list) — `orgView` gains
  `credentials: [{ id, type, issuerDid, issuedAt, revoked }]` from
  `deps.credentials.listByHolder(org.did)` (org-scoped route, already guarded).
  Only on the single-org GET if list cost matters; acceptable either way at this
  scale — implement on BOTH for one consistent shape.
- Web, corporate side (Organizations view as OrgAdmin): the org card shows
  "DID — pending issuance" while `status !== "active"`; once active it shows the
  DID, an "Issued by TokenLayer Platform" line (issuerDid resolved to the
  platform org name), and the OrganizationCredential status pill via the public
  `GET /credentials/:id/status` (on-chain/anchored, as elsewhere).

### 5. PlatformAdmin review experience (web)
- `PendingOrgs` rows gain a **Review** toggle expanding to: the existing KYB
  grid + a "Documents" row with authenticated download links (fetch with bearer
  → blob → save; label = "CIN certificate", "GSTIN certificate", sha256 prefix).
- After a successful approve, the queue shows a success notice:
  "DID issued by TokenLayer Platform · registered on-chain ·
  OrganizationCredential anchored" (from the approve response).
- Reject flow unchanged.

## API surface (summary)

| Route | Auth | Change |
|---|---|---|
| `POST /orgs/register/documents` | public (throttled) | new — upload a KYB document |
| `POST /orgs/register` | public | body gains `company.documents` (CIN required) |
| `POST /orgs/:id/approve` | PlatformAdmin | + platform-issued OrganizationCredential; response gains issuerDid/orgCredentialId |
| `GET /orgs`, `GET /orgs/:id` | scoped | orgView gains `credentials` (held by the org DID) |
| `GET /documents/:id` | issue-capable/Auditor | UNCHANGED (reviewer downloads) |

## Error handling
- Upload: 415 unsupported type, 413 too large, 400 empty, 429 throttled.
- Register: 400 `DOCUMENT_NOT_FOUND` for a bad/missing CIN doc id (schema makes
  `cinCertificate` required); other guards unchanged.
- Approve: 502 `REGISTRY_UNAVAILABLE` chain-first (unchanged); org-credential
  issuance/anchor failure → full rollback (org pending, admin locked; no
  credential row exists because issueCredentialFor persists nothing on throw)
  → 502; membership failure → existing rollback (unchanged).

## Out of scope (explicit)
- Additional documents (PAN card, IEC, MCA), document re-upload/replacement
  after submission, and orphan-upload cleanup.
- Verifying document CONTENT (OCR/validation) — reference numbers are attested
  by the OrganizationCredential claims, not the files.
- Choice of DID issuer (the platform org is the sole issuer).
- Revoking the OrganizationCredential (existing credential revoke machinery
  already applies if needed).

## Testing
**API (vitest, corporate.test.ts + doubles):**
1. Public upload: 201 with sha256; 415 bad type; 413 oversize; register with the
   returned id persists `companyProfile.documents` (server-side sha256); bad doc
   id → 400 `DOCUMENT_NOT_FOUND`; schema rejects a register without a CIN doc.
2. Approve (FakeAnchor): response has `issuerDid` = platform org DID and
   `orgCredentialId`; the credential exists with holder = org DID, type
   `OrganizationCredential`, KYB claims, anchored in the double; `GET /orgs/:id`
   shows it under `credentials`.
3. Rollback: arm `failNext="anchorCredential"` (post-boot, matching the
   established pattern) → approve → 502, org back to pending, admin cannot log
   in, NO OrganizationCredential row exists (anchor-before-persist).
4. The reviewer can `GET /documents/:id` (PlatformAdmin); an unauthenticated GET
   is refused (existing behaviour, asserted once).

**Live Besu E2E (`scripts/corporate-e2e.mjs` extended):** upload both documents →
register referencing them → review shows them → approve → independent `eth_call
statusOf(orgCredentialId)` proves the OrganizationCredential anchored on-chain
(alongside the existing `resolve(orgDid)` proof) → the flow continues (use case,
issuer, asset) unchanged.

**Browser:** signup with two file uploads → PlatformAdmin Review expansion shows
KYB + downloads both files → approve → success notice with issuance attribution →
log in as the corporate admin → org card shows DID "Issued by TokenLayer
Platform" + credential pill.
