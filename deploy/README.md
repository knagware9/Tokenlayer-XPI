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
bash deploy/identity.sh --besu                      # identity, on the real chain
bash deploy/tokenization.sh                         # tokenization, standalone
bash deploy/tokenization.sh --besu --with-identity  # both, linked
```

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
