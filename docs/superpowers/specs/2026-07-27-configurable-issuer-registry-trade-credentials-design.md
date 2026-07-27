# Configurable DID/VC Issuer Registry + Trade Credentials — Design (SP1)

**Goal:** Let corporates request government/trade verifiable credentials (MCA, GSTIN, IEC, PAN); each request routes to whichever issuer is *configured* for that credential type in that use case; the configured issuer approves → the VC is issued to the corporate's DID, anchored on-chain, and verifiable through the existing verification flow. **No issuer is hardcoded** — issuers and their credential-type bindings are configuration.

**Context:** This is sub-project 1 of a "Vishwas replica" (reference: https://demo.testbtn.in — register → portal review → DID → govt VCs → verify). XI Tokenize already has the DID/VC backbone: corporate self-registration + KYB docs, a PlatformAdmin review queue, a DID issuance ceremony (on-chain org DID + `OrganizationCredential`), a closed credential-type catalog, `issueCredentialFor` (sign → anchor on `VcRegistry` → persist), on-chain `DidRegistry` issuer trust, and a `VerificationRequest` proof-request/verify flow. SP1 adds the *government trade credentials* and makes their issuers **config-driven and selectable per use case**. The Govt-of-India issuer (MCA/GSTIN/IEC/PAN) becomes one configured example, not a hardcode.

**Tech Stack:** packages/core (credential catalog, config types), apps/api (Fastify + Prisma/SQLite + Vitest), apps/web (React + Vite + Tailwind). Reuses `Organization`, `credentialTypeDef`/`CREDENTIAL_TYPES`, `issueCredentialFor`, `ensureNamedOrg`/on-chain DID registration, and mirrors the `VerificationRequest` model for `CredentialRequest`.

---

## Scope

**In scope (SP1):** the four trade credential types; a configurable issuer registry; per-use-case issuer bindings; the corporate-requests → issuer-approves flow (persistence + routes + web); seeding + on-chain trust of configured issuers.

**Out of scope (later sub-projects):**
- **SP2** — DID-issuer *selection at corporate signup* (Vishwas step 3). SP1 builds the registry's `didIssuers` config; SP2 wires the selection UI + routes the DID-minting to the chosen issuer.
- **SP3** — verifier proof requests that specifically target the new trade credential types (the generic verify flow already exists).
- **SP4** — Key People / `AuthorizedSignatory` credentials for corporate employees.

---

## Architecture

Five components, each with one responsibility:

1. **Credential catalog (core)** — the four trade credential type definitions.
2. **Issuer registry (config + boot)** — `config/issuers.json` → seeded issuer orgs with DIDs + a capability map.
3. **Per-use-case identity binding (config + core + persistence)** — an `identity` block on each use case selecting issuers from the registry.
4. **CredentialRequest (persistence + API)** — the request→approve/reject lifecycle.
5. **Web** — a corporate "Trade Credentials" view and an issuer "Credential Requests" inbox.

Data flow: corporate `POST /credential-requests {useCaseKey, credentialType, assertedClaims}` → server resolves the configured issuer for that (type, use case) + prefills claims from the corporate's KYB `companyProfile` → **pending** request in the issuer's queue → issuer `POST /credential-requests/:id/approve` → `issueCredentialFor(issuerOrg, subjectDid, type, claims)` (sign → anchor → persist) → request **approved** with `issuedCredentialId` → the VC appears in the corporate's `My Credentials` and verifies via the existing flow (issuer DID is on-chain-trusted).

---

## 1. Credential catalog (core)

Extend `packages/core/src/credential-types.ts`: widen the `CredentialType` union and add four entries to `CREDENTIAL_TYPES`. All: `allowedIssuerOrgTypes: ["government"]`, `requiredApprovals: 1`, `validityDays: 365` (PAN longer-lived is fine at 365 for the demo), `selfIssuedOnly: false`. Each credential carries an `authority` claim naming the real body.

| Type | Required claims | Optional | Authority |
|---|---|---|---|
| `MCACredential` | `cin`, `companyName` | `incorporationDate`, `companyStatus` | MCA21 |
| `GSTINCredential` | `gstin`, `legalName` | `stateCode` | GSTN |
| `IECCredential` | `iec`, `entityName` | — | DGFT |
| `PANCredential` | `pan`, `name` | — | Income Tax Department |

`claimSchema` uses the same `MetadataSchema` shape already in the file (validated by `validateMetadata`). Add `cin`/`gstin`/`iec`/`pan` patterns where cheap (e.g. PAN `^[A-Z]{5}[0-9]{4}[A-Z]$`, GSTIN 15-char). The closed-catalog tests in core AND api that assert the full type list must be updated.

## 2. Issuer registry (config + boot)

New `config/issuers.json` — the catalog of issuer organizations and their capabilities:
```json
[
  { "id": "gov-in", "name": "Government of India", "orgType": "government",
    "jurisdiction": "IN", "didIssuer": true,
    "issues": ["MCACredential", "GSTINCredential", "IECCredential", "PANCredential"] }
]
```
A core loader `loadIssuerRegistry()` (in `packages/core`, mirroring `loadDefaultUseCaseDefinitions`) parses + validates it into typed `IssuerDefinition[]`. At API boot (non-production, after the platform org), for each entry: `ensureNamedOrg(deps, {name, orgType, jurisdiction})` (idempotent seed + on-chain DID registration so its credentials verify) and seed one OrgAdmin operator for it (e.g. `gov.admin@tokenlayer.dev` / `gov123`) via the existing desk-provisioning helpers, linking the user's `orgId` to the issuer org so it is scoped to that issuer. The capability map (`issuerOrgId → issuableTypes`, `didIssuer`) is derived at boot and exposed on `AppDeps` (e.g. `deps.issuerRegistry`).

**Trust:** issuer credentials verify because the issuer org's DID is registered in the on-chain `DidRegistry` (done by `ensureNamedOrg`). No change to the verifier trust computation is needed.

## 3. Per-use-case identity binding (config + core + persistence)

Each `config/use-cases/*.json` gains an optional `identity` block:
```json
"identity": {
  "didIssuers": ["gov-in"],
  "credentialIssuers": {
    "MCACredential": "gov-in", "GSTINCredential": "gov-in",
    "IECCredential": "gov-in", "PANCredential": "gov-in"
  }
}
```
- Core `UseCaseDefinition` gains `identity?: { didIssuers: string[]; credentialIssuers: Record<string, string> }`; validated on load (every referenced issuer id must exist in the registry, and must be `didIssuer` / capable of the bound type respectively).
- Prisma `UseCase` gains an `identity String @default("{}")` JSON column (like `valuation`/`terms`); the repo mapper JSON-(de)serialises it; the `UseCase` API schema exposes it. `invoice-tokenization` ships with the block above; other use cases omit it (no trade credentials).

Resolution helper (core): `resolveCredentialIssuer(useCase, type, registry) → issuerId | null` and `credentialCatalogFor(useCase) → { type, issuerId, issuerName, claimSchema }[]`.

## 4. CredentialRequest (persistence + API)

**Model** (Prisma, mirrors `VerificationRequest`):
```
model CredentialRequest {
  id                 String    @id @default(cuid())
  useCaseKey         String
  subjectDid         String            // the corporate's DID
  subjectOrgId       String            // the corporate org
  issuerOrgId        String            // resolved from config at request time
  credentialType     String
  assertedClaims     String            // JSON — prefilled from KYB + corporate input
  status             String    @default("pending") // pending | approved | rejected
  issuedCredentialId String?           // set on approve
  reason             String?           // set on reject
  requestedBy        String
  createdAt          DateTime  @default(now())
  decidedAt          DateTime?
  @@index([issuerOrgId, status])
  @@index([subjectOrgId])
}
```
Repo `CredentialRequestRepository`: `create`, `get`, `listByIssuer(issuerOrgId, status?)`, `listBySubject(orgId)`, `setStatus(id, status, patch)`. Memory + Prisma implementations; wired into `AppDeps`.

**Routes** (all `...auth`):
- `GET /use-cases/:key/credential-catalog` — the requestable credentials for this use case (from `credentialCatalogFor` + prefill hints from the caller's org `companyProfile`). Any authenticated member of a corporate in that use case.
- `POST /credential-requests` — body `{ useCaseKey, credentialType, assertedClaims }`. Caller must be an **OrgAdmin** of a corporate that holds a DID. Server: resolve issuer via config (404 `NO_CONFIGURED_ISSUER` if none); merge `assertedClaims` over KYB-prefilled values; `validateMetadata` against the type's `claimSchema` (400 `INVALID_CLAIMS`); create pending request. 201.
- `GET /credential-requests` — role-scoped: an **issuer-org OrgAdmin** sees `listByIssuer(theirOrg, status?)`; a **corporate OrgAdmin** sees `listBySubject(theirOrg)`. `?status=` filter.
- `POST /credential-requests/:id/approve` — caller must be an OrgAdmin of the request's `issuerOrgId` (403 `FORBIDDEN` otherwise). Re-validate claims; `issueCredentialFor({ issuerOrg, subjectDid, type, claims, proposalId: null })`; on success set status `approved` + `issuedCredentialId`; append audit. Anchor-before-persist invariants are inherited from `issueCredentialFor` (throw ⇒ request stays pending, nothing persisted). 200.
- `POST /credential-requests/:id/reject` — body `{ reason }`. Issuer-org OrgAdmin only. Status `rejected`. 200.

Idempotency/guards: approve/reject only from `pending` (409 `ALREADY_DECIDED`); the subject DID must still resolve.

## 5. Web

- **Corporate (OrgAdmin) — "Trade Credentials"** (new nav item, visible when the active use case has an `identity` block): lists the configured requestable credentials with status (none / pending / issued / rejected). "Request" opens a form prefilled from KYB (CIN/PAN/GSTIN read-only where known; IEC entered) → `POST /credential-requests`. Issued VCs also appear in the existing **My Credentials**.
- **Issuer (OrgAdmin of an issuer org) — "Credential Requests" inbox**: pending requests routed to their org → review asserted claims → **Approve** (issue) / **Reject (reason)**. Mirrors the existing Verification/Approvals inbox styling.
- **api.ts / types.ts**: client methods for the four routes + a `CredentialRequest` type + `TradeCredentialCatalogEntry` type.

## Error handling

Coded errors, consistent with the codebase: `NO_CONFIGURED_ISSUER` (404), `INVALID_CLAIMS` (400), `FORBIDDEN` (403, wrong issuer/role), `ALREADY_DECIDED` (409), `SUBJECT_NO_DID` (400, corporate lacks a DID), `NOT_FOUND` (404). `issueCredentialFor` failures (chain/anchor) surface as 502-style and leave the request `pending` for retry.

## Testing

- **core**: catalog now includes the four types (update closed-list tests); `identity` config validation (unknown issuer id, type not issuable by bound issuer → throw); `resolveCredentialIssuer` / `credentialCatalogFor`.
- **api** (behavioural, in-memory + a fake anchor): request → appears in issuer queue → approve issues a credential to the subject DID (assert `credentials.listByHolder`), request `approved` with `issuedCredentialId`; reject path; scope guards (non-issuer cannot approve; corporate sees only its own; `NO_CONFIGURED_ISSUER` for a use case with no binding); `INVALID_CLAIMS`; `ALREADY_DECIDED`.
- **live (Besu)**: seed gov-in issuer, register a corporate, request MCA/GSTIN → approve as gov admin → the VC verifies via the existing verification flow (issuer DID trusted on-chain). Browser walkthrough of both views.

## Verification / done

Full api suite green (with the new behavioural tests) + web tsc/build clean + a live Besu browser walkthrough (corporate requests → gov issuer approves → VC in wallet → verifies), then finish the branch.
