# Holder Acceptance Lifecycle for Issued Credentials (ID-L) — Design

**Goal:** Give holders an explicit say over credentials issued to them. When a credential use case opts in, issued credentials arrive as **pending acceptance** in the holder's wallet: the holder can **Accept** (credential becomes fully live), **Reject** (credential is auto-revoked chain-first), or **Request changes** (flags the issuer desk with a note). Until accepted, a credential cannot be presented, does not satisfy the ID-H tokenization gate, and has no certificate. This is the core workflow gap identified from the TalentPass/Sethu reference videos (their *Issued → Accepted / Request for changes* lifecycle).

**Program context:** ID-A..K are complete. Today, once the maker-checker approves an issuance, the credential lands in the holder's wallet fully live — the holder is never asked. TalentPass demonstrates the opposite: issuance and holder acceptance are distinct states, with "Request for changes" as a first-class holder response. ID-L adds that ceremony as an **opt-in per use case**, following the platform's pluggable-config pattern (ID-H `requireVerifiedIdentity`, ID-I `certificate`).

**Tech stack:** packages/core (one optional flag + validation + template carry) + apps/api (acceptance state on `Credential`, initial-state at issuance, three holder action routes, fail-closed consumers) + apps/web (holder action cards + issuer pills + builder toggle). Prisma change is **additive columns with defaults** (`prisma db push`, no migration risk).

---

## The seam

Acceptance is a **platform lifecycle state layered on an already-issued credential** — not a change to signing or anchoring. The VC is signed and anchored at issuance exactly as today (the chain records that issuance happened; TalentPass likewise anchors before holder accept). What changes is what the platform lets a non-accepted credential DO: nothing, until the holder says yes. Every consumer that treats "held credential" as meaningful gains an `accepted` requirement, fail-closed.

## Configuration (core)

`CredentialUseCaseDefinition` gains one optional top-level flag:

```ts
/** When true, issued credentials require explicit holder acceptance before they
 *  can be presented, satisfy identity gates, or expose a certificate. */
holderAcceptance?: boolean;
```

- `validateCredentialUseCase`: optional-boolean check (same style as ID-H's flag).
- **Templates (ID-G/J carry):** `UseCaseTemplate.body.holderAcceptance?: boolean`; `validateTemplate` accepts an optional boolean; `instantiateTemplate` copies it onto the emitted definition. Built-ins unchanged (all default off).
- Default absent/off ⇒ **byte-identical behavior to today** for every existing use case and template — the headline back-compat invariant.

## Lifecycle model (api)

`CredentialRecord` / Prisma `Credential` gain:

```ts
acceptance: "accepted" | "pending" | "rejected" | "changes_requested";  // default "accepted"
acceptanceAt: string | null;       // when the holder acted
acceptanceNote: string | null;     // required for changes_requested, optional for reject
```

- Existing rows and all non-use-case issuance paths (catalog KYC, membership VCs, KYB OrganizationCredential, org flows) default to `"accepted"` — no behavior change.
- `issueCredentialFor` gains an optional `initialAcceptance` input (default `"accepted"`). Only the `issue-usecase-credential` executor passes `"pending"`, and only when the freshly-resolved use case has `holderAcceptance: true` (config resolved at execute time, per the never-sign-stale-config rule).
- `CredentialRepository` gains `setAcceptance(id, { acceptance, at, note })` (memory + prisma).

### Holder actions (new routes, holder-only — the caller's DID must equal the credential's holderDid)

| Route | Effect |
|---|---|
| `POST /me/credentials/:id/accept` | `pending → accepted` (stamps `acceptanceAt`) |
| `POST /me/credentials/:id/reject` | `pending → rejected` AND **revokes the credential chain-first** (reuses the existing revoke primitive: chain revoke, then DB; reason = holder rejection + optional note). A refused credential must not remain valid on-chain. |
| `POST /me/credentials/:id/request-changes` | `pending → changes_requested` with a **required note** — the credential stays unusable; the issuer desk sees the note and remedies by revoke + re-issue (a signed VC is never mutated in place). |

Rules: actions are valid only from `pending` (or `changes_requested → accepted/rejected` if the holder later relents/refuses — allowed, since the issuer may have clarified out-of-band) — `accepted` and `rejected` are terminal; wrong state ⇒ 409 `INVALID_ACCEPTANCE_STATE`; wrong holder ⇒ 404 (no-leak, matching existing wallet posture). Every action is audit-logged.

## Fail-closed consumers (all four gated on `acceptance === "accepted"`)

1. **VP consent eligibility** — the consent route's "eligible, unrevoked, requested-type credential you hold" check adds `accepted`: a pending/rejected/changes-requested credential cannot be selected or presented (extends the exact gate that already blocks revoked credentials, same `CREDENTIAL_NOT_ELIGIBLE` error).
2. **ID-H tokenization gate** — `hasVerifiedIdentity` requires the KYC credential to be unrevoked **and accepted**.
3. **Certificates (ID-I)** — `certificateAvailable` is false and `GET /credentials/:id/certificate.pdf` 404s unless accepted (an unaccepted certificate must not circulate; distinct from revoked-after-acceptance, which still renders with the watermark).
4. **Public status** — `GET /credentials/:id/status` includes `acceptance`, so third parties see the truthful lifecycle state alongside revocation/anchoring.

The `mapHeld` wallet projection carries `acceptance`, `acceptanceAt`, `acceptanceNote` so both web surfaces render from one source.

## Web

- **Holder — My Credentials:** a `pending` credential renders as an **action-required card** (amber accent): issuer name, type, claims preview, and three controls — **Accept**, **Request changes** (opens a required-note input), **Reject** (optional note, with a confirm since it revokes). `changes_requested` shows its note with Accept/Reject still offered. Accepted credentials render exactly as today.
- **Issuer desk (IssueUsecaseCredential / identity desk views):** acceptance pills on listed credentials — `pending acceptance` (amber) / `accepted` (green) / `changes requested` (red, note visible on expand) / `rejected` (muted; also shows revoked). Gives the desk the TalentPass-style visibility without a new page (the full status board is ID-N).
- **Builder + wizard:** a "Require holder acceptance" toggle in `CredentialUseCaseBuilder` (Roles/Review step, beside existing policy controls), included in the POSTed config only when set; carried by save-as-template; shown in the provisioning preview.
- **CredentialCard:** acceptance pill next to the valid/revoked pill when not `accepted`.

## Error handling

- Flag off ⇒ every credential is born `accepted`; no consumer changes fire; all existing tests stay green untouched.
- Reject's chain revoke follows the existing revoke discipline (chain-first; on chain failure the action fails and the credential stays `pending` — never a DB-revoked/chain-valid split).
- `request-changes` without a note ⇒ 400. Actions from terminal states ⇒ 409. Non-holder callers ⇒ 404.
- The status endpoint never conflates acceptance with revocation: `rejected` credentials report both `acceptance: "rejected"` and `revoked: true`.

## Testing

- **core:** validation accepts/rejects `holderAcceptance`; template carry (validate + instantiate emit); existing suites untouched-green.
- **api:** toggle-off byte-equivalence (issue → born accepted, all consumers unchanged); toggle-on: issued credential is `pending` → excluded from consent eligibility (CREDENTIAL_NOT_ELIGIBLE), fails `hasVerifiedIdentity`, certificate 404 + `certificateAvailable: false`; **accept** flips all four consumers; **reject** revokes chain-first (registry double asserts the revoke) and is terminal; **request-changes** requires a note, stores it, still unusable, then accept from that state works; wrong-holder 404; wrong-state 409; status endpoint exposes `acceptance`.
- **web:** tsc + build; live Besu walkthrough — toggled-on use case → issue → holder sees the action-required card → request changes (note) → issuer sees the note → holder accepts → presents to a verifier successfully → a second credential rejected → revoked on-chain (eth_call) + consent refused.

## Verification / done

Full core + api suites green + web tsc/build + the live walkthrough, then finish the branch (`feat/holder-acceptance` → main).

## Alternatives considered

- **Acceptance for every use case (no toggle)** — breaks every existing flow and test and forces ceremony on machine-to-machine credentials (KYC, membership). The opt-in flag matches the platform's pluggable pattern and keeps back-compat provable.
- **Don't anchor until accepted** (TalentPass-style registrar-only anchoring is what we already have; deferring the anchor past acceptance) — would make the anchor's issuedAt lie about issuance time and complicate the atomic issue-and-anchor path; anchoring at issuance + platform-level acceptance state is simpler and truthful.
- **Reject without revoking** — leaves a holder-refused credential valid on-chain and presentable-by-bug forever; chain-first auto-revoke is the fail-closed choice.
- **In-place credential edit for change requests** — impossible without re-signing (the VC is signed); revoke + re-issue is the honest remedy, and the note gives the issuer the context.
