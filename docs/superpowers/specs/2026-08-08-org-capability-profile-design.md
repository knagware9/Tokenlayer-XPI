# Organization Capability Profile & Role Management (EN-A) — Design

**Goal:** Give every Organization a governed **capability envelope** — which domains it operates (`tokenization`, `identity`, or both) and which operating roles it plays (`Issuer`, `Holder`, `Verifier`) — chosen by the org at signup, granted at platform approval, changeable later only through the approval queue, and enforced everywhere the platform lets an org act. Within the envelope, the OrgAdmin manages member roles freely. First sub-project of the Enterprise program (EN-A..F); the envelope becomes the scoping backbone for EN-B's API keys.

**Program context:** Organizations are already first-class tenants (custodial DID, KYB signup → PlatformAdmin review → approval ceremony, org-bound issuer/verifier bindings, org-held credentials, org-owned use cases) — but *what an org may do* is decided implicitly and platform-side: any active org can be bound as an issuer, any org whose `orgType` passes the verifier gate can verify, any org can hold. There is no per-org domain enablement at all (`ENABLED_DOMAINS` is deployment-wide, ID-E). EN-A makes the org's powers an explicit, auditable grant.

**Tech stack:** packages/core (capability type + two pure predicates), apps/api (JSON column + registration/approval/change-request plumbing + enforcement at the existing gates), apps/web (signup step, review expansion, OrgAdmin management surface, nav filtering). One new proposal kind. No new dependency, no chain interaction.

---

## The model

**Core** (`packages/core`, alongside the other org policy types):

```ts
export type OrgDomain = "tokenization" | "identity";
export type OrgOperatingRole = "Issuer" | "Holder" | "Verifier";
export interface OrgCapabilities {
  domains: OrgDomain[];
  roles: OrgOperatingRole[];
}
```

Two pure predicates, both **null-tolerant**:
- `orgDomainEnabled(caps: OrgCapabilities | null, domain: OrgDomain): boolean`
- `orgRoleEnabled(caps: OrgCapabilities | null, role: OrgOperatingRole): boolean`

**`null` means "unrestricted legacy envelope" and both predicates return `true`.** This is the back-compat cornerstone: every existing org (and every org created by paths that don't pass capabilities — ID-G provisioning, `POST /orgs`, the boot platform org) keeps working exactly as today, no existing test changes, no data migration. Governance arrives with the data: a PlatformAdmin can tighten any legacy org by setting an explicit envelope, and every *new signup* carries one. An explicit envelope with an empty array is fully restrictive — `[]` ≠ `null`.

`validateOrgCapabilities(input)` rejects unknown domain/role strings and duplicates (throws `PolicyError`, same style as the other validators).

**Persistence:** `Organization.capabilities String?` (JSON-encoded, like `companyProfile`) + `OrganizationRecord.capabilities: OrgCapabilities | null`. THE PARITY CHECKLIST applies in full: Prisma schema + record type + row-type + mapper (JSON.parse/stringify round-trip) + create/update literals in BOTH repos + `prisma generate`, one task — and the live walkthrough proves the Prisma round-trip (the ID-L lesson).

## Acquisition — how an org gets its envelope

1. **Signup** (`POST /orgs/register`): body gains optional `capabilities: OrgCapabilities`. The web wizard adds a "What will your organization do?" step (domain checkboxes + role checkboxes, all pre-checked; at least one of each required client-side) and always sends it. API-side absent ⇒ `null` (old clients keep working); present ⇒ validated and stored on the pending org — the envelope is part of what the reviewer approves.
2. **Approval** (`POST /orgs/:id/approve`): unchanged mechanically — approving activates the org *with the envelope it requested*. The PlatformAdmin review expansion displays the requested capabilities alongside the KYB documents. v1 has no reviewer-side editing: to grant something different, approve then set explicitly (below), or reject.
3. **Platform assignment** (`PATCH /orgs/:id/capabilities`, PlatformAdmin only): direct 200 set/replace — the platform is the granting authority and needs no second approver to exercise it. Audit-logged (`org-capabilities-set`).
4. **Org-requested change** (`POST /orgs/:id/capabilities/request`, OrgAdmin of that org): creates a proposal of new kind **`org-capability-change`** (payload `{orgId, capabilities}`, `required: 1`, PlatformAdmin-only `canApprove`, proposer's own OrgAdmin cannot self-approve — the existing SELF_APPROVAL rule plus role gating cover this). Executor re-validates and sets. The Approvals inbox summarizes it readably ("Acme Corp requests: identity · Issuer, Verifier").

## Enforcement — where the envelope bites

All checks are **only enforced when `capabilities !== null`** (the predicates make this automatic), and every rejection is a 403 `ORG_CAPABILITY_MISSING` with a message naming the missing capability. Enforcement lands at the same gates that exist today — no new middleware layer:

| Act | Gate location (today) | New check |
|---|---|---|
| Org bound as **issuer** of a credential use case | use-case create/PATCH/provision where `issuer: {kind:"org"}` is set | bound org has `Issuer` + `identity` |
| Org **issues** (OrgAdmin via `resolveIssuer`) | `resolveIssuer` (routes.ts ~731) | issuer org has `Issuer` (defense in depth — config may predate a tightening) |
| Org **verifies** | verification-request org path (routes.ts ~2680-2699, after the existing orgType gate) | verifier org has `Verifier` + `identity` |
| Org listed in a **verifier binding** (`{kind:"orgs"}`) | use-case create/PATCH validation | each listed org has `Verifier` |
| Org **holds** (issue with `subjectOrgId`) | issuance route subject resolution | target org has `Holder` |
| Org **owns a tokenization use case** | `create-use-case` proposal kind executor + gated wizard route | org has `tokenization` |
| Org **owns an identity use case** | credential-use-case create with `ownerOrgId` / provisioning rebind for that org | org has `identity` |
| OrgAdmin **adds a member** | `POST /orgs/:id/users` after `canCreateOrgMember` | member's role within the envelope: target role `Issuer`/`Holder`/`Verifier` requires that org role; the member's `useCaseKey` domain (via `useCaseDomainOf`) requires that domain. Roles outside the three (Trader/Buyer/Auditor/UseCaseAdmin) gate on domain only. `canCreateOrgMember` itself stays untouched (core purity + platform override intact — PlatformAdmin bypasses the envelope check entirely). |
| Org issues a **legacy catalog credential** (ninth gate, found in review) | `POST /credentials/requests` (the pre-ID-A closed-catalog path, which never touches `resolveIssuer`) | issuing org has `Issuer` (role only — catalog credentials predate the domain split and serve tokenization KYC flows) |

Additionally, the issuance **executors** (`issue-credential`, `issue-usecase-credential`, `issue-usecase-credential-batch`) re-check the issuer org's envelope at execution time — a propose → tighten → approve race fails the proposal instead of issuing, matching the `create-use-case` executor's treatment.

Deliberately NOT enforced in v1: retroactive effects. Tightening an envelope does not revoke existing credentials, unbind existing use cases, or deactivate existing members — it stops *new* acts. (The dashboard/wallets keep showing history; a cleanup ceremony is a later item if ever needed.)

## Role management within the envelope

Already 90% built: OrgAdmin creates/manages members via `/orgs/:id/users` and the Organizations UI. EN-A adds the envelope filter server-side (table above) and client-side (the member-add role picker only offers roles the envelope allows, with an explanatory hint when options are hidden). No new member routes.

## Web

- **Signup wizard**: new capabilities step (before review), sends `capabilities`.
- **PlatformAdmin org review**: requested capabilities rendered as pills in the existing review expansion.
- **Organizations page**: capability pills per org ("tokenization · identity" / "Issuer · Verifier"); legacy-null shows "unrestricted (legacy)". PlatformAdmin gets an Edit control (direct PATCH); OrgAdmin (own org page) gets "Request change" → 202 → pending banner until decided.
- **Approvals inbox**: summarize arm + decision view for `org-capability-change`.
- **Nav/domain filtering**: the login/user payload gains `orgCapabilities` (threaded like `useCaseDomain` — the web has no `/me` call). The OrgAdmin branch intersects its domain switcher with the envelope (an identity-only org sees no Tokenization domain), and hides Organization Wallet without `Holder`, Verification without `Verifier`. Member desks are already scoped by their own role/useCaseKey — no change.

## Error handling

- `ORG_CAPABILITY_MISSING` 403s carry which capability was missing (`details: {orgId, missing: "Verifier"}`) — EN-B's API errors will reuse this shape.
- Capability validation failures at register/patch/request are 400 `INVALID_CAPABILITIES` with problems.
- The change-request proposal executor re-validates at execution (never-trust-stale-payload, same as every other kind); a vanished org fails the proposal via the existing failure path.

## Testing

- **core:** predicate truth tables incl. null-legacy and `[]`-restrictive; validator rejections.
- **api:** signup with capabilities → pending org stores them → approval activates with envelope; each enforcement row in the table (positive + 403 negative, incl. the defense-in-depth issue-time check after a platform tightening); member-add filtering (envelope org vs legacy org vs PlatformAdmin bypass); PATCH direct-set audit; change-request flow (OrgAdmin 202 → PlatformAdmin approves → applied; OrgAdmin of another org 403; self-approval blocked); **legacy-null orgs behave byte-identically** (no existing test edited — the oracle).
- **web:** tsc + build; live Besu walkthrough — register an org choosing identity-only + Issuer/Verifier → approve → org issues (ok) → org tries to hold via subjectOrgId (403) → OrgAdmin member picker filtered → org requests adding Holder → PlatformAdmin approves → holding now works; a pre-existing legacy org still does everything; browser pass over the wizard step, review pills, and the request-change surface.

## Verification / done

Full core + api suites green + web tsc/build + the live Besu walkthrough, then finish the branch (`feat/org-capabilities` → main).

## Alternatives considered

- **Infer envelopes for existing orgs from current behavior** (issuer-bound ⇒ Issuer, …) — rejected: inference guesses intent, silently freezes orgs the moment they're migrated, and requires a data migration; null-as-legacy is honest, zero-risk, and lets the platform tighten deliberately.
- **Per-use-case org capabilities** (org may issue for use case X but not Y) — over-modeled for v1; the use-case bindings already express per-use-case authority, the envelope governs the org's *class* of powers. Revisit if a real tenant needs it.
- **Reviewer edits capabilities during approval** — adds a second editing surface and a consent question (org gets powers it didn't request?); approve-then-PATCH covers the rare case.
- **Enforce retroactively on tightening** — destructive cascades (revoke credentials? unbind use cases?) from a governance toggle are a footgun; stop-new-acts is predictable and auditable.
- **Envelope on User instead of Organization** — member roles already exist per-user; the missing layer is the *tenant* grant, which is exactly what EN-B's org-scoped API keys need.
