# Issue a credential

> **Draft.** These steps have not yet been executed end to end against a live
> deployment. They are written from the route handlers and their tests; task
> D1-7 runs them verbatim against Besu and corrects whatever diverges.

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
| scope | `credentials:issue` | `credentials:issue` |
| also needs | `credentials:read` to read the result back | — |

The checker needs `credentials:issue` too: the required scope for a decision is
derived from the proposal's *kind*, not from the route. Approving is what
executes the operation, so it is gated exactly as drafting is. Rejecting too.

Later steps each add one scope, called out where they need it — `users:read` to
list eligible holders, `verifications:request` / `verifications:verify` to run a
verification. Do not grant them up front.

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

`403 SERVICE_ACCOUNT` means you tried to log in as a key's bound service user.
Service users have no usable password by construction; the key is their only
way in.

## 2. Mint the maker key

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
        "scopes": ["credentials:issue", "credentials:read"]
      }'
```

```
201 Created
{
  "key": {
    "id": "key_…", "orgId": "org_…", "userId": "usr_…", "name": "issuance-maker",
    "prefix": "<8 chars>", "scopes": ["credentials:issue","credentials:read"],
    "role": "Issuer", "useCaseKey": "domicile-certificate-tehsildar-office",
    "status": "active", "expiresAt": null, "createdAt": "2026-08-09T…"
  },
  "secret": "tl_live_…"
}
```

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

## 3. Mint the checker key

A *second* key, bound to a *different* service user, with role `OrgAdmin`.

```bash
curl -sS -X POST https://<host>/api/v1/orgs/$ORG_ID/api-keys \
  -H "authorization: Bearer $TL_SESSION" \
  -H 'content-type: application/json' \
  -d '{ "name": "issuance-checker", "role": "OrgAdmin", "scopes": ["credentials:issue"] }'
```

*What just happened.* Each `POST /orgs/{id}/api-keys` creates its own service
user, so these two keys are two distinct principals with distinct ids. That is
what makes step 7 legal: the proposer may never decide their own proposal
(`403 SELF_APPROVAL`), and identity is by principal id, not by org.

Note the checker is `OrgAdmin`, not `Issuer`. See the warning at the top.

## 4. Pick a credential use case

```bash
curl -sS https://<host>/api/v1/credential-use-cases -H "authorization: Bearer $TL_SESSION"
```

```
200 OK
[ { "key": "domicile-certificate-tehsildar-office",
    "name": "Tehsildar Office — Domicile Certificate",
    "credentialTypes": [ { "name": "DomicileCredential", "title": "Domicile Credential",
                           "validityDays": 1825, "requiredApprovals": 1,
                           "required": ["holderName","state","continuousResidenceSinceYear"],
                           "properties": { … } } ],
    "issuer": { "kind": "org", "orgId": "org_…" },
    "holderPolicy": { "who": "any-onboarded" },
    "verifier": { "kind": "any" },
    "ownerOrgId": "org_…", "status": "active" } ]
```

Read `credentialTypes[].required` and `.properties` — that is the claim schema
your `claims` object must satisfy, and a mismatch is a `400 INVALID_METADATA`
before any proposal is created. For `DomicileCredential` the required claims are
**`holderName`, `state` and `continuousResidenceSinceYear`** — `district` is
optional. `requiredApprovals` is how many approvals the proposal will need.

**If you have no use case yet**, provision one from a built-in template. This
step needs the **`usecases:provision`** scope — a broader grant than issuance,
because provisioning creates an org and a use case rather than a credential, so
do it from your human session and do not put that scope on the maker key:

```bash
curl -sS -X POST https://<host>/api/v1/credential-use-cases/provision \
  -H "authorization: Bearer $TL_SESSION" \
  -H 'content-type: application/json' \
  -d '{ "templateKey": "domicile-certificate",
        "params": { "issuerOrgName": "Tehsildar Office" },
        "provisioning": { "issuerOrgType": "government" } }'
```

`createDeskUsers: true` also creates staffed Issuer/Holder/Verifier accounts and
returns their server-generated passwords. It is refused for a key
(`403 MACHINE_PRINCIPAL`) precisely because those passwords would be disclosed
to whoever holds the key.

## 5. Find an eligible holder

Needs **`users:read`** — one extra scope, and only on the key that browses
holders. Skip this step entirely if you already know the subject's user id.

```bash
curl -sS "https://<host>/api/v1/credential-use-cases/$UC_KEY/eligible-holders" \
  -H "authorization: Bearer $MAKER"
```

```
200 OK
[ { "kind": "user", "id": "usr_…", "label": "asha@example.test",
    "did": "did:key:z6Mk…", "subLabel": "Tehsildar Office" } ]
```

The list is already filtered by the use case's `holderPolicy` and, for orgs, by
the `Holder` capability — so anything it offers is something issuance will
accept.

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
    "required": 1, "approvals": [], "status": "pending"
  }
}
```

*What just happened.* **Nothing was issued.** `useCaseKey` is `null` because
credential proposals belong to an *organization*, not to a use case — that is
also why their visibility is org-scoped rather than use-case-scoped. Supply
exactly one of `subjectUserId` or `subjectOrgId`; supplying both or neither is
`400 SUBJECT_REQUIRED`.

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
| 403 | `SELF_APPROVAL` | you are the proposer — use a second principal |
| **404** | `NOT_FOUND` | **your role may not view this kind.** An `Issuer` key gets this. Use `OrgAdmin` or above |
| 403 | `INSUFFICIENT_SCOPE` | your key lacks `credentials:issue`; `details` names it |
| 409 | `PROPOSAL_NOT_PENDING` | already decided, or another approval finalized it first |
| 409 | `ALREADY_APPROVED_BY_YOU` | one approval per principal |

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

The proposal does not carry the new credential's id. Read it back from the
issuer side (`credentials:read`):

```bash
curl -sS https://<host>/api/v1/orgs/$ORG_ID/credentials -H "authorization: Bearer $MAKER"
```

```
200 OK
[ { "id": "cred_…", "type": "DomicileCredential", "holderDid": "did:key:z6Mk…",
    "claims": { "holderName": "Asha Rao", … },
    "issuedAt": "2026-08-09T…", "expiresAt": "2031-08-08T…",
    "revoked": false, "revokedAt": null, "revokedReason": null } ]
```

If the use case sets `holderAcceptance`, the credential is born `pending` and
the holder must accept it before it can be presented in a verification. The
holder acts from **their own session** — this is one person answering about
their own credential, and it needs no scope at all:

```bash
curl -sS https://<host>/api/v1/me/credentials -H "authorization: Bearer $HOLDER_SESSION"

curl -sS -X POST https://<host>/api/v1/me/credentials/$CRED_ID/accept \
  -H "authorization: Bearer $HOLDER_SESSION" -H 'content-type: application/json' -d '{}'
```

```
200 OK
{ "id": "cred_…", "acceptance": "accepted", "acceptanceAt": "2026-08-09T…" }
```

`409 INVALID_ACCEPTANCE_STATE` means it is not in `pending` or
`changes_requested` — most often it was already accepted. The holder's other
two answers are `POST …/reject` (which **revokes the credential on-chain**, not
just locally) and `POST …/request-changes` with a `note`.

## 9. Run a verification

Three principals, three calls. The verifier needs **`verifications:request`**;
the holder's consent needs **`credentials:read`** (it *discloses* credentials to
a third party, which is why it is scoped at all); reading the verdict needs
**`verifications:verify`**, deliberately separate from `verifications:read`
because the verdict is a stronger disclosure than the request.

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

```
200 OK
{
  "valid": true,
  "holderDid": "did:key:z6Mk…",
  "purpose": "tenancy check",
  "verifiedAt": "2026-08-09T…",
  "credentials": [
    { "id": "cred_…", "type": "DomicileCredential", "issuer": "did:key:z6Mk…",
      "claims": { "holderName": "Asha Rao", "state": "Karnataka", … },
      "valid": true,
      "checks": { "signature": true, "trusted": true, "notExpired": true,
                  "subjectBound": true, "notRevoked": true },
      "issuerResolution": { "registered": true, "active": true, "chainId": "besu" },
      "anchorTxHash": "0x…", "anchorChainId": "besu", "revokeTxHash": null }
  ]
}
```

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
