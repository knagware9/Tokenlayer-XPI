# Issue a credential

> **Verified.** Every call below was executed, in this order, against a live
> deployment on Besu (task D1-7). The status codes, error codes and response
> shapes are what the server actually returned. Ids in the samples are
> illustrative: real ones are opaque — cuids for proposals, organizations and
> users (`cmslq3dl5000rwudc3sre3z80`), UUIDs for credentials
> (`d5b1097c-d1e0-4853-9862-754bceb03b27`). Do not parse them.

Issue a verifiable credential to a holder, get it accepted, and prove to a third
party that it is real. Base URL throughout: `https://<host>/api/v1`.

---

## The one thing to read before anything else

**Almost every mutation on this API answers `202` with a proposal, not with the
thing you asked for.** `POST …/credentials` does not issue a credential. It
records a *request* to issue one. The credential comes into existence when a
**second, different, authorized principal** approves that proposal.

Two consequences that cost people an afternoon each:

1. **The `id` in a 202 is the proposal's id.** It is not the credential's id.
   The credential may never exist at all — a checker can reject.
2. **An `Issuer`-role principal cannot approve an issuance proposal.** Not
   "gets a 403" — gets a **404**. The credential proposal kinds admit only
   `OrgAdmin` and `PlatformAdmin` as viewers, and a proposal you cannot view is
   reported as not found (deliberately: a 403 would confirm it exists). If you
   mint one `Issuer` key and try to drive both halves of maker-checker with it,
   you will see a 404 on a proposal id you are holding in your hand and conclude
   the API is broken. It is not. You need a second principal, and it must be
   `OrgAdmin` or above.

   Confirmed on a live run, twice over. An `Issuer` key that is *not* the
   proposer:

   ```
   POST /proposals/{id}/approve   →   404
   { "error": "NOT_FOUND", "message": "proposal not found" }
   ```

   And the `Issuer` key that *did* propose gets the same 404 — **not**
   `403 SELF_APPROVAL`. The visibility filter runs before the self-approval
   check, so an Issuer maker never learns that its own proposal exists on this
   route. `SELF_APPROVAL` is only reachable by a principal who could have
   approved: propose as `OrgAdmin`, approve as that same `OrgAdmin`, and you get
   `403 SELF_APPROVAL` — "the proposer may not decide their own proposal".

---

## Prerequisites

**Organization capability envelope.** The issuing org's envelope must include
the `identity` domain and the `Issuer` role. If the subject is an *organization*
rather than a person, the subject org needs the `Holder` role. A missing
capability is `403 ORG_CAPABILITY_MISSING` with `details.missing` naming exactly
which one. An org whose `capabilities` is `null` is legacy-unrestricted and
passes every check.

**Roles and scopes.** Two principals, two different jobs:

| | maker (drafts) | checker (approves) |
|---|---|---|
| role | `Issuer` (bound to the use case) or `OrgAdmin` | `OrgAdmin` or `PlatformAdmin` |
| scope | `credentials:issue` | `credentials:issue` **and** `credentials:read` |

The checker needs `credentials:issue` too: the required scope for a decision is
derived from the proposal's *kind*, not from the route. Approving is what
executes the operation, so it is gated exactly as drafting is. Rejecting too.

**`credentials:read` belongs on the checker, not on the maker** — this is the
one prerequisite that reads backwards from intuition, and it costs an afternoon
if you get it wrong. The only issuer-side route that returns the new credential
is `GET /orgs/{orgId}/credentials`, and it is gated on *role* before scope: it
admits `PlatformAdmin`, or the `OrgAdmin` of that org, and nobody else. An
`Issuer` maker holding `credentials:read` still gets

```
403 { "error": "FORBIDDEN", "message": "not allowed to view that organization's credentials" }
```

so granting the maker that scope buys it nothing. See step 8.

Later steps each add one scope, called out where they need it — `users:read` to
list eligible holders, `verifications:request` / `verifications:verify` to run a
verification. Do not grant them up front. Note that `users:read` and the
verification scopes belong on *different* principals than the two above, for the
same reason: this flow has four roles in it, not two.

**Credentials in transit.** Everything below sends the secret as
`Authorization: Bearer …`. Never put a token in a URL or a query string; it
lands in access logs, referrers and browser history.

---

## 1. Get a human session

API keys are minted from a human session only. A key cannot mint a key
(`403 MACHINE_PRINCIPAL`) — that is the one path by which a key's own authority
could widen.

Read the password from a prompt rather than typing it inline; a literal password
on the command line lands in your shell history file.

```bash
read -rs -p "password: " TL_PASSWORD; echo
TL_SESSION=$(curl -sS -X POST https://<host>/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d "{\"email\":\"orgadmin@example.test\",\"password\":\"$TL_PASSWORD\"}" \
  | jq -r .token)
unset TL_PASSWORD
```

```
200 OK
{ "token": "eyJhbGciOi…", "user": { "id": "usr_…", "role": "OrgAdmin", "orgId": "org_…", … } }
```

There *is* a `403 SERVICE_ACCOUNT` for logging in as a key's bound service user,
but **you will almost never see it**: the password is checked first, and a
service user's password is a random string nobody holds, so the answer you
actually get is

```
401 { "error": "UNAUTHORIZED", "message": "invalid credentials" }
```

That ordering is deliberate — refusing before the password check would make the
route an oracle for which addresses are service accounts. Either way the
conclusion is the same: service users have no usable password by construction,
and the key is their only way in.

## 2. Get the use case — and the org id — in place first

**Do this before you mint any key.** A key bound to a use case is validated at
mint time, so minting the maker key from step 3 against a use case that does not
exist yet fails outright:

```
404 { "error": "USE_CASE_NOT_FOUND", "message": "no use case 'domicile-certificate-tehsildar-office'" }
```

List what exists:

```bash
curl -sS https://<host>/api/v1/credential-use-cases -H "authorization: Bearer $TL_SESSION"
```

```
200 OK
[ { "key": "domicile-certificate-tehsildar-office",
    "name": "Tehsildar Office — Domicile Certificate",
    "description": "Residence credential issued by Tehsildar Office.",
    "credentialTypes": [ { "name": "DomicileCredential", "title": "Domicile Credential",
                           "validityDays": 1825, "requiredApprovals": 1,
                           "claimSchema": {
                             "type": "object",
                             "required": ["holderName","state","continuousResidenceSinceYear"],
                             "properties": { "holderName": { "type": "string" },
                                             "state": { "type": "string" },
                                             "district": { "type": "string" },
                                             "continuousResidenceSinceYear": { "type": "number", "min": 1900, "max": 2100 } } },
                           "certificate": { "enabled": true, … } } ],
    "issuer": { "kind": "org", "orgId": "cmslq2emp…" },
    "holderPolicy": { "who": "any-onboarded" },
    "verifier": { "kind": "any" },
    "ownerOrgId": "cmslq2emp…" } ]
```

Read **`credentialTypes[].claimSchema.required`** and
**`claimSchema.properties`** — the claim schema is nested under `claimSchema`,
not spread onto the type. That is the shape your `claims` object must satisfy,
and a mismatch is a `400 INVALID_METADATA` before any proposal is created. For
`DomicileCredential` the required claims are **`holderName`, `state` and
`continuousResidenceSinceYear`** — `district` is optional. `requiredApprovals`
is how many approvals the proposal will need. There is no `status` field on a
credential use case; do not look for one.

**If you have no use case yet**, provision one from a built-in template. This
needs the **`usecases:provision`** scope — a broader grant than issuance,
because provisioning creates an org *and* a use case rather than a credential,
so do it from your human session and do not put that scope on the maker key:

```bash
curl -sS -X POST https://<host>/api/v1/credential-use-cases/provision \
  -H "authorization: Bearer $TL_SESSION" \
  -H 'content-type: application/json' \
  -d '{ "templateKey": "domicile-certificate",
        "params": { "issuerOrgName": "Tehsildar Office" },
        "provisioning": { "issuerOrgType": "government" } }'
```

```
201 Created
{ "org": { "id": "cmslq2emp…", "name": "Tehsildar Office", "did": "did:key:z6Mkmf6k…" },
  "useCase": { "key": "domicile-certificate-tehsildar-office", … },
  "deskUsers": [] }
```

**`org.id` is the `$ORG_ID` the next two steps need.** A PlatformAdmin session
carries `orgId: null`, so provisioning — or an existing org's id — is where it
comes from; it is not in your own login response unless you logged in as a
member of that org.

`provisioning.createDeskUsers: true` also creates staffed Issuer/Holder/Verifier
accounts and returns their server-generated passwords. Note it lives *inside*
`provisioning`, not at the top level. It is refused for a key —
`403 MACHINE_PRINCIPAL`, "an API key cannot create desk users; provision them
from a human session" — precisely because those passwords would be disclosed to
whoever holds the key.

## 3. Mint the maker key

`POST /orgs/{orgId}/api-keys`. The key authenticates as a *service member* of
the org, created through the ordinary member path — so the key can never be
stronger than a member you could have added by hand.

```bash
curl -sS -X POST https://<host>/api/v1/orgs/$ORG_ID/api-keys \
  -H "authorization: Bearer $TL_SESSION" \
  -H 'content-type: application/json' \
  -d '{
        "name": "issuance-maker",
        "role": "Issuer",
        "useCaseKey": "domicile-certificate-tehsildar-office",
        "scopes": ["credentials:issue"]
      }'
```

```
201 Created
{
  "key": {
    "id": "cmslq2ryr…", "orgId": "cmslq2emp…", "userId": "cmslq2rx8…", "name": "issuance-maker",
    "prefix": "yQL2E9ro", "scopes": ["credentials:issue"],
    "role": "Issuer", "useCaseKey": "domicile-certificate-tehsildar-office",
    "status": "active", "expiresAt": null, "revokedAt": null, "revokedBy": null,
    "lastUsedAt": null, "createdBy": "cmslpx3f3…", "createdAt": "2026-08-09T…"
  },
  "secret": "tl_live_yQL2E9ro…"
}
```

A `useCaseKey` that does not resolve is a **`404 USE_CASE_NOT_FOUND`** here, not
a validation error on the body — which is why step 2 comes first.

**`secret` appears here and nowhere else, ever.** It is bcrypt-hashed at rest
and cannot be re-derived. No read route returns it. Store it before you
acknowledge this call; a lost secret means a rotation, which kills the old one
with no overlap window.

`key.prefix` is *not* the literal `tl_live_` marker — it is the first eight
characters of the secret's body, after the marker. It is public and safe to log,
and it is how you identify which key a listing row refers to.

Write it to a file with tight permissions rather than into your environment
inline:

```bash
umask 077; printf '%s' '<paste the secret>' > ~/.tokenlayer/maker.key
MAKER=$(cat ~/.tokenlayer/maker.key)
```

## 4. Mint the checker key

A *second* key, bound to a *different* service user, with role `OrgAdmin` — and
with `credentials:read` as well as `credentials:issue`, because this is the
principal that will read the credential back in step 8.

```bash
curl -sS -X POST https://<host>/api/v1/orgs/$ORG_ID/api-keys \
  -H "authorization: Bearer $TL_SESSION" \
  -H 'content-type: application/json' \
  -d '{ "name": "issuance-checker", "role": "OrgAdmin",
        "scopes": ["credentials:issue", "credentials:read"] }'
```

An `OrgAdmin` key takes no `useCaseKey` — its authority is the org, and the
response carries `"useCaseKey": null`.

*What just happened.* Each `POST /orgs/{id}/api-keys` creates its own service
user, so these two keys are two distinct principals with distinct ids. That is
what makes step 7 legal: the proposer may never decide their own proposal
(`403 SELF_APPROVAL`), and identity is by principal id, not by org.

Note the checker is `OrgAdmin`, not `Issuer`. See the warning at the top.

## 5. Find an eligible holder

Needs **`users:read`**. Skip this step entirely if you already know the
subject's user id — that is the usual case, and it is why `users:read` is not in
the prerequisites.

**Do not reach for `$MAKER` here.** The maker holds `credentials:issue` and
nothing else, so it answers

```
403 { "error": "INSUFFICIENT_SCOPE",
      "message": "this API key lacks the 'users:read' scope",
      "details": { "required": "users:read", "granted": ["credentials:issue"] } }
```

Browse holders from your human session, or mint a *third*, read-only key for it.
Widening the maker to see every onboarded person in the deployment is the wrong
trade for a one-off lookup.

```bash
curl -sS "https://<host>/api/v1/credential-use-cases/$UC_KEY/eligible-holders" \
  -H "authorization: Bearer $TL_SESSION"
```

```
200 OK
[ { "kind": "user", "id": "cmslpx3gj…", "label": "asha@example.test",
    "did": "did:key:z6Mkhzo3…", "subLabel": null },
  { "kind": "org",  "id": "cmslq2emp…", "label": "Tehsildar Office",
    "did": "did:key:z6Mkmf6k…", "subLabel": "government" } ]
```

The list mixes **`kind: "user"` and `kind: "org"` rows** — an organization can
hold a credential too, and `subLabel` is the org's type on those rows and the
member's org (or `null`) on user rows. Pass a user row's id as `subjectUserId`
and an org row's id as `subjectOrgId`.

It is already filtered by the use case's `holderPolicy` and, for orgs, by the
`Holder` capability — so anything it offers is something issuance will accept.

## 6. Draft the issuance — this is where the 202 lives

```bash
curl -sS -i -X POST https://<host>/api/v1/credential-use-cases/$UC_KEY/credentials \
  -H "authorization: Bearer $MAKER" \
  -H 'content-type: application/json' \
  -d '{
        "credentialType": "DomicileCredential",
        "subjectUserId": "usr_…",
        "claims": {
          "holderName": "Asha Rao",
          "state": "Karnataka",
          "district": "Bengaluru Urban",
          "continuousResidenceSinceYear": 2009
        }
      }'
```

```
202 Accepted
{
  "proposal": {
    "id": "prp_…",
    "kind": "issue-usecase-credential",
    "useCaseKey": null,
    "orgId": "org_…",
    "assetId": null,
    "payload": { "credentialUseCaseKey": "domicile-certificate-tehsildar-office",
                 "credentialType": "DomicileCredential",
                 "subjectDid": "did:key:z6Mk…", "subjectUserId": "usr_…",
                 "claims": { … }, "issuerOrgId": "org_…" },
    "proposerId": "usr_…", "proposerLabel": "svc-issuance-maker-…@service.tokenlayer.local",
    "required": 1, "approvals": [], "status": "pending",
    "error": null, "result": null, "decidedAt": null, "createdAt": "2026-08-09T…"
  }
}
```

*What just happened.* **Nothing was issued.** `useCaseKey` is empty because
credential proposals belong to an *organization*, not to a use case — that is
also why their visibility is org-scoped rather than use-case-scoped. Treat
`useCaseKey` on a credential proposal as "not applicable" and never as a key:
this route returns `null` for it while the approve route in step 7 and the
listing return `""`. Do not branch on which.

`result` stays `null` even after execution — it is **not** where the new
credential's id appears. See step 8.

Supply exactly one of `subjectUserId` or `subjectOrgId`; supplying both or
neither is `400 SUBJECT_REQUIRED`.

Failures you can hit here, all *before* a proposal exists:

| status | error | meaning |
|---|---|---|
| 400 | `UNKNOWN_CREDENTIAL_TYPE` | the type is not in this use case |
| 400 | `INVALID_METADATA` | your `claims` do not satisfy the claim schema |
| 400 | `SUBJECT_HAS_NO_DID` | the subject was never onboarded with a DID |
| 403 | `ISSUER_NOT_PERMITTED` | your org is not this use case's configured issuer |
| 403 | `HOLDER_NOT_ELIGIBLE` | the subject fails the use case's holder policy |
| 403 | `ORG_CAPABILITY_MISSING` | the issuing org's envelope lacks `Issuer` |

## 7. Approve, as the checker

```bash
curl -sS -i -X POST https://<host>/api/v1/proposals/$PROPOSAL_ID/approve \
  -H "authorization: Bearer $CHECKER" \
  -H 'content-type: application/json' -d '{}'
```

```
200 OK
{
  "proposal": {
    "id": "prp_…", "kind": "issue-usecase-credential",
    "approvals": [ { "userId": "usr_…", "email": "svc-issuance-checker-…@service.tokenlayer.local", "at": "2026-08-09T…" } ],
    "required": 1, "status": "executed", "decidedAt": "2026-08-09T…"
  }
}
```

*What just happened.* **`status: "executed"` is the success signal, and only
that.** Read it, not the HTTP status.

- `"pending"` — an approval was recorded but `approvals.length < required`. Get
  the remaining approvals from other principals.
- `"executed"` — the credential exists.
- `"failed"` — the approval threshold was reached and then the operation threw.
  The **`error`** field says why. Common causes: the issuing org lost its `Issuer`
  capability while the proposal sat pending (the envelope is re-checked at
  execution, never trusted from draft time), or the proposer's account was
  deactivated (`PROPOSER_INACTIVE`).

The operation executes **as the proposer**, not as you: RBAC and compliance are
re-applied to the maker's identity at execution time.

Rejections you may hit:

| status | error | meaning |
|---|---|---|
| **404** | `NOT_FOUND` | **your role may not view this kind.** An `Issuer` key gets this — *including the Issuer that proposed it*. Use `OrgAdmin` or above |
| 403 | `SELF_APPROVAL` | you are the proposer — use a second principal. Only reachable by a role that could otherwise have approved |
| 403 | `INSUFFICIENT_SCOPE` | your key lacks `credentials:issue`; `details` names it |
| 409 | `PROPOSAL_NOT_PENDING` | already decided, or another approval finalized it first |
| 409 | `ALREADY_APPROVED_BY_YOU` | one approval per principal |

The 404 is listed first because it is the one that will happen to you. It is
checked before `SELF_APPROVAL`, so an `Issuer` maker never gets the more
informative error.

### Polling for the outcome

**There is no `GET /proposals/{id}`.** To poll, list and match on the id:

```bash
curl -sS "https://<host>/api/v1/proposals?status=pending" -H "authorization: Bearer $CHECKER" \
  | jq --arg id "$PROPOSAL_ID" '.[] | select(.id == $id)'
```

An empty result means it is no longer pending — re-query without the filter to
read its terminal status. The listing is narrowed to your tenancy, and for a key
further narrowed to kinds that key could itself decide.

The better answer for anything long-running is not to poll at all: subscribe to
the **`proposal.executed`** event (see *Receive webhooks*), which fires after
execution returns — so it means "it happened", not "it was approved".

## 8. Find the credential and let the holder accept it

The proposal does not carry the new credential's id — `result` is `null` even on
an executed proposal. Read it back from the issuer side, **as the checker**:

```bash
curl -sS https://<host>/api/v1/orgs/$ORG_ID/credentials -H "authorization: Bearer $CHECKER"
```

```
200 OK
[ { "id": "d5b1097c-d1e0-4853-9862-754bceb03b27", "type": "DomicileCredential",
    "holderDid": "did:key:z6Mkhzo3…",
    "claims": { "id": "did:key:z6Mkhzo3…", "holderName": "Asha Rao", … },
    "issuedAt": "2026-08-09T…", "expiresAt": "2031-08-08T…",
    "revoked": false, "revokedAt": null, "revokedReason": null },
  { "id": "…", "type": "OrganizationMembership", … } ]
```

**Not as the maker.** This route is `PlatformAdmin`-or-that-org's-`OrgAdmin`,
checked before the scope; an `Issuer` key gets `403 FORBIDDEN` however many
scopes you pile onto it. It is also the *only* issuer-side route that returns
the credential — there is no `GET /credential-use-cases/{key}/credentials`.

Two things about the list itself: `claims` carries an extra `id` holding the
subject DID (the W3C `credentialSubject.id`, not a claim you sent), and the list
includes every credential this org has issued, **including the
`OrganizationMembership` credentials minted for each of your own API keys**.
Filter by `type`.

If the use case sets `holderAcceptance`, the credential is born `pending` and
the holder must accept it before it can be presented in a verification. **The
built-in `domicile-certificate` template does not set it**, so on the path this
guide walks the credential is born `"acceptance": "accepted"` and the accept
call below is a no-op that answers `409`. Check before you call:

```bash
curl -sS https://<host>/api/v1/me/credentials -H "authorization: Bearer $HOLDER_SESSION" \
  | jq '.[] | select(.type[0] == "DomicileCredential") | { id, acceptance, anchorTxHash }'
```

```json
{ "id": "d5b1097c-…", "acceptance": "accepted", "anchorTxHash": "0x2ca586de…" }
```

Note `type` here is an **array** (`["DomicileCredential"]`), unlike the scalar
`type` on the issuer-side list above. `/me/credentials` also returns the full
`vcJwt` — it is the holder's own credential, and it is the only route that
hands out the signed blob.

The holder acts from **their own session** — one person answering about their
own credential:

```bash
curl -sS -X POST https://<host>/api/v1/me/credentials/$CRED_ID/accept \
  -H "authorization: Bearer $HOLDER_SESSION" -H 'content-type: application/json' -d '{}'
```

```
200 OK
{ "id": "cred_…", "acceptance": "accepted", "acceptanceAt": "2026-08-09T…" }
```

```
409 { "error": "INVALID_ACCEPTANCE_STATE", "message": "credential is 'accepted'" }
```

`409 INVALID_ACCEPTANCE_STATE` means it is not in `pending` or
`changes_requested` — most often, as above, because the use case never asked for
acceptance at all. The holder's other two answers are `POST …/reject` (which
**revokes the credential on-chain**, not just locally) and
`POST …/request-changes` with a `note`.

## 9. Run a verification

Three principals, three calls. The verifier needs **`verifications:request`**;
the holder's consent needs **`credentials:read`** (it *discloses* credentials to
a third party, which is why it is scoped at all); reading the verdict needs
**`verifications:verify`**, deliberately separate from `verifications:read`
because the verdict is a stronger disclosure than the request.

**The scope is not enough — the verifier's *role* gates this route.** Only two
principals may raise a verification request: a `Verifier` bound to this
credential use case (`useCaseKey` must equal the use case, and the request is
pinned to it), or the `OrgAdmin` of an organization the use case's `verifier`
binding allows. Anything else, scope or no scope:

```
403 { "error": "NOT_A_VERIFIER", "message": "only an organization admin may request a presentation" }
```

So mint the verifier as its own key — `"role": "Verifier"`, `"useCaseKey":
"<the use case>"`, `"scopes": ["verifications:request", "verifications:verify"]`
— rather than trying to reuse the maker or the checker.

```bash
# the verifier asks
curl -sS -X POST https://<host>/api/v1/verification-requests \
  -H "authorization: Bearer $VERIFIER" -H 'content-type: application/json' \
  -d '{ "holderDid": "did:key:z6Mk…",
        "requestedTypes": ["DomicileCredential"],
        "purpose": "tenancy check",
        "credentialUseCaseKey": "domicile-certificate-tehsildar-office" }'

# the holder consents (holder session only — nobody else may consent)
curl -sS -X POST https://<host>/api/v1/verification-requests/$REQ_ID/consent \
  -H "authorization: Bearer $HOLDER_SESSION" -H 'content-type: application/json' \
  -d '{ "credentialIds": ["cred_…"] }'

# the verifier reads the verdict
curl -sS https://<host>/api/v1/verification-requests/$REQ_ID/verify \
  -H "authorization: Bearer $VERIFIER"
```

The first call answers **`201`** with the request — `{ "id": "cmslq6gdx…",
"status": "pending", "verifierOrgId": "", … }`. A use-case-scoped `Verifier`
desk owns no organization, so `verifierOrgId` is the empty string rather than an
org id; the request is bound to the use case through `credentialUseCaseKey`
instead. The consent call answers `200` with the same object at
`"status": "consented"` and `consentedCredentialIds` filled in.

```
200 OK
{
  "valid": true,
  "holderDid": "did:key:z6Mk…",
  "purpose": "tenancy check",
  "verifiedAt": "2026-08-09T…",
  "reason": null,
  "credentials": [
    { "id": "cred_…", "type": "DomicileCredential", "issuer": "did:key:z6Mk…",
      "claims": { "holderName": "Asha Rao", "state": "Karnataka", … },
      "valid": true, "reason": null,
      "checks": { "signature": true, "trusted": true, "notExpired": true,
                  "subjectBound": true, "notRevoked": true },
      "issuerResolution": { "registered": true, "active": true, "chainId": "besu" },
      "anchorTxHash": "0x…", "anchorChainId": "besu", "revokeTxHash": null }
  ]
}
```

There is a `reason` at both levels: `null` on a pass, and on a failure the
per-credential one says which credential and the top-level one says why the
whole presentation failed. Log both — `checks` alone will not tell you that a
requested type was simply missing.

*What just happened.* **A failed verification is a `200`, not an error.** Read
`valid`, never the status code — only a not-yet-consented request is a `409`.
And `valid` is stricter than the array below it: it is true only if the
presentation verifies **and** every one of `requestedTypes` is covered by a
valid credential. Three good credentials that miss one requested type is
`valid: false` with no invalid entry in the list.

`notRevoked` is a boolean: an *unknown* revocation state reads as `false`, so a
credential whose status cannot be established fails closed.

A revoked credential cannot even be presented — consent refuses it with
`400 CREDENTIAL_NOT_ELIGIBLE`, which is stricter than letting it through to a
failing verify.

---

## Verify it independently

"The API returned 200" is not proof to anyone integrating with a ledger. Three
checks, in increasing order of independence.

**1. The public status endpoint — no credential required at all.**

```bash
curl -sS https://<host>/api/v1/credentials/$CRED_ID/status
```

```
200 OK
{ "id": "cred_…", "revoked": false, "revokedAt": null, "reason": null,
  "acceptance": "accepted",
  "anchored": true, "source": "chain",
  "chainId": "besu", "registry": "0x…", "vcHash": "0x…",
  "anchorTxHash": "0x…", "anchorChainId": "besu", "revokeTxHash": null }
```

Read **`source`**, not `revoked`. `source: "chain"` means the answer came from
the on-chain registry. `source: "database"` with `anchored: false` means the
platform is answering from its own copy — either there is no registry
configured, the read failed, or the credential predates the registry. An absent
on-chain record is **not** a negative revocation, and this endpoint deliberately
does not dress one up as one.

**2. Go around the API entirely.** `GET /registry` gives you the contract
addresses; then `eth_call` them yourself:

```bash
curl -sS https://<host>/api/v1/registry -H "authorization: Bearer $TL_SESSION"
# { "chainId": "besu", "didRegistry": "0x…", "vcRegistry": "0x…", "deployTxHash": "0x…" }
```

- `VcRegistry.statusOf(bytes32)` keyed by `keccak256(credentialId)` returns
  `(exists, revoked, revokedAt, vcHash, issuedAt, expiresAt)`. `exists == true`
  and `revoked == false` is the credential, on chain, with this platform out of
  the loop.
- `DidRegistry.isActive(string)` on the issuer's DID returns `true`. Run it
  against a DID you invented as a negative control — it must return `false`.

The id is hashed with **`keccak256` over the UTF-8 bytes of the credential id
string** — not over a `0x`-decoded value, and the registry stores no ids in the
clear, so there is nothing to enumerate:

```js
const idHash = ethers.keccak256(ethers.toUtf8Bytes(credentialId));
await vcRegistry.statusOf(idHash);
// [ true, false, 0n,
//   '0x34fff81ef9b92775a9ac3cb4d1b389b5a248b28def2c8edda0422b9499d93a07',
//   1786275153n, 1943955153n ]
```

Match the fourth element against the `vcHash` that check 1 reported. If those
agree, the platform's public status route and the ledger are telling you the
same thing, and you did not have to trust the former to establish it. On the
same run, `isActive` returned `true` for the issuer DID and `false` for an
invented one.

**3. Resolve the issuer DID as a stranger would.** `GET /dids/{did}/resolve` is
public and unauthenticated, and returns a W3C DID document:

```bash
curl -sS "https://<host>/api/v1/dids/did%3Akey%3Az6Mk…/resolve"
```

`didDocumentMetadata.source == "chain"`, `registered == true`, `active == true`
means the trust anchor behind every one of those signatures is on the ledger,
and `didDocumentMetadata.registry` should equal the `didRegistry` address you
read in check 2.

Note that revoking a credential does **not** deactivate the issuer's DID: after
a revoke, `statusOf` flips to `revoked: true` while the issuer DID still
resolves active. That is correct, and a check that expects otherwise is wrong.
