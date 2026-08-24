# Tokenize an asset

> **Verified.** Every call below was executed against a live deployment on Besu
> (task D1-7), on both an ungated and a gated use case, and the balances were
> reconciled against the chain's own RPC. Status codes, error codes and response
> shapes are what the server actually returned. Ids in the samples are
> illustrative: assets are UUIDs, use cases are the keys you chose, everything
> else is an opaque cuid.

Configure a use case, mint an asset on chain, transfer it, and read back who
holds it and what happened. Base URL throughout: `https://<host>/api/v1`.

---

## Read this first: which calls return 202

A **use case decides** which of its operations are gated behind maker-checker,
via `workflow.approvals`:

```json
"workflow": { "approvals": { "issue": 1, "transfer": 2 } }
```

Each key is a gated op (`issue`, `mint`, `transfer`, `burn`, `freeze`,
`unfreeze`, `cashflow-execute`) and each value is how many approvals it needs.
**An op that is not listed runs instantly. A listed op returns `202` and a
proposal, and no role bypasses it — including admins.**

So on a use case with no `workflow`:

- `POST /assets` → **`201`** with the asset and its `txHash`. It is minted.
- `POST /assets/{id}/actions/transfer` → **`200`** with a receipt. It moved.

And on a use case with `workflow.approvals.issue` / `.transfer` set, the same
two calls return **`202`** with a proposal, and nothing has happened yet.

**How the caller can tell, before calling:** read the use case and look at
`workflow.approvals`. There is no other signal, and guessing from the status
code after the fact means you have already half-built the wrong thing.

```bash
curl -sS https://<host>/api/v1/use-cases/$UC_KEY -H "authorization: Bearer $TL_SESSION" \
  | jq '.workflow.approvals'
```

```json
{ "issue": 1, "transfer": 2 }
```

`null` or `{}` means every op is ungated.

---

## Prerequisites

**Organization capability envelope.** Owning a tokenization use case requires
the **`tokenization`** domain in the org's envelope. Missing it is
`403 ORG_CAPABILITY_MISSING`, with `details.missing: "tokenization"`. A `null`
envelope is legacy-unrestricted and passes.

**Roles matter more than scopes here.** The role → action matrix is what
actually permits an operation; a scope only ever *narrows* a key below what its
bound role could already do. The rows that bite:

| role | may issue/mint | may transfer | may approve a `transfer` proposal |
|---|---|---|---|
| `PlatformAdmin` | yes | yes | yes |
| `UseCaseAdmin` | yes | yes | yes |
| `Issuer` | yes | **no** | **no** |
| `Trader` | no | yes | yes |
| `OrgAdmin` | **no** | **no** | **no** |

**`OrgAdmin` can only read.** An OrgAdmin key cannot issue an asset and cannot
approve a token proposal — which is the exact mirror-image of the credential
side, where OrgAdmin is the *only* role that can approve. Do not carry an
intuition from one guide into the other.

**Scopes**, granted narrowly and per step:

| step | scope |
|---|---|
| configure a use case, deploy a chain (1, 2) | `usecases:provision` |
| onboard the desk member (3) | `users:onboard` |
| issue an asset (5) | `assets:issue` |
| transfer (6) | `assets:transfer` |
| read holders, audit, the asset (7, 8, *Verify* 1–2) | `assets:read` |
| read the use case itself (2) | *none* |

`GET /use-cases` and `GET /use-cases/{key}` need authentication and no scope at
all: a use case is configuration, not holdings. `POST /audit/anchor` also takes
no scope — see *Verify it independently*.

**Approving a proposal needs the scope of the operation, not of the route.**
A `transfer` proposal is decided under `assets:transfer`; an `issue` proposal
under `assets:issue`. A checker key that holds only `assets:read` gets

```
403 { "error": "INSUFFICIENT_SCOPE",
      "message": "this API key lacks the 'assets:transfer' scope required to decide a 'transfer' proposal",
      "details": { "required": "assets:transfer", "granted": ["assets:issue","assets:read"] } }
```

and that scope check runs **before** the role check, so a wrongly-scoped key
never learns whether its role was eligible either.

**Credentials in transit.** Always `Authorization: Bearer …`, never a query
string. Read secrets from a file or a prompt; a secret typed inline lands in
your shell history.

---

## 1. Configure the use case

A use case is the contract template, the chains it may deploy on, and the
compliance, fee and approval policy every asset under it inherits.

**Core validation rejects an incomplete definition with a `400` before any gate
or capability check is reached.** The required fields are `key`, `name`,
`tokenStandard`, `symbol`, `allowedChainIds`, `defaultChainId`,
`metadataSchema`, a full **`lifecycle`**, a **`compliance`** object, and a
**non-empty `roles`** array. There are two different 400s and they come from
different layers:

```
# omitted `lifecycle` — JSON-schema layer
400 { "error": "VALIDATION_ERROR", "message": "body must have required property 'lifecycle'",
      "details": { "issues": [ … ] } }

# `roles: []` — domain layer
400 { "error": "INVALID_USECASE", "message": "use case 'zz-y' needs a non-empty 'roles' array" }
```

**`compliance: {}` is not enough.** The object must actually carry the flags:
`compliance.allowlist` must be a boolean, and omitting it is
`400 INVALID_USECASE` — "use case 'globex-bond' compliance.allowlist must be a
boolean" — which arrives *before* the duplicate-key check, so a half-filled
`compliance` will mask a `key` collision you also have.

```bash
curl -sS -i -X POST https://<host>/api/v1/use-cases \
  -H "authorization: Bearer $TL_SESSION" \
  -H 'content-type: application/json' \
  -d '{
        "key": "globex-bond",
        "name": "Globex Bond",
        "description": "Senior unsecured notes",
        "tokenStandard": "ERC-20",
        "symbol": "GXB",
        "allowedChainIds": ["besu"],
        "defaultChainId": "besu",
        "metadataSchema": { "type": "object", "properties": {} },
        "lifecycle": { "mint": true, "transfer": true, "burn": true, "freeze": true },
        "compliance": { "allowlist": false, "transferRestrictions": false },
        "roles": ["UseCaseAdmin", "Issuer", "Trader"]
      }'
```

**Which status you get depends on who you are:**

- **`PlatformAdmin` → `201`.** The use case is created *and* its contract is
  deployed on every allowed chain that is reachable, in the same call. The
  response is the use case, with `contracts` populated.
- **`OrgAdmin` → `202`.** Creating an org-owned use case is itself
  maker-checker'd. `ownerOrgId` is stamped from your own claims, never from the
  body.

```
202 Accepted
{ "proposal": { "id": "prp_…", "kind": "create-use-case", "useCaseKey": null,
                "orgId": "org_…", "payload": { …the definition, plus ownerOrgId… },
                "proposerId": "usr_…", "required": 1, "approvals": [], "status": "pending" } }
```

A `PlatformAdmin` then approves it, and the deploy happens *on approval*:

```bash
curl -sS -X POST https://<host>/api/v1/proposals/$PROPOSAL_ID/approve \
  -H "authorization: Bearer $PLATFORM_SESSION" -H 'content-type: application/json' -d '{}'
```

```
200 OK
{ "proposal": { "id": "prp_…", "status": "executed", "approvals": [ { … } ], … } }
```

`status: "executed"` is the success signal. `403 SELF_APPROVAL` if you are the
proposer — the checker must be a different principal, always.

Other answers, and note the two collisions are **not** symmetric:

```
# the key is taken by another TOKENIZATION use case
400 { "error": "INVALID_USECASE", "message": "use case 'globex-bond' already exists",
      "details": { "key": "globex-bond" } }

# the key is taken by a CREDENTIAL use case
409 { "error": "KEY_TAKEN", "message": "use-case key 'domicile-certificate-tehsildar-office' already exists" }
```

The slug is unique across *both* domains, but only the cross-domain clash is a
`409`; a same-domain duplicate comes back through the definition validator as a
`400`. If you are branching on status to decide "retry with a new slug", handle
both. `400 NO_DEPLOYABLE_CHAIN` if no allowed chain could be reached.

## 2. Confirm the contract actually deployed

```bash
curl -sS https://<host>/api/v1/use-cases/globex-bond -H "authorization: Bearer $TL_SESSION"
```

```
200 OK
{ "key": "globex-bond", "name": "Globex Bond", "symbol": "GXB",
  "description": "Senior unsecured notes",
  "tokenStandard": "ERC-20", "tokenType": "fungible",
  "allowedChainIds": ["besu"], "defaultChainId": "besu",
  "metadataSchema": { … },
  "contracts": { "besu": { "contractRef": "0x5846ab79…", "deployTxHash": "0x53ad1ded…" } },
  "lifecycle": { … }, "compliance": { … }, "roles": [ … ] }
```

`ownerOrgId` is **absent**, not null, on a platform-owned use case — one created
by a `PlatformAdmin`, whose session carries no org. Test for presence, not for a
value. `workflow` is likewise absent when nothing is gated, which is the `null`
case from the section above.

An empty `contracts` object means nothing deployed. Deploy one chain explicitly
(PlatformAdmin only, `usecases:provision`):

```bash
curl -sS -X POST https://<host>/api/v1/use-cases/globex-bond/deploy \
  -H "authorization: Bearer $PLATFORM_SESSION" -H 'content-type: application/json' \
  -d '{ "chainId": "besu" }'
```

A `502 DEPLOY_FAILED` leaves the deployment pending and **retry is safe**.
`400 ALREADY_DEPLOYED` means that chain already has a contract.

## 3. Onboard a desk member for the use case

The key you mint in step 4 authenticates as a service member, and its role and
use-case scope are its ceiling. Create the human-facing equivalent first if you
need one (`users:onboard`):

```bash
curl -sS -X POST https://<host>/api/v1/orgs/$ORG_ID/users \
  -H "authorization: Bearer $TL_SESSION" -H 'content-type: application/json' \
  -d '{ "email": "issuer@globex.test", "password": "<from a prompt>",
        "role": "Issuer", "useCaseKey": "globex-bond" }'
```

```
201 Created
{ "id": "usr_…", "email": "issuer@globex.test", "role": "Issuer",
  "useCaseKey": "globex-bond", "orgId": "org_…",
  "did": "did:key:z6Mk…", "membershipVc": true }
```

## 4. Mint the key

From a human session — a key may not mint a key (`403 MACHINE_PRINCIPAL`).

```bash
curl -sS -X POST https://<host>/api/v1/orgs/$ORG_ID/api-keys \
  -H "authorization: Bearer $TL_SESSION" -H 'content-type: application/json' \
  -d '{ "name": "issuance-desk", "role": "Issuer", "useCaseKey": "globex-bond",
        "scopes": ["assets:issue", "assets:read"] }'
```

```
201 Created
{ "key": { "id": "key_…", "prefix": "<8 chars>", "scopes": ["assets:issue","assets:read"],
           "role": "Issuer", "useCaseKey": "globex-bond", "status": "active", … },
  "secret": "tl_live_…" }
```

`secret` is returned **here and nowhere else, ever**. Store it before you
acknowledge the call:

```bash
umask 077; printf '%s' '<paste the secret>' > ~/.tokenlayer/issuer.key
ISSUER=$(cat ~/.tokenlayer/issuer.key)
```

A transfer needs `assets:transfer` and a role that has `transfer` — mint a
**separate** `Trader` or `UseCaseAdmin` key for step 6 rather than widening this
one. An `Issuer` key with `assets:transfer` still gets `403 FORBIDDEN`: the
scope narrows, it never grants.

## 5. Issue the asset

```bash
curl -sS -i -X POST https://<host>/api/v1/assets \
  -H "authorization: Bearer $ISSUER" -H 'content-type: application/json' \
  -d '{ "useCaseKey": "globex-bond",
        "name": "Bond Series A",
        "chainId": "besu",
        "initialSupply": "1000",
        "metadata": {} }'
```

**There is no `treasuryAccount` field, and that is not an omission.** The use
case owns a treasury account, provisioned when it was created, and the initial
supply is minted to that account. You do not name it and you cannot choose it —
an address the caller picks is an address the caller can point elsewhere. If
your integration still sends one:

- a top-level `treasuryAccount` here is **silently ignored** (the address does
  nothing — do not conclude the mint went there);
- a `sale.treasuryAccount`, or a `treasuryAccount` on `setPrice`, is a
  **`400 VALIDATION_ERROR`** — delete the field.

To find out where the supply actually went, read the use case's
`treasuryAccountId` from `GET /use-cases/{key}` and resolve it through
`GET /accounts`.

**Ungated use case — `201`, and it is minted:**

```
201 Created
{ "asset": { "id": "9f1f555d-c7ab-4ac8-8971-ddf18ee84750",
             "useCaseKey": "globex-bond", "name": "Bond Series A",
             "symbol": "GXB", "chainId": "besu", "contractRef": "0x5846ab79…",
             "tokenType": "fungible", "tokenStandard": "ERC-20",
             "status": "active", "metadata": {},
             "unitPrice": null, "currency": null,
             "treasuryAccount": null, "uniqueKey": null,
             "createdBy": "cmslqa0pg…", "createdAt": "2026-08-09T…" },
  "txHash": "0x53ad1ded…" }
```

**Three things in that body are not what they look like, and all three have
cost somebody an afternoon:**

- **There is no `totalSupply`.** Not `null` — absent. The created-asset row does
  not carry supply; supply is read live from the ledger by
  `GET /assets/{id}`. If your client asserts on `asset.totalSupply` here it will
  read `undefined` on a mint that entirely succeeded.
- **`treasuryAccount` is `null`** even though the supply was minted. That field
  is the *marketplace seller* — it is populated only once the asset has sale
  terms (`sale` on this call, or `setPrice` later), and it is then the use
  case's own treasury. It is not "where the mint went", and an asset with no
  sale terms has none. The supply did land in the treasury — check step 7, not
  this field.
- **`txHash` is the use case's contract deployment**, not the mint. It is the
  same `deployTxHash` step 2 showed you, identical for every asset under this
  use case, because assets share the use case's contract. **The mint has its own
  transaction and it is in the audit trail** (step 8) as the `mint` entry. If
  you store this hash as "the mint tx", every asset in the use case will point
  at the same block.

So: `POST /assets` returning `201` does mean the supply was minted — verified on
chain below — but the response body is about the *asset*, and the evidence of
the mint is one call further on.

**Gated use case (`workflow.approvals.issue` set) — `202`, and it is not:**

```
202 Accepted
{ "proposal": { "id": "cmslqc7mm…", "kind": "issue", "useCaseKey": "globex-gated",
                "orgId": null,
                "assetId": "d43c4dd1-37da-4884-863b-6390492f7390",
                "payload": { "initialSupply": "1000", "treasury": "0x15d34AAf…" },
                "required": 1, "approvals": [], "status": "pending",
                "error": null, "result": null, "decidedAt": null },
  "asset": { "id": "d43c4dd1-…", "status": "pending_approval", … } }
```

The asset object here has no `totalSupply` key either — for the opposite reason:
nothing has been minted at all.

*What just happened.* On the gated path an asset **row** exists at
`pending_approval` and carries an id — but it is frozen: no actions, no buys, no
listings, and **no supply has been minted**. The supply mint and the sale terms
are deferred and captured inside the proposal. Do not treat `asset.id` in a 202
as a live asset.

Approve it with a second, use-case-scoped principal holding the `issue`
capability (`UseCaseAdmin`, `Issuer` or `PlatformAdmin` — *not* `OrgAdmin`):

```bash
curl -sS -X POST https://<host>/api/v1/proposals/$PROPOSAL_ID/approve \
  -H "authorization: Bearer $CHECKER" -H 'content-type: application/json' -d '{}'
```

Read `proposal.status`: `"executed"` means it minted; `"failed"` — with the
reason in the proposal's **`error`** field — means the approval landed and the
mint then threw, and the issuance fee, if one was charged, is refunded.

Other answers on this route: `400 INVALID_SUPPLY` / `400 MISSING_TREASURY`,
`400 SUPPLY_UNSUPPORTED` (initial supply is fungible-only), `409 DUPLICATE_ASSET`
when the use case declares `uniqueBy` and that metadata value is already
tokenized.

And `403 WRONG_USE_CASE`, "cannot issue into another use case" — which is the
error an `OrgAdmin` key actually gets, *not* the `403 FORBIDDEN` you would
expect from the role matrix. An `OrgAdmin` key carries no `useCaseKey` at all,
so the use-case scope check fails first and the role never gets examined. Do not
read `WRONG_USE_CASE` as "wrong slug" and go hunting for a typo; on an OrgAdmin
key it means "this principal has no use case, and only `PlatformAdmin` may skip
that check".

## 6. Transfer

```bash
curl -sS -i -X POST https://<host>/api/v1/assets/$ASSET_ID/actions/transfer \
  -H "authorization: Bearer $TRADER" -H 'content-type: application/json' \
  -d '{ "from": "0x…", "to": "0x…", "amount": "250" }'
```

**Ungated — `200`, and it moved:**

```
200 OK
{ "receipt": { "txHash": "0x…", "chainId": "besu", "blockNumber": 4172,
               "timestamp": "2026-08-09T…" } }
```

**Gated (`workflow.approvals.transfer` set) — `202`, and it did not:**

```
202 Accepted
{ "proposal": { "id": "prp_…", "kind": "transfer", "useCaseKey": "globex-bond",
                "assetId": "ast_…", "payload": { "action": "transfer",
                "body": { "from": "0x…", "to": "0x…", "amount": "250" } },
                "required": 2, "approvals": [], "status": "pending" } }
```

*What just happened.* On the gated path the proposer's capability is checked
**up front** — you cannot propose what you could not do — and then the operation
is captured. With `required: 2` you need **two** distinct approvers, neither of
whom is the proposer. Each approval returns `200` with the proposal; only the
one that reaches the threshold flips `status` to `"executed"` and actually
moves the tokens.

Token proposals are **use-case scoped**, not org scoped: an approver must have
`useCaseKey == "globex-bond"` (or be `PlatformAdmin`) to see it at all, and must
hold the `transfer` capability — so `Trader`, `UseCaseAdmin` or `PlatformAdmin`.
Live, in order of which check fires first:

```
# right use case, wrong role — but only once the SCOPE is right
403 { "error": "NOT_ELIGIBLE", "message": "role 'Issuer' may not decide 'transfer' proposals" }

# an Issuer key WITHOUT assets:transfer never reaches that check
403 { "error": "INSUFFICIENT_SCOPE",
      "message": "this API key lacks the 'assets:transfer' scope required to decide a 'transfer' proposal" }

# a member of a different use case — and an OrgAdmin key, which has none
404 { "error": "NOT_FOUND", "message": "proposal not found" }
```

An `OrgAdmin` key landing on `404` rather than a role error is the same
mirror-image as the credential guide, running the other way: there, `OrgAdmin`
is the only role that can approve; here it cannot see the proposal at all.

Other answers: `409 ASSET_NOT_ACTIVE` (the asset is matured, retired, or still
`pending_approval` from an unapproved gated issuance), `403 FORBIDDEN` from
RBAC, and compliance rejections from the use case's own rules.

## 7. Read the holders

```bash
curl -sS https://<host>/api/v1/assets/$ASSET_ID/accounts -H "authorization: Bearer $ISSUER"
```

```
200 OK
[ { "address": "0x70997970…", "label": "Alice",    "balance": "250", "frozen": false, "allowed": false },
  { "address": "0x15d34AAf…", "label": "Treasury", "balance": "750", "frozen": false, "allowed": false } ]
```

**`allowed: false` is not a problem.** It reports membership of the use case's
allowlist, and this use case set `compliance.allowlist: false`, so nothing is on
one and nothing needs to be. Read `allowed` only when `compliance.allowlist` is
`true`; on a use case without an allowlist it is `false` for every holder,
including ones that just transferred successfully.

Holder data is exactly why reads are scoped: results are already narrowed to the
caller's use-case scope, and a key never sees more than the service user it is
bound to.

## 8. Read the audit trail

```bash
curl -sS "https://<host>/api/v1/assets/$ASSET_ID/audit?limit=100&offset=0" \
  -H "authorization: Bearer $ISSUER"
```

```
200 OK
{ "data": [
    { "id": "cmslqab2z…", "assetId": "9f1f555d-…", "actorId": "cmslqa0pg…", "action": "mint",
      "payload": { "to": "0x15d34AAf…", "amount": "1000", "actorRole": "Issuer" },
      "txHash": "0xc2208e79…", "chainId": "besu", "createdAt": "2026-08-09T…",
      "seq": 1, "prevHash": "0x38b5cff3…", "hash": "0x89dd546f…" },
    { "id": "cmslqa7v8…", "assetId": "9f1f555d-…", "actorId": "cmslqa0pg…", "action": "issue",
      "payload": { "useCaseKey": "globex-bond", "symbol": "GXB", "tokenStandard": "ERC-20",
                   "contractRef": "0x5846ab79…", "actorRole": "Issuer" },
      "txHash": "0x53ad1ded…", "chainId": "besu", "createdAt": "2026-08-09T…",
      "seq": 0, "prevHash": "0x3e744955…", "hash": "0x38b5cff3…" }
  ],
  "pagination": { "limit": 100, "offset": 0, "total": 2 } }
```

**`data` is newest-first.** Sort by `seq` ascending if you want the story in
order; `offset` pages backwards through history, it does not walk it forwards.

Note that `issue` and `mint` are **two entries**, and it is the `mint` one that
carries the transaction that moved supply — `0xc2208e79…` above, which is not
the `0x53ad1ded…` that `POST /assets` handed back. This is where you get the
mint's real `txHash`.

The log is append-only and hash-chained: each entry carries its `seq`, the
`prevHash` it extends and its own `hash`. A gated operation appears here
**once, at execution**, under the *proposer's* `actorId` — not under the
approver's, and not at propose time.

---

## Verify it independently

**1. Total supply comes from the ledger, not from the platform's copy.**

```bash
curl -sS https://<host>/api/v1/assets/$ASSET_ID -H "authorization: Bearer $ISSUER" \
  | jq '{ status, totalSupply, contractRef, chainId }'
```

```json
{ "status": "active", "totalSupply": "1000", "contractRef": "0x…", "chainId": "besu" }
```

`GET /assets/{id}` reads total supply live from the chain on every call. If it
disagrees with what you expect, the chain is right and your model is wrong.

**2. Verify the audit chain against its on-ledger anchor — but write an anchor
first.**

```bash
curl -sS https://<host>/api/v1/assets/$ASSET_ID/audit/verify -H "authorization: Bearer $ISSUER"
```

On a freshly issued asset this answers:

```json
{ "assetId": "9f1f555d-…", "valid": true, "count": 3, "head": "0x487bd741…",
  "brokenAt": null, "reason": null,
  "lastAnchor": null, "anchorConsistent": true }
```

**`anchorConsistent: true` with `lastAnchor: null` means no comparison was
made.** Anchors are not written automatically by issuing or transferring —
nothing on the happy path writes one — so out of the box this route recomputes
the hash chain and finds it internally consistent, which a tampering attacker
who rewrote the whole chain would also achieve. Read `lastAnchor` first and
treat `null` as "unanchored", never as "verified".

Write the anchor yourself. `POST /audit/anchor` anchors the head of every asset
in your scope and takes **no scope** — it discloses nothing and confers nothing,
it only spends gas — but it does require a role with the `issue` capability, or
`Auditor`:

```bash
curl -sS -X POST https://<host>/api/v1/audit/anchor \
  -H "authorization: Bearer $ISSUER" -H 'content-type: application/json' -d '{}'
```

```json
{ "anchored": [ { "assetId": "9f1f555d-…", "seq": 2, "txHash": "0x6dce9b72…" } ] }
```

Now the same verify call is worth something:

```json
{ "assetId": "9f1f555d-…", "valid": true, "count": 3, "head": "0x487bd741…",
  "lastAnchor": { "seq": 2, "hash": "0x487bd741…", "txHash": "0x6dce9b72…",
                  "chainId": "besu", "at": "2026-08-09T…" },
  "anchorConsistent": true }
```

`anchorConsistent` now really is a comparison against a hash on the ledger, and
that is the check that catches a tampered log — a log that merely *reads*
consistently proves nothing about itself. Anchor on a schedule; each anchor
freezes everything up to its `seq`.

There is also `GET /audit/verify` for a whole-scope summary — and it reports
`anchoredAssets`, which is the number you should be watching:

```json
{ "assets": 1, "verified": 1, "tampered": [], "anchoredAssets": 1 }
```

`anchoredAssets: 0` with `verified` equal to `assets` is the same trap one level
up: everything self-consistent, nothing actually pinned to a chain.

**3. Go around the API entirely.** You have `contractRef` (the deployed token
contract) and every `txHash` from the receipts and the audit trail. Against the
chain's own RPC:

```bash
curl -sS -X POST http://<rpc-host>:8545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x…"]}'
```

```json
{ "status": "0x1", "blockNumber": "0x20a6a", "to": "0x5846ab79…" }
```

A receipt with `status: "0x1"` at that `blockNumber` is the mint or the transfer,
confirmed by the ledger with this platform out of the loop. `to` is the use
case's `contractRef`. Take the hash from the **audit trail**, not from the
`POST /assets` body — see step 5.

For an ERC-20 use case, an `eth_call` of `balanceOf(address)` against
`contractRef` must agree with the `balance` that step 7 reported for that
address. On the live run, after minting 1000 to the treasury and transferring
250:

```
balanceOf(0x15d34AAf…)  750      # step 7 said "750"
balanceOf(0x70997970…)  250      # step 7 said "250"
totalSupply()          1000      # GET /assets/{id} said "1000"
```

If those numbers disagree, do not ship — say so.

**Units.** These tokens are indivisible: the contract reports `decimals() == 0`,
because the platform mints and accounts in whole units — an `initialSupply` of
`"1000"` is 1000 tokens. Raw `balanceOf` and the displayed value are therefore
the same number, and the same number the API reports, so a wallet or explorer
shows `750`, not `0.00000000000000075`.

Read `decimals()` from the contract rather than assuming it. Tokens deployed
before this convention landed still report `18` while holding whole-unit
balances; for those, and only those, a `formatUnits(balance, 18)` reading is
wrong by 10¹⁸ and you should compare raw values instead.
