# Digital Identity (DID / Verifiable Credentials) Verification — Design

**Date:** 2026-07-10
**Status:** Approved (brainstorm decisions locked with user)

## Goal

Automate investor identity verification with **decentralized identity** — product-vision
item #2, *"Enterprise-Grade Tokenization — Identify investors via digital identity."* Replace
the manual `PATCH kycStatus` desk approval with a cryptographic, self-sovereign flow: an
investor holds a **KYC Verifiable Credential** bound to their **DID**; the desk verifies a
**Verifiable Presentation** of it; on success the platform auto-sets `kycStatus=approved` and
populates `kyc.country` from the credential — which the existing fail-closed jurisdiction
engine and the investor portal already consume unchanged.

## Decisions (locked)

1. **Trigger:** desk-initiated. The desk holds the investor (existing user model) and runs
   verification; manual `PATCH kycStatus` remains as an override fallback. No public/self-service
   applicant routes (deferred).
2. **Model:** DID + W3C Verifiable Credentials. The "identity provider" is a **trusted VC
   issuer**; the platform is the **verifier**.
3. **Rigor:** full **VP + holder proof**. Platform issues a one-time challenge; the investor
   presents a VP (their VC, wrapped and signed by their own DID key over that challenge).
   Verify BOTH the holder's presentation signature AND the issuer's credential signature.
4. **Format:** VC-JWT / VP-JWT (signed JWTs) — not JSON-LD.
5. **DID method:** `did:key` with **Ed25519** (public key embedded in the DID; offline,
   deterministic). DID resolution kept behind a small pluggable seam so `did:ethr`/`did:web`
   can be added later.
6. **Crypto:** Node's built-in `crypto` (native Ed25519) — **zero new dependencies** (verified:
   Node signs/verifies Ed25519 and reconstructs a public KeyObject from the raw 32-byte key via
   the SPKI prefix `302a300506032b6570032100`, matching `did:key` decode).
7. **v1 checks:** issuer-trust + expiry (`exp`/`nbf`) + holder-proof + subject-binding
   (`vc.credentialSubject.id === holderDid`). Revocation (StatusList2021) deferred.

## Architecture

Pure verification logic in `packages/core`; challenge state + user wiring + routes in `apps/api`;
a desk action in `apps/web`. Mirrors the house "pure core, I/O in the API" split and the
"real-or-absent" provider philosophy (no trusted issuers configured ⇒ verification closed,
manual approval still available).

### Core — `packages/core/src/identity.ts` (pure, dependency-free)

Uses `node:crypto` only. Exports:

- **did:key ⇄ key**: `didKeyFromPublicKey(raw: Buffer): string` (multibase base58btc + multicodec
  `0xed01` prefix → `did:key:z6Mk…`), and `publicKeyFromDidKey(did: string): crypto.KeyObject`
  (base58btc decode → strip multicodec → SPKI-wrap the 32-byte key). A minimal base58btc
  encode/decode lives here (no dep).
- **JWT (EdDSA)**: `signJwt(header, payload, privateKey): string` and
  `verifyJwtSignature(jwt: string, publicKey): boolean` — base64url segments, `crypto.sign/verify`
  with `null` algorithm (Ed25519). `decodeJwt(jwt): { header, payload }`.
- **`verifyPresentation(input): PresentationResult`** where
  `input = { vpJwt: string, challenge: string, trustedIssuers: string[], now: number }` and
  `PresentationResult = { valid: boolean, reason?: string, holderDid?: string, credential?: { issuer: string, subject: string, claims: Record<string, unknown>, issuedAt?: number, expiresAt?: number } }`.
  Steps, first failure wins with a coded `reason`:
  1. `decodeJwt(vpJwt)`; holder DID = VP `iss`. `publicKeyFromDidKey(holderDid)`;
     `verifyJwtSignature(vpJwt, holderKey)` → else `BAD_HOLDER_PROOF`.
  2. VP `nonce` === `challenge` → else `CHALLENGE_MISMATCH`. (Challenge TTL is enforced by the
     API's store, not here.)
  3. Extract the inner VC-JWT from `vp.vp.verifiableCredential[0]` → else `NO_CREDENTIAL`.
  4. `decodeJwt(vcJwt)`; issuer DID = VC `iss`. `publicKeyFromDidKey(issuerDid)`;
     `verifyJwtSignature(vcJwt, issuerKey)` → else `BAD_ISSUER_SIGNATURE`.
  5. `issuerDid ∈ trustedIssuers` → else `UNTRUSTED_ISSUER`.
  6. VC `exp` present and `exp >= now`, `nbf`/`iat` ≤ now → else `CREDENTIAL_EXPIRED`.
  7. `vc.sub` (or `vc.vc.credentialSubject.id`) === `holderDid` → else `SUBJECT_MISMATCH`.
  8. Return `{ valid: true, holderDid, credential: { issuer, subject, claims, issuedAt, expiresAt } }`
     where `claims` = the VC `credentialSubject` (minus `id`) — carries `country`, `legalName`,
     optional `kycLevel`.
- **Dev issuer/holder helpers** (for tests + the demo minter; pure): `generateDidKey()` →
  `{ did, privateKey, publicKey }`; `issueCredential({ issuer, subject, claims, expiresAt, now })`
  → VC-JWT; `presentCredential({ holder, vcJwt, challenge, now })` → VP-JWT.

### API — `apps/api`

- **Challenge store** `apps/api/src/identity-challenges.ts`: injected `ChallengeStore` interface
  (`issue(userId): {challenge, expiresAt}`, `consume(userId, challenge): boolean`) with an
  in-memory TTL (5 min) implementation. Single-instance demo scope — documented; swappable.
  Wired into `AppDeps`.
- **Config**: `TRUSTED_KYC_ISSUERS` (comma-separated issuer DIDs) → `deps.trustedKycIssuers: string[]`.
  Empty ⇒ every verify returns `UNTRUSTED_ISSUER`; manual approval unaffected.
- **Dev issuer**: the `/identity/mint` dev endpoint (and the E2E) use a deterministic dev issuer
  keypair derived from a fixed dev seed; its DID is added to `TRUSTED_KYC_ISSUERS` in the demo
  compose so minted credentials verify. In production the dev endpoint is absent and only real,
  externally-issued credentials from configured trusted issuers verify. The `credentialId` stored
  on the user is the VC-JWT `jti`.
- **Persistence**: `UserRecord.did?: string`; `KycDetails` gains optional
  `{ issuerDid?, credentialId?, verifiedAt? }`. Prisma `User.did String?` column
  (`prisma db push` at boot, no migration file) + memory-repo mirror; `UserRepository.update`
  widened to accept `did` and `kyc`.
- **Routes** (`apps/api/src/http/routes.ts`), RBAC identical to the existing KYC-approve guard
  (`sameScope`: PlatformAdmin, or a scoped user-manager for a non-UCA target in their use case):
  - `POST /users/:id/identity/challenge` → `{ challenge, expiresAt }` (scoped to target user).
  - `POST /users/:id/identity/verify` `{ presentation: string }`: `consume` the challenge (else
    `CHALLENGE_EXPIRED`), `verifyPresentation({ vpJwt, challenge, trustedIssuers, now })`; on
    `valid` → `users.update(id, { kycStatus: "approved", did: holderDid, kyc: { ...existing,
    country: claims.country, legalName: claims.legalName, issuerDid, credentialId, verifiedAt } })`
    and return `{ status: "approved", did, claims, issuer }`; on failure → `reply.code(400)
    .send({ error: reason, message })`. Append a `kyc-verified` audit entry (asset-less, the
    `__none__` chain) recording `{ userId, did, issuer, country }` for the tamper-evident trail.
  - `POST /identity/mint` (dev-only, gated by `deps.devTools` / non-production, PlatformAdmin):
    given `{ subjectDid, claims, challenge }` mint a VP using a configured dev issuer key so the
    web UI + demo can produce a valid credential without an external wallet. Absent in production.

### Web — `apps/web`

User Management gains a **"Verify identity (DID/VC)"** action per pending user: request a
challenge, paste the investor's VP-JWT (or, in dev, "Generate demo credential" → calls
`/identity/mint`), submit → shows verdict + verified claims (country, legalName, issuer) and the
`kycStatus` badge flips to approved; failures render the precise reason. `api.identityChallenge`,
`api.identityVerify`, `api.identityMint` client methods + types.

## Data flow (the payoff)

Verified investor → `kyc.country` set → the existing `ComplianceProvider.jurisdictionOf`
(reads `kyc.country`) passes them at the fail-closed engine chokepoint → they can subscribe in
the investor portal. An unverified investor is blocked exactly as today. No changes to the
engine, compliance provider, or portal.

## Error handling

- All verify failures are precise 400 codes (`UNTRUSTED_ISSUER`, `CREDENTIAL_EXPIRED`,
  `BAD_HOLDER_PROOF`, `BAD_ISSUER_SIGNATURE`, `CHALLENGE_EXPIRED`, `CHALLENGE_MISMATCH`,
  `SUBJECT_MISMATCH`, `NO_CREDENTIAL`) — never a generic 500; malformed JWT input is caught and
  mapped to `MALFORMED_PRESENTATION`.
- Fail-closed: any verification error leaves `kycStatus` unchanged.
- A consumed challenge cannot be replayed (single-use); an expired one is rejected.

## Testing

- **Core unit** (`packages/core/test/identity.test.ts`): did:key roundtrip; JWT sign/verify +
  tamper detection; `verifyPresentation` happy path; and each failure mode — untrusted issuer,
  expired VC, wrong holder key (bad holder proof), forged issuer sig, challenge mismatch,
  subject≠holder, malformed input.
- **API** (`apps/api/test/identity.test.ts`): challenge issue+single-use; verify sets
  `kycStatus`/`country`/`did` and writes the audit entry; each failure code; RBAC/tenancy (only
  an in-scope user-manager may verify; cross-tenant 403); manual `PATCH` override still works;
  `TRUSTED_KYC_ISSUERS` empty ⇒ `UNTRUSTED_ISSUER`.
- **Live E2E** (`scripts/identity-vc-e2e.mjs`): mint a holder did:key; desk requests challenge;
  mint a VP from a trusted dev issuer; verify → investor `kycStatus=approved`, `country=IN`;
  then the investor **subscribes through the portal** (jurisdiction now passes) — and a
  tampered/untrusted VP is rejected with the right code. Browser: run the "Verify identity"
  action end-to-end and screenshot the approved badge + claims.

## Out of scope (later cycles)

Self-service applicant intake · revocation / StatusList2021 · `did:ethr` / `did:web` resolution ·
on-chain DID/credential anchoring · JSON-LD credentials · SSO/MFA (separate institutional-trust item).
