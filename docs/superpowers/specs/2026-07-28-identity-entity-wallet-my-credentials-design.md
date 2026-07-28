# Identity Domain — Entity Wallet + My Credentials (ID-C) — Design

**Goal:** Make an **organization a first-class credential holder** (issue + hold), and give both an entity and a person a **rich credential wallet**. Today the ID-B runtime issues a configured credential only to a *user's* sub-DID, and the personal "My identity" page shows only that user's credentials with minimal cards. ID-C lets a bound issuer issue a configured credential to an **org's own DID**, gives the OrgAdmin a dedicated **Organization Wallet** of the entity's held credentials, and upgrades credential presentation (use-case label, issuer name, full-claims detail, VC-JWT download) across both the personal and entity wallets.

**Program context:** ID-C is sub-project 3 of the 5-part Identity program (one XI app, two pluggable domains): **ID-A** configurable credential use-case engine (MERGED) · **ID-B** issuer/holder/verifier runtime (MERGED) · **ID-C** entity wallet + My Credentials (this spec) · **ID-D** QR-code login · **ID-E** pluggable domain shell.

**Tech stack:** apps/api (Fastify + Prisma/SQLite + Vitest) + apps/web (React + Vite + Tailwind). **No packages/core change** — `holderPolicyAllows` already accepts an org, and `issueCredentialFor` already stamps `holderDid` generically (the KYB `OrganizationCredential` is already issued to an org's own DID this way).

---

## Scope

**In scope (ID-C):**
- **Issue-to-org**: the ID-B issuance route accepts an organization as the subject/holder (holderDid = org's DID), gated by the same holder policy.
- **Eligible holders = users + orgs**: the issuer's holder picker offers both eligible users and eligible orgs.
- **Organization Wallet**: a dedicated OrgAdmin surface listing the entity's held credentials.
- **Richer credential presentation**: a shared credential card + inline detail (full claims, use-case label, issuer org name, copy/download VC-JWT), reused by the Organization Wallet and the personal My Credentials.

**Out of scope (later / deferred):**
- **Org-side presentation** — a verifier requesting a proof from an organization and an OrgAdmin consenting/presenting on the entity's behalf (org custodial key signs the VP). Presentation stays user-DID-only for now. This is a natural follow-up slice.
- QR-code login / QR credential sharing — **ID-D**. Domain selector — **ID-E**.
- Any packages/core change; any new on-chain behavior (org DIDs are already registered; credential anchoring is unchanged).

---

## Architecture

Three API extensions + a web layer, all building on the ID-B runtime:

1. **Issue-to-org (api)** — `POST /credential-use-cases/:key/credentials` accepts `subjectOrgId?` alongside `subjectUserId?`.
2. **Eligible holders (api)** — `GET …/eligible-holders` returns a discriminated users+orgs list.
3. **Entity wallet + richer read model (api)** — `GET /orgs/:id/wallet` + a shared enriched held-credential projection (adds `credentialUseCaseKey` + resolved issuer org name), also applied to `GET /me/credentials`.
4. **Web** — a shared `CredentialCard`/detail component; a new `OrganizationWallet` + nav item; the issue form gains org holders; `MyIdentity` adopts the shared card.

The unifying principle: **holderDid is holder-kind-agnostic**. A credential's `holderDid` is either a user's sub-DID or an org's parent DID; the wallet views simply query `listByHolder(did)` for the relevant DID. No credential-model change is needed — only issuance can now target an org, and the reads are richer.

---

## 1. Issue-to-org (api)

`POST /credential-use-cases/:key/credentials` — body becomes `{ credentialType, subjectUserId?, subjectOrgId?, claims }` with **exactly one** of `subjectUserId`/`subjectOrgId` (else `400 SUBJECT_REQUIRED`). Handler, after the existing issuer-authorization + type resolution:

- **User subject** (unchanged path): resolve the user → `subjectDid = user.did` (`400 SUBJECT_HAS_NO_DID` if absent); holder org = `user.orgId ? get : null`.
- **Org subject** (new): resolve the org (`404` if absent) → `subjectDid = org.did`; holder org = the org itself `{ id: org.id, orgType: org.orgType }`. (Orgs always have a DID; a defensive `SUBJECT_HAS_NO_DID` guard still applies.)
- **Holder eligibility** (both): `holderPolicyAllows(def.holderPolicy, holderOrg)` → `403 HOLDER_NOT_ELIGIBLE`.
- `validateMetadata(claims, spec.claimSchema)` → `400 INVALID_METADATA`.
- Park the proposal with a payload carrying the generic `subjectDid` plus a subject descriptor for record-keeping (`subjectUserId`/`subjectOrgId`, whichever applies) + `credentialUseCaseKey`, `credentialType`, `claims`, `issuerOrgId`, `required = spec.requiredApprovals`. `202`.

`issueUsecaseCredentialKind.execute` re-resolves config fresh and calls `issueCredentialFor` with `subjectDid` + `spec.validityDays` + `credentialUseCaseKey` — **no change** beyond reading the subjectDid the route already resolved; `holderDid = subjectDid` (the org's DID for an org subject). Maker-checker depth, on-chain anchoring, and revocation are unchanged.

## 2. Eligible holders = users + orgs (api)

`GET /credential-use-cases/:key/eligible-holders` — same issuer-authorization gate. Returns a **discriminated** array:
- eligible **users**: DID-holding users whose org passes `holderPolicyAllows` → `{ kind: "user", id, label: email, did, subLabel: orgName | null }`.
- eligible **orgs**: organizations that pass `holderPolicyAllows({ id, orgType })` → `{ kind: "org", id, label: name, did, subLabel: orgType }`.

The issuer's Issue form renders both in one picker.

## 3. Entity wallet + richer read model (api)

**Shared enriched projection** for a held credential (a small helper `heldCredentialView(c, issuerName)`):
```
{ id, type: string[], credentialUseCaseKey, issuerDid, issuerName, holderDid,
  claims, issuedAt, expiresAt, revoked, revokedAt, revokedReason, vcJwt }
```
- `credentialUseCaseKey` — already on `CredentialRecord` (ID-B); newly surfaced.
- `issuerName` — resolved via `organizations.findByDid(issuerDid)?.name ?? null`.

**Routes:**
- `GET /me/credentials` — same as today but through the enriched projection (adds `credentialUseCaseKey` + `issuerName`).
- `GET /orgs/:id/wallet` (**new**, org-scoped via the existing `orgScoped` guard — the org's OrgAdmin or a PlatformAdmin) → `listByHolder(org.did)` through the enriched projection. `404` if the org is missing; `403` if the caller is not scoped to it.

Issuer-name resolution is a small per-credential lookup; wallets hold few credentials, so an inline `findByDid` per row is acceptable (a memoized map within the request handler avoids repeat lookups for the same issuer).

## 4. Web

- **Shared `CredentialCard` + inline detail** (`apps/web/src/components/CredentialCard.tsx`) — lifted from `MyIdentity`'s inline card. Card face: type pills, valid/revoked pill, anchored·chainId / unanchored pill (via the public `credentialStatus`), **use-case label** (from `credentialUseCaseKey`), **issuer org name** (`issuerName`, falling back to a truncated `issuerDid`), issued/expires. A "Details" toggle expands: a full **claims table**, the use case, issuer, holder DID (copyable), and **Copy / Download** the raw `vcJwt`. Props: `{ credential: HeldCredential; status?: CredentialStatusInfo }`.
- **`OrganizationWallet.tsx`** (new) — header with the org name + org DID; the org's credentials fetched from `api.orgWallet(orgId)` rendered with `CredentialCard`; `EmptyState` when none. Uses `useAuth().user.orgId`.
- **Nav** — add an **"Organization Wallet"** item for OrgAdmins in `App.tsx`'s operator-console branch (mirroring how ID-B added Identity): `...(isOrgAdmin ? [{ id: "org-wallet", label: "Organization Wallet", icon: "wallet"|"coins" }] : [])` + a panel branch rendering `<OrganizationWallet />`. OrgAdmin-only (a PlatformAdmin views org credentials through the existing Organizations admin view).
- **`MyIdentity`** — replace its inline card with `<CredentialCard>` (gains use-case label, issuer name, download).
- **Issue form** (`IssueUsecaseCredential`) — the holder `<select>` lists both users and orgs from the extended `eligible-holders` (option label shows kind, e.g. "🏢 Acme Ltd (org)" vs the user email); submit sends `subjectUserId` or `subjectOrgId` by the picked row's `kind`.
- **types.ts / api.ts** — `EligibleHolder` gains `kind: "user" | "org"` + `subLabel?`; `HeldCredential` gains `credentialUseCaseKey?: string | null` + `issuerName?: string | null`; `issueUsecaseCredential` body accepts `subjectUserId?`/`subjectOrgId?`; add `orgWallet(token, orgId) → HeldCredential[]`.

## Data flow

A bound Issuer opens Issue-credential → picks a credential type + an eligible **org** (or user) + fills claims → maker-checker → on approval `issueCredentialFor` signs (issuer org key), anchors on-chain, persists with `holderDid = org.did`. The org's **OrgAdmin** opens **Organization Wallet** → sees the entity's credentials with use-case + issuer labels → opens a card's detail → copies/downloads the VC-JWT. The same richer card renders a person's credentials on **My Credentials**.

## Error handling

Coded, HTTP-mapped: `SUBJECT_REQUIRED` (400 — neither or both of subjectUserId/subjectOrgId), plus the existing issuance gates (`UNKNOWN_USECASE`, `ISSUER_NOT_PERMITTED`, `UNKNOWN_CREDENTIAL_TYPE`, `SUBJECT_HAS_NO_DID`, `HOLDER_NOT_ELIGIBLE`, `INVALID_METADATA`); `403 FORBIDDEN` / `404` for a non-scoped or missing org on `GET /orgs/:id/wallet`. The web issue form surfaces the coded message inline.

## Testing

- **api (behavioural):** issue-to-org → approve → the credential appears in `GET /orgs/:id/wallet` with `holderDid === org.did`; `SUBJECT_REQUIRED` when neither/both subject ids given; a holder-policy-restricted use case rejects an ineligible org subject (`HOLDER_NOT_ELIGIBLE`) and admits an eligible one; `eligible-holders` includes both a `kind:"user"` and a `kind:"org"` row for an `any-onboarded` policy; `GET /me/credentials` + the wallet carry `credentialUseCaseKey` + `issuerName`; `GET /orgs/:id/wallet` is org-scoped (403 for a foreign OrgAdmin, 200 for the org's own admin / a PlatformAdmin).
- **web:** tsc + build; a live-Besu browser walkthrough — issue a credential to a corporate org, approve it, open the corporate OrgAdmin's Organization Wallet, see the credential with its use-case + issuer labels, expand detail, download the VC-JWT.

## Verification / done

Full api suite green (with the new tests) + web tsc/build + a live browser walkthrough of the entity-wallet loop (issue-to-org → org wallet → detail/download), then finish the branch. ID-D (QR login) and the deferred org-presentation slice build on the entity holder this produces.
