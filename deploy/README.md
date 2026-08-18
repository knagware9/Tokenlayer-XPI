# `deploy/` — one entry point per product

The source is split by product across all seven layers; deployment follows the
same three-way split, and for the same reason: **the two products ship apart.**

| File | Brings up | Depends on |
|---|---|---|
| `shared.sh` | Secrets, the `xi-net` network, optionally Besu | nothing |
| `identity.sh` | Issuer console, verifier console, wallet | `shared.sh` |
| `tokenization.sh` | Issuer desk, marketplace, platform admin | `shared.sh`, *optionally* identity |

`shared` is not a leftovers bucket. It holds what neither product owns alone:
the secrets (a DID seed written by identity must decrypt in tokenization), the
network the identity seam crosses, and the chain both products anchor on.

## Usage

```bash
bash deploy/identity.sh --chain=besu                          # anchor on local Besu
bash deploy/identity.sh --chain=mst                           # anchor on the MST testnet
bash deploy/tokenization.sh --chain=besu,mst,fabric           # mint on all three
bash deploy/tokenization.sh --chain=besu --with-identity      # linked to identity
```

## Choosing the ledger

`--chain=` takes `besu`, `mst`, `fabric`, or a comma-separated list. Omit it and
every ledger is simulated.

| | What it is | Prepared by `shared.sh` |
|---|---|---|
| `besu` | **Real.** Vendored 5-node QBFT, chainId 1337 | Starts the nodes, waits for block production, attaches `besu-node1` to `xi-net` |
| `mst` | **Real.** Public testnet, chainId 91562037 | Verifies `MST_*` credentials and probes the RPC's chainId |
| `fabric` | **Simulated in containers** | Selects it, and says plainly why it cannot be real here |

Two constraints the flags enforce rather than document and hope:

**Identity anchors on EVM only.** The DID and VC registries are Solidity
contracts and `CredentialAnchor` exists solely on the EVM adapter, so
`identity.sh --chain=fabric` is *refused*. `identity.sh` also sets
`REGISTRY_CHAIN_ID` to the first EVM chain you named, so `--chain=mst` anchors
on MST without a second flag. Tokenization has no such limit — a use case names
its own chain, so all three are valid targets at once.

**Fabric cannot be real in a container.** Neither split compose file passes
`FABRIC_*` through, and the profile `make fabric-up` emits binds host localhost
ports with `asLocalhost: true`. Real Fabric needs the host API:
`make fabric-up && ./scripts/api-fabric.sh`.

### How Besu reaches a split stack

The vendored validators run on their own `besu-network`; the split APIs run on
`xi-net`. Before this they could not reach each other, so a split deployment had
**no Besu at all** — `BESU_RPC_URL` was unset and the chain was simply absent,
which the app reports honestly and which looks like a mystery from outside.

The fix is declarative: `docker-compose.<stack>.besu.yml` attaches that stack's
API to `besu-network` and supplies the RPC URL, and `scripts/stack-up.sh` applies
it when you pass `--chain=besu`. So the wiring is identical whether you arrive
through `deploy/`, through `stack-up.sh`, or through `make deploy-split`.

**The app joins the chain's network, not the reverse.** An earlier version did
`docker network connect xi-net besu-node1` from `shared.sh`. It worked, but only
for deployments that came through that one script, and it reached into the
chain's own topology to do it — the validators are peers of each other and
should not acquire a dependency on an application network.

Every script is idempotent — re-running brings the stack to the same state
rather than duplicating anything.

Logins and URLs: [`docs/demo-credentials.md`](../docs/demo-credentials.md).

## Two things worth knowing before you run these

**The identity link is one-way and optional.** Tokenization asks identity one
question — does this DID hold a valid KycCredential — and only a DID crosses the
wire. Without `--with-identity`, a use case carrying `requireVerifiedIdentity`
refuses at the first gated transfer, not at boot. Standalone and linked are
different deployments, not a preference.

**`shared.sh` checks that Besu PRODUCES BLOCKS, not that it has validators.**
`qbft_getValidatorsByBlockNumber` returns the *configured* set — it answers "5"
from a chain that has not produced a block in days. That is not hypothetical:
a stalled network was reported ready by exactly that check while every
transaction sat unmined and the app hung waiting for receipts. `shared.sh` reads
the height twice and requires it to move.

If it reports a stuck height, a restart will not fix it — QBFT needs 4 of 5
validators, and a network that has lost consensus needs a `down -v` re-genesis.
That destroys all chain history, so the scripts refuse to do it and tell you
instead.

## What these scripts do NOT do

They delegate the stack lifecycle to `scripts/stack-up.sh`, which owns the
identity peer-key handshake and the volume-age check deciding whether a stored
key is still valid. That logic is subtle and already correct; a second copy here
is precisely the drift the split was meant to end.

For the single combined deployment (both products in one API, one database),
use `./scripts/deploy.sh` — a different topology, not a different flavour of
these.
