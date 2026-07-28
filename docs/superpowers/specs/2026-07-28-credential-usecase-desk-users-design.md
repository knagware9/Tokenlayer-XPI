# Credential Use-Case Desk Users (ID-F) — Design

**Goal:** Give a DID/VC (credential) use case the same *scoped desk users* a tokenization use case already has — a `UseCaseAdmin` who runs one credential use case and onboards its **Issuer**, **Holder**, and **Verifier** roster under it — so identity use cases are operated by dedicated per-use-case users, not only by PlatformAdmins and org OrgAdmins.

**Program context:** Builds directly on the Identity program (ID-A credential engine · ID-B issuer/holder/verifier runtime · ID-C entity wallet · ID-D QR login · ID-E pluggable domain shell, all merged). ID-F closes the last asymmetry between the two domains: tokenization has use-case-scoped desk users; identity does not.

**Tech stack:** packages/core (Role model + user-policy + a use-case-domain resolver), apps/api (Fastify — permission gates + cross-type key guard + onboarding), apps/web (React — the operator console renders the Identity-domain desk). No new persistence model; no new `User` column.

---

## The gap being closed

Tokenization scopes desk users through `User.useCaseKey`:
- A `UseCaseAdmin` runs one tokenization use case and (via `user-policy.canCreateUser`) onboards `Issuer`/`Buyer`/`Auditor` **in their own use case** — the policy keys purely on role + `useCaseKey` equality, so it is already use-case-**type-agnostic**.
- Route gates compare `claims.useCaseKey` to the resource's `useCaseKey`.

Credential (DID/VC) use cases (`CredentialUseCase`, ID-A/B) have **no scoped-user model**. Today they are operated only by:
- a **PlatformAdmin**, or
- an **OrgAdmin** whose org is the use case's issuer binding (`credential-use-cases.ts:issuerBindingAllows`).

There is no user tied to a single credential use case, and no `Holder`/`Verifier` user role at all (holders are today `Buyer`; verifiers are an org-type + `verifierBindingAllows` binding). ID-F introduces the scoped credential desk and the two missing roles.

---

## Scope

**In scope (ID-F):**
- Two new roles, `Holder` and `Verifier`, as the **identity-domain roster** (alongside the existing `Issuer`).
- A `UseCaseAdmin` scoped to a *credential* use case, who issues its credentials and onboards `Issuer`/`Holder`/`Verifier` under it — reusing the existing gated maker-checker `POST /users`.
- Domain resolution of a `useCaseKey` (tokenization vs identity) + a cross-type key-uniqueness guard, so `User.useCaseKey` is unambiguous with **no new column**.
- Permission gates: a credential-use-case-scoped `UseCaseAdmin`/`Issuer` may issue/revoke that use case's credentials; a scoped `Verifier` may request/verify its presentations; a scoped `Holder` holds and views them.
- Web: the operator console renders the **Identity-domain** desk (issue / my-credentials / verify / approvals / user-management) for a credential-scoped user, using the ID-E `availableDomains`/`effDomain` machinery; the Add-User picker lists credential use cases with domain-aware role options.

**Out of scope (deferred / YAGNI):**
- A new `User.useCaseDomain` discriminator column (resolve-and-guard instead — see Alternatives).
- Cross-use-case roles (a user scoped to more than one use case).
- Changing the VC trust model: the scoped Issuer is an **operator**; the VC is still signed by the use case's **bound issuer DID** (org/platform), never the desk user's own DID.
- Org-level verifier flows (unchanged — verifier orgs keep working exactly as in VP-*; ID-F only *adds* the scoped-user path).
- Any packages/contracts or ledger change.

---

## Architecture

Four layers:

1. **Roles (core)** — add `Holder`, `Verifier` to the `Role` union + `ROLES`; wire RBAC (`can`) and `user-policy` (`ORG_INTERNAL_ROLES`, `assignableRoles`, `canCreateUser`, `canCreateOrgMember`) so the identity roster is assignable and domain-consistent.
2. **Domain resolution (core + api)** — a pure helper classifies a `useCaseKey` as `"tokenization" | "identity" | undefined`; the API resolves it from the two repos and enforces cross-type key uniqueness at creation.
3. **Permission gates (api)** — the credential issue / revoke / eligible-holders / verification routes admit a caller whose `useCaseKey` matches the credential use case, at the right role.
4. **Operator desk (web)** — the non-platform App branch renders the Identity-domain surfaces for a credential-scoped desk user; the Add-User form offers credential use cases with the identity roster.

Unifying rule: **a desk user belongs to exactly one use case, and that use case's domain determines both the roster they can be given and the surfaces they operate.**

---

## 1. Roles (core)

`packages/core/src/types.ts`
- `Role` union gains `"Holder"` and `"Verifier"`; append both to `ROLES`.

`packages/core/src/user-policy.ts`
- `ORG_INTERNAL_ROLES` gains `"Holder"`, `"Verifier"` (they are org-internal roster roles, mintable by an OrgAdmin/PlatformAdmin).
- `assignableRoles` becomes **domain-aware**. New signature `assignableRoles(role: Role, domain?: "tokenization" | "identity")`:
  - `UseCaseAdmin` + `domain === "identity"` → `["Issuer", "Holder", "Verifier"]`
  - `UseCaseAdmin` + `domain === "tokenization"` (or undefined) → `["Issuer", "Buyer", "Auditor"]` (unchanged)
  - `PlatformAdmin` / `OrgAdmin` → the full roster (both sets) — gating narrows by domain in `canCreateUser`.
- `canCreateUser(manager, targetRole, targetUseCaseKey, targetDomain?)` gains a `targetDomain` argument and adds a **domain-consistency** check: the target role must be valid for the target use case's domain (`assignableRoles(manager.role, targetDomain).includes(targetRole)`), so a `Holder` can only be created in an identity use case and a `Buyer` only in a tokenization one. A `UseCaseAdmin` still requires `targetUseCaseKey === manager.useCaseKey`.

`packages/core/src/rbac.ts` (or the web `rbac.ts` + any core permission map)
- `Holder`: read own credentials; be an eligible subject. No management, no issue, no trade.
- `Verifier`: request + run verification for their use case; no issue, no management.
- `Issuer` (existing) additionally gains "issue credential" in the identity domain (already the operator of asset issuance in tokenization).
- `canManageUsers` unchanged (only `PlatformAdmin`/`OrgAdmin`/`UseCaseAdmin`).

## 2. Domain resolution + cross-type key guard (core + api)

`packages/core` — pure helper:
```ts
export type UseCaseDomain = "tokenization" | "identity";
export function useCaseDomainOf(
  key: string,
  known: { tokenizationKeys: Iterable<string>; credentialKeys: Iterable<string> },
): UseCaseDomain | undefined { /* identity if in credentialKeys, tokenization if in tokenizationKeys, else undefined */ }
```

`apps/api` — resolve from the repos (`deps.useCases`, `deps.credentialUseCases`) wherever a scoped user's domain is needed (login/claims context, onboarding validation, nav config). Enforce **cross-type uniqueness** at creation:
- `POST /credential-use-cases`: reject (409 `KEY_IN_USE`) if `deps.useCases.get(key)` exists.
- `POST /use-cases`: reject (409 `KEY_IN_USE`) if `deps.credentialUseCases.get(key)` exists.

This keeps `User.useCaseKey` unambiguous with no schema change.

## 3. Permission gates (api)

Credential issue route (`POST /credential-use-cases/:key/credentials`, routes.ts ~520): the bound issuer org (which supplies the **signing DID**) is still resolved from the use case's `issuer` binding. The *operator* gate widens to permit, in addition to today's PlatformAdmin + bound OrgAdmin:
- a caller with `role ∈ { UseCaseAdmin, Issuer }` and `claims.useCaseKey === key`.

The proposal is still created with `orgId: issuerOrg.id` and signed by that org's DID on approval — the scoped user is recorded as proposer/operator, not the cryptographic issuer.

Same operator widening for:
- **revoke** (`POST /credentials/:id/revoke` for a credential of this use case) — `UseCaseAdmin`/`Issuer` scoped to the use case.
- **eligible-holders** read (`GET /credential-use-cases/:key/eligible-holders`) — any desk role scoped to the use case.
- **verification** (`POST` verification request + verify, VP-* routes): admit a `Verifier` user with `claims.useCaseKey === key`, scoping the request to that use case's credential types. The existing verifier-**org** path is untouched.

## 4. Operator desk (web)

`apps/web/src/App.tsx` (non-platform/operator branch) + `domains.ts`:
- Resolve the signed-in desk user's **effective domain** from their scoped use case (identity if `useCaseKey` is a credential use case, tokenization otherwise). The API resolves this server-side and returns it as `useCaseDomain` on `GET /me`, so the client needs no round-trip against both use-case lists.
- When the domain is **identity**, build the Identity-domain nav for the desk (reusing ID-E `NAV_DOMAIN`/`itemsForDomain`), role-filtered:
  - `UseCaseAdmin`: Issue Credentials · Verification · Approvals · User Management · (My Profile / My Credentials / Logout)
  - `Issuer`: Issue Credentials · Approvals · pinned
  - `Verifier`: Verification · pinned
  - `Holder`: My Credentials · pinned
- Surfaces reuse existing components: `IssueUsecaseCredential` (+ an issued-credentials list) for issuance, `VerificationRequests` for verify, `MyIdentity`/`CredentialsPanel` for the holder, `ApprovalsPanel`, `UserManagement`.
- **Add-User form** (`UserManagement`): the use-case picker lists credential use cases (labeled by domain); the role dropdown offers `assignableRoles(manager.role, pickedUseCaseDomain)` so an identity use case offers Issuer/Holder/Verifier.

The PlatformAdmin landing branch and the tokenization desk are unchanged; the Buyer/investor branch is untouched.

## Data flow

A PlatformAdmin (or an identity `UseCaseAdmin`) opens **User Management → Add User**, picks a credential use case (e.g. `invoicevc`) and a role (Issuer/Holder/Verifier). The gated maker-checker `POST /users` creates the scoped user on approval. That user logs in → the API reports their effective domain = identity → the operator console shows the identity desk. An `Issuer` opens **Issue Credentials**, fills the claim form (now type-correct after the recent fix), and submits — the VC signs with the use case's bound issuer DID on approval. A `Verifier` runs a presentation check; a `Holder` sees the credential under **My Credentials**.

## Error handling

- Onboarding a role that does not match the use case's domain (e.g. `Holder` in a tokenization use case, or `Buyer` in a credential use case) → 400 `ROLE_DOMAIN_MISMATCH` from the domain-consistency check.
- Creating a use case whose key already exists in the other domain → 409 `KEY_IN_USE`.
- A scoped desk user acting on a use case other than their own → 403/404 (unchanged gate semantics; existence not leaked cross-use-case).
- Domain resolution fails-safe: an unresolvable `useCaseKey` (neither list) defaults to tokenization nav (never a blank shell), matching ID-E's fail-open posture.

## Testing

- **core:** `assignableRoles`/`canCreateUser` domain matrix (identity UCA → Issuer/Holder/Verifier only; tokenization UCA → Issuer/Buyer/Auditor only; cross-domain rejected); `useCaseDomainOf`.
- **api:** a credential-use-case `UseCaseAdmin` issues its credentials (202) and cannot issue another use case's (403); a scoped `Issuer` issues but cannot onboard; a scoped `Verifier` runs verification for the use case; a scoped `Holder` reads only their own; onboarding maker-checker mints each identity role; cross-type key collision → 409; role/domain mismatch → 400.
- **web:** tsc + build; a live browser walkthrough — as PlatformAdmin onboard a `UseCaseAdmin` on `invoicevc`; log in as that desk; confirm the Identity nav (Issue Credentials / Verification / Approvals / User Management); issue a credential; onboard an `Issuer` and a `Holder` under it; confirm the Holder sees it under My Credentials.

## Verification / done

Full core + api suites green (with the new role/gate/domain tests) + web tsc/build + a live browser walkthrough of the credential desk (onboard → issue → verify → hold), then finish the branch.

## Alternatives considered

- **Explicit `User.useCaseDomain` column** — unambiguous without a uniqueness guard, but threads a new field through onboarding, JWT claims, and every construction site. Rejected in favour of resolve-and-guard, which reuses the existing `useCaseKey` and adds only a creation-time check.
- **Desk user's own DID as issuer** — would make each Issuer a distinct cryptographic issuer, forcing verifiers to trust individual user DIDs. Rejected: the VC signs with the use case's bound issuer DID (org/platform), matching how a tokenization `Issuer` mints via the use case's authority.
- **Reusing `Buyer` for holders / an org for verifiers** — rejected per the explicit requirement for first-class `Holder` and `Verifier` roles in the identity roster.
