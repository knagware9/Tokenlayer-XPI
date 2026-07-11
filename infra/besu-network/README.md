# Besu QBFT dev network (vendored)

A 5-node Hyperledger Besu **QBFT** development network, vendored verbatim from the
`deposittokenization` project so TokenLayer is self-contained. Chain id **1337**,
2-second blocks, peer discovery via `static-nodes.json` (fixed IPs on
`172.16.239.0/24`, no bootnode).

## Contents

| File | Purpose |
| ---- | ------- |
| `genesis.json` | QBFT genesis (chainId 1337, London enabled, 5 validators in `extraData`) |
| `static-nodes.json` | Enode list for the 5 nodes at `172.16.239.11–.15:30303` |
| `node1/key` … `node5/key` | Validator node private keys (one per node) |
| `start-network.sh` | Legacy startup script from the source project (not used here — see below) |

## ⚠️ DEV ONLY — never use in production

- The **node private keys** (`node*/key`) are committed to this repo. Anyone can
  impersonate these validators. They exist only so the local dev network starts
  deterministically.
- The genesis pre-funds account `0xfe3b557e8fb62b89f4916b721be55ceb828dbd73`
  (~200 ETH) whose private key
  (`0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63`) is a
  **well-known public Besu dev key**. Never send real value to it and never
  reuse any of these keys on a public or production network.

## How to start

From the repo root:

```bash
make besu-up      # docker compose -f docker-compose.besu-nodes.yml up -d
make besu-down    # tear it down
```

This creates the docker network `besu-network` and starts `besu-node1` … `besu-node5`
(fresh chain data lives in named volumes). Node 1 exposes JSON-RPC on the host at
**http://localhost:8545**; nodes 2–5 are internal. The TokenLayer stack joins the
same network via the `docker-compose.besu.yml` overlay and reaches the RPC at
`http://besu-node1:8545`.

**Migration note:** if this machine previously ran the network from an external
`deposittokenization` checkout, its leftover bridge occupies the same subnet and
`make besu-up` fails with *"Pool overlaps with other one on this address space"*.
Remove the stale bridge first (safe — the external compose recreates it on demand):

```bash
docker network rm deposittokenization_besu-network
```

`start-network.sh` is kept for provenance only — it belongs to the source
project's compose layout (different service names) and is not needed here; the
compose file's healthchecks + static nodes handle startup ordering.
