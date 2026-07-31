# Pluggable DID/VC Identity Gate for Tokenization (ID-H) — Design

**Goal:** Make DID/VC identity a **pluggable compliance primitive** for tokenization: a tokenization use case gains a `requireVerifiedIdentity` toggle, and when it is on, a wallet may only **receive/hold** the token if the user behind it holds a valid, **unrevoked** identity credential. This is the capstone that wires the Identity domain (ID-A…G) into tokenization compliance.

**Program context:** The Identity domain is complete (ID-A configurable credential use cases · ID-B issuer/holder/verifier runtime · ID-C wallet · ID-D QR login · ID-E domain shell · ID-F scoped desks · ID-G template provisioning). Tokenization already has a `compliance` block (allowlist, `allowedJurisdictions` via holder KYC country, `maxHolders`, `lockupDays`) enforced through a `ComplianceProvider` the `LifecycleEngine` consumes fail-closed. ID-H adds one more provider-backed rule: a held-credential identity gate.

**Tech stack:** packages/core (the `compliance.requireVerifiedIdentity` flag + a `ComplianceProvider.hasVerifiedIdentity` method + the engine enforcement point) + apps/api (the provider impl reads held credentials + revocation) + apps/web (the builder compliance toggle + error surfacing). No new persistence model; reuses the ID-A/B/C `credentials` repo and revocation state.

---

## The seam

`ComplianceProvider` (types.ts:257) is the exact extension point: it already exposes `jurisdictionOf(account)` (address → account → user → `kyc.country`), and the `LifecycleEngine` calls the provider on the "receive" side of mint/transfer/buy, treating a rejection as a policy failure (fail-closed). ID-H adds a sibling method `hasVerifiedIdentity(account)` and one enforcement branch keyed on the new flag — no new subsystem.

"Verified identity" = the user behind the wallet holds **≥1 unrevoked `KycCredential`** (the canonical built-in identity VC), checked against the ID-A/B/C held-credential model (`credentials.listByHolder(did)` + each credential's `revoked` state). This is the held-credential path chosen in brainstorming (revocable), *not* the legacy `kycStatus`/`kyc.country` flag (which continues to back `jurisdictionOf` unchanged).

---

## Scope

**In scope (ID-H):**
- `UseCaseDefinition.compliance.requireVerifiedIdentity?: boolean` (default off ⇒ fully back-compatible; every existing use case behaves exactly as today).
- `ComplianceProvider.hasVerifiedIdentity(account: string): Promise<boolean>` + the engine enforcement branch (on the receive side, alongside jurisdiction).
- The API provider impl: address → account → user → DID → held credentials → any unrevoked `KycCredential`.
- Web: a "Require verified identity (DID/VC)" checkbox in the tokenization use-case builder's compliance section; config round-trips; compliance summary shows it; buy/issue surfaces the `IDENTITY_NOT_VERIFIED` failure clearly.

**Out of scope (deferred / YAGNI):**
- Selecting *which* credential type(s) gate the use case (the "specific credential types" option) — the toggle is fixed to `KycCredential`; a `requiredCredentialTypes: string[]` generalization is a clean future extension of the same seam.
- Fresh-VP-per-action enforcement (the held-credential model is used; no per-buy presentation ceremony).
- Gating anything other than the receive side (issuer mint-to, buyer buy, transfer recipient) — sender-side or issuance-desk gating is out.
- On-chain enforcement (the gate is a platform compliance check, like the existing jurisdiction/allowlist rules; the token contract is unchanged).
- Any change to `jurisdictionOf`, the legacy KYC flow, or the identity domain itself.

---

## Architecture

Three layers on the existing compliance seam:

1. **Core** — the `compliance.requireVerifiedIdentity` flag; the `ComplianceProvider.hasVerifiedIdentity` interface method; the `LifecycleEngine` enforcement branch that, when the flag is set on the use case, calls `hasVerifiedIdentity(receiver)` at the same receive points as jurisdiction and throws `PolicyError("IDENTITY_NOT_VERIFIED")` on false. A pure predicate/validator update where the compliance schema is validated.
2. **API** — `createComplianceProvider` gains `credentials` in its deps and implements `hasVerifiedIdentity(account)`: `accounts.list().find(address)` → `users.list().find(accountId)` → `user.did` → `credentials.listByHolder(did)` → `some(c => c.type includes "KycCredential" && !c.revoked)`. No user, no DID, or no unrevoked KYC VC ⇒ `false`. Wired at the provider construction site(s) with the credential repo.
3. **Web** — the compliance editor in the tokenization builder adds the checkbox; `UseCase`/config types carry the flag; the compliance-summary and the buy/issue error paths render `IDENTITY_NOT_VERIFIED` with a helpful message ("this asset requires a verified DID/VC identity — obtain a KYC credential first").

## Data flow

An OrgAdmin authors (or edits) a tokenization use case and ticks **Require verified identity (DID/VC)**. The flag persists on `compliance`. Later a buyer attempts to `buy` (or an issuer mints to a wallet, or a holder transfers to a recipient): the engine, seeing the flag, asks the provider `hasVerifiedIdentity(receiverWallet)`. The provider resolves the wallet to its user's DID and checks the identity domain for an unrevoked `KycCredential`. Held ⇒ the receive proceeds (subject to the other compliance rules); absent/revoked ⇒ `IDENTITY_NOT_VERIFIED`, the operation is refused. Issuing the buyer a `KycCredential` through the Identity desk (ID-B/F) — or revoking it — flips the gate with no tokenization-config change.

## Error handling

- Flag off (default/undefined) ⇒ `hasVerifiedIdentity` is never called; zero behavior change for all existing use cases (the key back-compat guarantee — verified by leaving every current compliance test green).
- Flag on + receiver has no linked user / no DID / no `KycCredential` / only a revoked one ⇒ `PolicyError("IDENTITY_NOT_VERIFIED")` (fail-closed), surfaced by the API as a 4xx the web renders inline.
- Provider lookup failure propagates as a policy failure (fail-closed), matching the existing provider contract.

## Testing

- **core:** compliance-schema validation accepts `requireVerifiedIdentity`; the engine calls `hasVerifiedIdentity` only when the flag is set and throws `IDENTITY_NOT_VERIFIED` on false (use a stub provider); flag-off path never consults it. Existing compliance/jurisdiction tests stay green.
- **api:** with a use case that has the flag, a buyer holding an unrevoked `KycCredential` can buy; a buyer with none is refused `IDENTITY_NOT_VERIFIED`; a buyer whose `KycCredential` is revoked is refused; toggling the flag off lets them buy. Reuse the identity-issuance helpers to mint/revoke the KYC VC in-test.
- **web:** tsc + build; a live walkthrough — enable the toggle on a use case, attempt a buy as a holder with no KYC VC (refused), issue that holder a `KycCredential` via the identity desk, retry (allowed).

## Verification / done

Full core + api suites green (new gate tests + all existing compliance tests untouched) + web tsc/build + a live walkthrough of the gate flipping a buy from refused → allowed after credential issuance, then finish the branch.

## Alternatives considered

- **Reuse the legacy `kycStatus`/`kyc.country` flag** as "verified identity" — simplest, but it's a non-revocable boolean set by the old VP flow, not the held-credential model; the brainstorm chose held-and-unrevocable, which is the DID/VC-native answer and revocation-aware.
- **A `requiredCredentialTypes: string[]` from the start** — more flexible but heavier UI/validation; the fixed-`KycCredential` toggle is the requested "simple" shape and the array is a drop-in later extension of the same `hasVerifiedIdentity`/flag seam.
- **On-chain identity gating** (contract-enforced allowlist keyed on a credential) — out of scope; the platform compliance layer is where the existing jurisdiction/holder rules live, so the gate belongs there for consistency.
