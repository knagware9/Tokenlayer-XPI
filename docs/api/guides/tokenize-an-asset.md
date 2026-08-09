# Tokenize an asset

> **Draft.** These steps have not yet been executed end to end against a live
> deployment. They are written from the route handlers and their tests; task
> D1-7 runs them verbatim against Besu and corrects whatever diverges.

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
| configure a use case (1) | `usecases:provision` |
| issue an asset (5) | `assets:issue` |
| transfer (6) | `assets:transfer` |
| read holders, audit, assets (2, 7, 8) | `assets:read` |
| onboard the desk member (3) | `users:onboard` |

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
**non-empty `roles`** array. Omit `lifecycle` or send `roles: []` and you get a
validation error, not a helpful gate message.

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

Other answers: `409 USECASE_EXISTS` / `409 KEY_TAKEN` (the slug is unique across
*both* the tokenization and credential domains), `400 NO_DEPLOYABLE_CHAIN` if no
allowed chain could be reached.

## 2. Confirm the contract actually deployed

```bash
curl -sS https://<host>/api/v1/use-cases/globex-bond -H "authorization: Bearer $TL_SESSION"
```

```
200 OK
{ "key": "globex-bond", "name": "Globex Bond", "symbol": "GXB",
  "tokenStandard": "ERC-20", "tokenType": "fungible",
  "allowedChainIds": ["besu"], "defaultChainId": "besu",
  "contracts": { "besu": { "contractRef": "0x…", "deployTxHash": "0x…" } },
  "ownerOrgId": "org_…", "lifecycle": { … }, "compliance": { … }, "roles": [ … ] }
```

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
        "treasuryAccount": "0x…",
        "metadata": {} }'
```

**Ungated use case — `201`, and it is minted:**

```
201 Created
{ "asset": { "id": "ast_…", "useCaseKey": "globex-bond", "name": "Bond Series A",
             "symbol": "GXB", "chainId": "besu", "contractRef": "0x…",
             "tokenType": "fungible", "tokenStandard": "ERC-20",
             "status": "active", "totalSupply": "1000",
             "treasuryAccount": "0x…", "createdAt": "2026-08-09T…" },
  "txHash": "0x…" }
```

**Gated use case (`workflow.approvals.issue` set) — `202`, and it is not:**

```
202 Accepted
{ "proposal": { "id": "prp_…", "kind": "issue", "useCaseKey": "globex-bond",
                "assetId": "ast_…", "payload": { "initialSupply": "1000", "treasury": "0x…" },
                "required": 1, "approvals": [], "status": "pending" },
  "asset": { "id": "ast_…", "status": "pending_approval", "totalSupply": null, … } }
```

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

Other answers on this route: `403 WRONG_USE_CASE` (a key may not issue into
another use case), `400 INVALID_SUPPLY` / `400 MISSING_TREASURY`,
`400 SUPPLY_UNSUPPORTED` (initial supply is fungible-only),
`409 DUPLICATE_ASSET` when the use case declares `uniqueBy` and that metadata
value is already tokenized.

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
An `Issuer` gets `403 NOT_ELIGIBLE`; a member of a different use case gets
`404`.

Other answers: `409 ASSET_NOT_ACTIVE` (the asset is matured, retired, or still
`pending_approval` from an unapproved gated issuance), `403 FORBIDDEN` from
RBAC, and compliance rejections from the use case's own rules.

## 7. Read the holders

```bash
curl -sS https://<host>/api/v1/assets/$ASSET_ID/accounts -H "authorization: Bearer $ISSUER"
```

```
200 OK
[ { "address": "0x…", "label": "Globex Treasury", "balance": "750", "frozen": false, "allowed": true },
  { "address": "0x…", "label": "Acme Custody",    "balance": "250", "frozen": false, "allowed": true } ]
```

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
    { "id": "aud_…", "assetId": "ast_…", "actorId": "usr_…", "action": "issue",
      "payload": { … }, "txHash": "0x…", "chainId": "besu", "createdAt": "2026-08-09T…" },
    { "id": "aud_…", "assetId": "ast_…", "actorId": "usr_…", "action": "transfer",
      "payload": { "from": "0x…", "to": "0x…", "amount": "250" },
      "txHash": "0x…", "chainId": "besu", "createdAt": "2026-08-09T…" }
  ],
  "pagination": { "limit": 100, "offset": 0, "total": 2 } }
```

The log is append-only and hash-chained. Note that a gated operation appears
here **once, at execution**, under the *proposer's* `actorId` — not under the
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

**2. Verify the audit chain against its on-ledger anchor.**

```bash
curl -sS https://<host>/api/v1/assets/$ASSET_ID/audit/verify -H "authorization: Bearer $ISSUER"
```

This recomputes the asset's audit hash chain and compares it against the anchor
written on the ledger. It is the check that catches a tampered log — a log that
merely *reads* consistently proves nothing about itself.

There is also `GET /audit/verify` for a whole-scope summary.

**3. Go around the API entirely.** You have `contractRef` (the deployed token
contract) and every `txHash` from the receipts and the audit trail. Against the
chain's own RPC:

```bash
curl -sS -X POST http://<rpc-host>:8545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x…"]}'
```

A receipt with `status: "0x1"` at that `blockNumber` is the mint or the transfer,
confirmed by the ledger with this platform out of the loop. For an ERC-20 use
case, an `eth_call` of `balanceOf(address)` against `contractRef` must agree
with the `balance` that step 7 reported for that address. If those two numbers
disagree, do not ship — say so.
