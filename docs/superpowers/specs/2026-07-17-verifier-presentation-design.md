# Verifier / Presentation + Selective Disclosure — Design

**Date:** 2026-07-17
**Status:** Approved (brainstorm decisions locked with user)
**Predecessors:** `#1` (`2026-07-11-organizations-identity`), `#2` (`2026-07-16-credential-issuance`),
`#4` (`2026-07-16-onchain-registry`) — all merged. This is **sub-project #3 of 4, the final one.**
**Reference:** `~/did-vc-project` — `verification_requests`/`presentations` tables + `Verifier.ts`. We
mirror its request→present→verify state machine and reject everything cryptographic about it.

## Goal

Close the loop: a **verifier** (relying party) requests a presentation, the **holder consents** and
selects which credentials to disclose, the platform signs the presentation on their behalf (keys are
custodial), and the verifier gets a **real** verification — signatures recomputed over the presented
bytes, issuer trust from the on-chain DID registry, revocation from the chain-backed status. This makes
the credentials from #1/#2 and the registries from #4 *usable* by a third party.

## Locked decisions

1. **Selective disclosure = per-CREDENTIAL selection.** Our VCs are atomic EdDSA JWTs (no SD-JWT/BBS+),
   so the holder chooses *which whole credentials* to present; each stays intact and verifiable. Per-claim
   cryptographic SD is out of scope (it needs a different issuance format — see "Out of scope").
2. **Verifier-request → holder-consent → platform-signs.** A registered verifier asks; the holder
   explicitly consents and picks credentials; only then does the platform mint the holder-signed VP.
3. **The verifier is a first-class `verifier`-orgType org** (from #1). Requests record `verifierOrgId`.
4. **Extend core to verify N credentials** — one VP, one holder proof, one challenge, N verified VCs.
5. **Revocation composes at the API layer**, on top of a still-pure core verifier.
6. **Issuer trust = on-chain DID registry (registered + active)**, falling back to `TRUSTED_KYC_ISSUERS`
   when no registry is configured (besu absent → the suite still runs).
7. **A dedicated `VerificationRequest` flow**, not the maker-checker Proposal machinery.

## What we reject from the reference repo (recorded so it isn't reintroduced)

- **Its selective disclosure is a fiction.** `POST /api/presentations/compose` returns
  `{ ...vc, credentialSubject: <stripped> }` — it drops claims but keeps the original issuer proof, so
  the presented VC is cryptographically invalid. The verify path never notices because it looks up a
  DB-stored hash by VC id rather than checking the presented bytes. We only ever present whole,
  intact VCs, and we recompute every signature over what was actually presented.
- **The live verify path checks no signatures** — not the VP proof, not the VC proof, not the challenge,
  not holder binding. The standalone `Verifier.ts` that would is unused, and its `verifyProof` is a
  `return true` stub. Our `/verify` runs the real `verifyPresentationCredentials`.
- **The challenge is never bound into the VP** → zero replay protection. Ours binds the request's nonce
  and rejects `CHALLENGE_MISMATCH`, single-use per request.
- **Audit logs record `null` for both the verifier and the subject.** Ours record the real verifier org,
  holder DID, and disclosed credential ids.
- **Duplicated request tables** (`verification_requests` + `vp_requests`). We ship one model.

## Core (`packages/core/src/identity.ts`)

Two NEW functions beside the existing single-VC `presentCredential`/`verifyPresentation`, which stay
UNCHANGED (their only production callers are the desk KYC verify at `routes.ts:1482` and the dev
`/identity/mint` at `routes.ts:1512` — both single-VC, and both must keep working byte-for-byte).

```ts
export interface PresentManyInput { holderDid: string; holderKey: KeyObject; vcJwts: string[]; challenge: string; now: number; }
/** Wrap N VC-JWTs in one holder-signed VP-JWT over a challenge. */
export function presentCredentials(p: PresentManyInput): string;

export interface PerCredentialResult {
  valid: boolean;
  reason?: string;                 // the same coded reasons as verifyPresentation, per-VC
  credential?: VerifiedCredential; // { issuer, subject, claims, issuedAt, expiresAt } when valid
}
export interface MultiPresentationResult {
  valid: boolean;                  // holder proof + challenge ok AND at least one credential present
  reason?: string;                 // MALFORMED_PRESENTATION | BAD_HOLDER_PROOF | CHALLENGE_MISMATCH | NO_CREDENTIAL
  holderDid?: string;
  credentials: PerCredentialResult[];
}
export interface VerifyManyInput { vpJwt: string; challenge: string; trustedIssuers: string[]; now: number; }
export function verifyPresentationCredentials(input: VerifyManyInput): MultiPresentationResult;
```

`verifyPresentationCredentials`: verify the holder proof + `did:key` + challenge ONCE (first-failure
returns `valid:false` with no per-credential results); then LOOP `vp.verifiableCredential[i]`, running
the existing per-VC checks (issuer `did:key` + signature → `BAD_ISSUER_SIGNATURE`; trust-list →
`UNTRUSTED_ISSUER`; expiry → `CREDENTIAL_EXPIRED`; subject-binding to the holder → `SUBJECT_MISMATCH`)
and collecting a `PerCredentialResult` each. `valid` at the top is true iff the holder proof passed AND
`credentials.length > 0`; per-credential validity is independent. **Still pure crypto — no I/O, no
revocation** (that composes at the API). This also fixes the latent bug where the single-VC verifier
silently ignores `verifiableCredential[1..]`.

## API (`apps/api`)

### `VerificationRequest` model (Prisma + Memory)

```prisma
model VerificationRequest {
  id                  String   @id @default(cuid())
  verifierOrgId       String
  holderDid           String
  requestedTypes      String   // JSON array of credential-type strings
  purpose             String
  challenge           String
  status              String   @default("pending") // pending | consented | rejected | expired
  presentationVpJwt   String?  // the holder-signed VP, set at consent
  consentedAt         DateTime?
  consentedCredentialIds String? // JSON array, set at consent
  verifierResult      String?  // JSON MultiPresentationResult + per-credential revocation/trust, set at verify
  verifiedAt          DateTime?
  createdAt           DateTime @default(now())
  expiresAt           DateTime
  @@index([holderDid, status])
  @@index([verifierOrgId, status])
}
```

Status: `pending` (verifier asked) → `consented` (holder signed a VP) | `rejected` (holder declined) |
`expired` (past `expiresAt` with no consent). `/verify` is a read that annotates `verifierResult`; it
does NOT add a status (a consented request can be verified repeatedly — verification is a pure function
of the stored VP + current chain state, and re-checking revocation later is a feature). Repos:
`create`, `get`, `listByHolder(did, status?)`, `listByVerifierOrg(orgId, status?)`, `setConsented`,
`setStatus`.

### Routes (`routes.ts` + `schemas.ts`)

- `POST /verification-requests` (a `verifier`-org OrgAdmin/PlatformAdmin) `{ holderDid, requestedTypes[],
  purpose }` → 403 `NOT_A_VERIFIER` if the caller's org's `orgType !== "verifier"`; else mint a
  challenge (reuse the 5-min ChallengeStore pattern, but the challenge lives ON the request row so it
  survives restarts and is scoped per-request, not per-user), `status: pending`, `expiresAt = now + 24h`.
  Returns the request (no challenge leak needed — it's embedded in the VP at consent).
- `GET /me/verification-requests` (any signed-in user) → the holder's inbox, `listByHolder(claims.did)`.
  For each, resolves which of the holder's credentials satisfy `requestedTypes` (so the UI can offer
  them). Empty when `claims.did` is absent.
- `GET /verification-requests/:id` — visible to the holder (`claims.did === holderDid`) or the verifier
  org (`orgScoped(claims, verifierOrgId)`); else 404.
- `POST /verification-requests/:id/consent` (**holder only**: `claims.did === req.holderDid`, else 403)
  `{ credentialIds[] }` → guards in order: request is `pending` (else 409) and unexpired (else 410
  `REQUEST_EXPIRED`); every id is the holder's own credential (`listByHolder`), of a `requestedType`,
  and **unrevoked** (400 `CREDENTIAL_NOT_ELIGIBLE` naming the offender). Then the platform signs:
  `presentCredentials({ holderDid, holderKey: keyOf(holderSeed).privateKey, vcJwts, challenge: req.challenge, now })`
  — this is the custodial signing, gated by explicit consent. Store the VP + `consentedCredentialIds` +
  `consentedAt`; `status: consented`. Audit `verification-consented`.

  Note the holder's seed: the platform holds it as `User.didSeedEncrypted` (from #1). Consent resolves
  the holder `User` by `did`, decrypts its seed via `keystore.keyOf`, signs. If the holder has no stored
  seed (a pre-#1 legacy DID) → 409 `HOLDER_KEY_UNAVAILABLE`.
- `POST /verification-requests/:id/reject` (holder only) → `status: rejected`. Audit.
- `GET /verification-requests/:id/verify` (the verifier org) → runs verification (below) on the stored
  VP, writes `verifierResult` + `verifiedAt`, returns the structured result. 409 if not yet `consented`.

### Verification composition (the honest core of this sub-project)

At `/verify`, on `req.presentationVpJwt`, in order:

1. **Compute the trusted-issuer list** (this is *how* core's trust check is fed — not a second check).
   `decodeJwt` the VP, collect the distinct `iss` of each inner VC. For each, decide trust:
   **on-chain when a registry is configured** — trusted iff `deps.registry.anchor.didRegistration(
   didRegistry, issuerDid)` returns `{ registered: true, active: true }`; **static fallback when
   `deps.registry` is absent** (besu not configured — the whole test suite) — trusted iff the DID is in
   `deps.trustedKycIssuers`. The route builds `trustedIssuers: string[]` = the subset that passed, so an
   inactive/deactivated or unlisted issuer is simply omitted.
2. **`verifyPresentationCredentials({ vpJwt, challenge: req.challenge, trustedIssuers, now })`** — one
   holder-proof + challenge check, then per-VC signature/expiry/subject/trust. A credential whose issuer
   didn't make the list in step 1 comes back with `reason: UNTRUSTED_ISSUER` → surfaced as
   `checks.trusted: false`. Core stays pure — all I/O (the on-chain reads) happened in step 1.
3. **Revocation = chain-backed**, per credential: `deps.registry.anchor.credentialStatusOf(vcRegistry,
   credentialId)` with the #4 three-way (`exists:false` NEVER read as "not revoked"; no registry → DB
   `revoked` flag). The credential id is recovered by matching the presented VC's `jti` to a stored
   `Credential.id` (our VCs set `jti = credentialId`). A presented VC whose id we don't recognise is
   reported `revoked: "unknown"` and does not count as valid.
4. Result written to `verifierResult` and returned:
   ```
   { valid, holderDid, credentials: [ { id, type, issuer, checks: { signature, trusted, notRevoked,
     notExpired, subjectBound }, valid, claims } ], purpose, verifiedAt }
   ```
   A credential is `valid` iff ALL five checks pass. The top-level `valid` is true iff the holder proof
   passed and every requested type is covered by at least one valid credential.

### Wiring

`AppDeps` already carries `credentials`, `keystore`, `registry?`, `trustedKycIssuers`, `challenges`.
Add `verificationRequests: VerificationRequestRepository`. `TokenClaims.did` (from #1) identifies the
holder. No new env.

## Data flow / trust

The verifier trusts the result because every step is real and recomputed over the presented bytes: the
holder proof binds the VP to the holder's DID and this request's challenge; each VC's issuer signature
is checked against the issuer's `did:key` (self-describing, no lookup); issuer trust is the on-chain
registry's live `registered && active`; revocation is the chain's current answer. The platform's role
is custody + consent enforcement, not trust substitution — it cannot forge a result the verifier
couldn't independently reproduce from the VP + the public chain.

## Error handling

- Non-verifier org requesting → 403 `NOT_A_VERIFIER`. Consent by a non-holder → 403. Consenting to
  someone else's / wrong-type / revoked credential → 400 `CREDENTIAL_NOT_ELIGIBLE`. Consent on a
  non-pending request → 409; on an expired one → 410 `REQUEST_EXPIRED`. `/verify` before consent → 409.
- Verification failures are NOT HTTP errors — `/verify` returns 200 with `valid:false` and the
  per-credential reasons, because "this presentation is invalid" is a successful verification outcome.
- Holder with no custodial seed → 409 `HOLDER_KEY_UNAVAILABLE` (honest; pre-#1 legacy DIDs only).

## Testing

- **Core** (`packages/core/test/identity.test.ts`): `presentCredentials` round-trips N VCs;
  `verifyPresentationCredentials` returns a per-credential verdict; one revoked-looking/expired/untrusted
  VC among valid ones is individually flagged while the others pass; challenge mismatch fails the whole
  VP; **the existing single-VC `presentCredential`/`verifyPresentation` tests stay green unchanged**
  (backward-compat gate).
- **API** (`apps/api/test/verification.test.ts`): request→consent→verify happy path (multi-credential);
  `NOT_A_VERIFIER`; consent by a non-holder → 403; consent to a non-owned/wrong-type/revoked credential →
  400; a credential revoked AFTER consent shows `notRevoked:false` at verify (revocation is live);
  challenge binding (a VP for request A cannot satisfy request B); issuer-trust fallback to the static
  allowlist when `registry` is absent (a test double supplies the on-chain path); expiry. **Independent
  proof**: decode the stored VP-JWT and verify its holder + issuer signatures OUTSIDE the API via
  `verifyJwtSignature` + `publicKeyFromDidKey`. Full suite (437) stays green.
- **Live E2E** (`scripts/verification-e2e.mjs`, real Besu): a verifier org requests KYC + membership; the
  holder consents to both; `/verify` returns both valid with issuer-trust sourced from the on-chain
  DidRegistry; then revoke one credential and re-verify → that one flips to `notRevoked:false` while the
  other stays valid; a deactivated issuer org → its credential flips to `trusted:false`.
- **Browser**: as a verifier-org OrgAdmin, request a presentation; as the holder, see the request, pick
  credentials, consent; back as the verifier, see the green/red per-credential result.

## Web (`apps/web`)

- **Verifier** (OrgAdmin of a `verifier` org): a "Request verification" form (holder DID, a checkbox
  list of credential types from `GET /credential-types`, a purpose) and a results view rendering each
  credential's five checks as pills, with the disclosed claims.
- **Holder** ("My identity" → a Verification-requests inbox): each pending request shows the verifier
  org, purpose, and requested types, with checkboxes for the holder's matching credentials; Consent
  (disabled until ≥1 eligible credential is ticked) or Reject. Nothing is signed or released pre-consent.

## Out of scope (deliberate — and this completes the 4-sub-project arc)

Per-claim cryptographic selective disclosure (needs SD-JWT/BBS+ at issuance — would re-open #2's format,
its own effort) · holder-initiated tokened share links / QR (we chose verifier-pull only) · external
no-account verifiers identified only by DID/URL · compliance CONSUMING verified presentations (still the
separately-deferred "compliance reads credentials" cycle) · verifier onboarding UX beyond reusing the
existing org-creation flow with `orgType: "verifier"`.
