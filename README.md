# TokenLayer

> One platform. Any asset. Any chain.

A **chain-agnostic, multi-standard tokenization platform** with **low-code, configurable use
cases**. Issue and operate compliance-aware tokens through one engine and one API — across
multiple DLTs and token standards — where the platform code stays identical regardless of which
ledger or standard an asset uses.

## What it does

- **Multi-DLT** — one `LedgerAdapter` seam, many chains: a real **EVM** family
  (`local-evm`, **Besu**, **MST** public EVM) plus **Hyperledger Fabric** and **Canton**
  (full adapters over a simulated ledger, no Docker/Daml required) and an in-memory **mock**
  chain. **Each use case chooses which DLTs it may deploy to.** A single behavioural suite
  passes identically against every adapter.
- **Multi-standard** — **ERC-20**, **ERC-721** (NFT), and **ERC-3643**. On EVM chains, ERC-3643
  issues a **full, official T-REX suite** (vendored `@tokenysolutions/t-rex` + `@onchain-id/solidity`):
  ONCHAINID identities, IdentityRegistry, TrustedIssuers, and ModularCompliance. The use case
  selects the standard; the engine handles fungible (amount) and non-fungible (token-id)
  operations uniformly. The simulated ledger mirrors the rules so behaviour matches everywhere.
- **Low-code use cases** — token behaviour (standard, allowed chains, required metadata,
  lifecycle actions, compliance) is declarative config, stored in a DB and editable via a
  **dashboard Use-Case Builder**. New asset types need **no code**.
- **Lifecycle engine** — one policy chokepoint enforcing, in order: RBAC → lifecycle rules →
  token-type → compliance (allowlist + freeze), then dispatching to the bound chain and writing
  an immutable audit record.
- **RBAC** — Admin / Issuer / Operator / Viewer, enforced server-side and mirrored in the UI.
- **API-driven** — Fastify + JWT over Prisma/SQLite; everything (issuance, lifecycle,
  use-case CRUD) is a REST endpoint.
- **React dashboard** — login, use-case catalog, issuance, role-gated lifecycle actions
  (fungible *and* NFT), holders + token tables, audit timeline, and the Use-Case Builder.

## Architecture

```
packages/
  core/        Domain: LedgerAdapter interface (fungible + NFT), UseCaseSource,
               UseCaseRegistry, RbacPolicy, LifecycleEngine, validation. Pure, fully tested.
  adapters/    SimulatedLedger + Mock/Fabric/Canton adapters; EvmLedgerAdapter (ethers v6,
               per-standard deploy) with a SerialNonceSigner; real T-REX deployer (trex/);
               real Fabric (fabric/) + Canton (canton/) adapters; shared parity suite.
  contracts/   Hardhat: ComplianceToken (ERC-20), ComplianceNFT (ERC-721),
               ComplianceToken3643 (ERC-3643), + vendored official T-REX/ONCHAINID.
infra/         besu/ (Docker), fabric/ (Go chaincode), canton/ (Daml) — real-DLT scaffolding.
apps/
  api/         Fastify HTTP layer, JWT/RBAC, Prisma persistence, DB-backed use cases, demo.
  web/         React + Vite + Tailwind dashboard incl. the Use-Case Builder.
config/
  chains.json        Declarative chain registry (mock, fabric, canton, local-evm, besu, mst).
  use-cases/         Default use cases: generic-asset (ERC-20), generic-certificate (ERC-721),
                     security-token (ERC-3643). Seeded into the DB on startup.
```

The chain-agnostic seam — every ledger implements this and nothing else leaks chain specifics:

```ts
interface LedgerAdapter {
  readonly chainId: string;
  readonly family: "evm" | "fabric" | "canton" | "mock";
  deployAsset(spec): Promise<DeployResult>;                       // spec carries the standard
  mint / transfer / burn / balanceOf / totalSupply               // fungible (ERC-20 / 3643)
  mintToken / transferToken / burnToken / ownerOf / tokensOf      // non-fungible (ERC-721)
  setFrozen / setAllowed / isFrozen / isAllowed                   // compliance (all standards)
}
```

## Quick start

Requires Node ≥ 20 and `pnpm`.

```bash
pnpm install
pnpm --filter @tokenlayer/contracts build   # compile the Solidity contracts
pnpm --filter @tokenlayer/api db:setup       # create the SQLite database
pnpm api:dev      # API on http://localhost:4000   (terminal 1)
pnpm web:dev      # dashboard on http://localhost:5173 (terminal 2)
```

Open http://localhost:5173 and use **Quick login** (Admin / Issuer / Operator / Viewer). Out of
the box you get three DLTs (mock, Fabric, Canton) and three standards.

### Demo credentials

| Role     | Email                   | Password    |
| -------- | ----------------------- | ----------- |
| Admin    | admin@tokenlayer.dev    | admin123    |
| Issuer   | issuer@tokenlayer.dev   | issuer123   |
| Operator | operator@tokenlayer.dev | operator123 |
| Viewer   | viewer@tokenlayer.dev   | viewer123   |

### Enabling EVM chains (local-evm / Besu / MST)

EVM chains are added when their RPC URL + operator key are configured. With a local Hardhat
node:

```bash
pnpm chain:node                                   # terminal 1 — local EVM at :8545

EVM_RPC_URL=http://127.0.0.1:8545 \
EVM_OPERATOR_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
pnpm api:dev                                       # terminal 2
```

`local-evm` now appears in the chain picker and deploys real `ComplianceToken` /
`ComplianceNFT` / `ComplianceToken3643` contracts. Besu and MST work the same way via
`BESU_RPC_URL` / `MST_RPC_URL` (see `config/chains.json` and `apps/api/.env.example`).

## Low-code: create a use case (no code)

Sign in as **Admin** → **Use Cases** tab. Pick a token standard, choose which DLTs it may
deploy to, define metadata fields, toggle lifecycle actions and compliance, set roles, and
create it. It is immediately available in **Issue Asset**. The same is available over the API:

```bash
POST /use-cases     # create (Admin)
PUT  /use-cases/:key  # edit  (Admin)
```

## Verify

```bash
pnpm -r test        # core (31), adapter parity mock/fabric/canton/EVM + NFT + real T-REX (42),
                    # Solidity incl. official T-REX suite (20), API integration (11)
pnpm -r typecheck
pnpm build

# Headless end-to-end across DLTs + standards + low-code use-case creation:
pnpm --filter @tokenlayer/api demo                 # simulated chains
# ...with a Hardhat node running, the SAME script also exercises the real EVM:
EVM_RPC_URL=http://127.0.0.1:8545 \
EVM_OPERATOR_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
pnpm --filter @tokenlayer/api demo
```

The adapter parity suite boots an isolated Hardhat node automatically; if one cannot start, that
suite skips rather than failing.

## Real DLT integrations

Every chain runs behind one `LedgerAdapter` seam, so the platform code is identical whether a
chain is simulated or real. Real integrations activate by **configuration**, falling back to the
simulated adapter otherwise — the platform always runs.

| Integration | Status | How to enable |
| ----------- | ------ | ------------- |
| **T-REX ERC-3643** (ONCHAINID + registries + modular compliance) | **Real & verified** — issued through the platform on any EVM chain | automatic for ERC-3643 use cases on an EVM chain |
| **Besu / MST** (and any EVM) | **Real** — Besu is EVM; the adapter deploys real contracts incl. T-REX | [`infra/besu`](infra/besu/README.md): set `BESU_RPC_URL` / `MST_RPC_URL` + a funded key |
| **Hyperledger Fabric** | **Production scaffolding** (Go chaincode + `fabric-network` adapter); not run in this env | [`infra/fabric`](infra/fabric/README.md): set `FABRIC_CONNECTION_PROFILE` |
| **Canton / Daml** | **Production scaffolding** (Daml model + JSON-API adapter); not run in this env | [`infra/canton`](infra/canton/README.md): set `CANTON_LEDGER_URL` + party/token/template |

On EVM, ERC-3643 issuance deploys the full T-REX stack and **"Allow" an account = registering an
ONCHAINID identity + KYC claim**; transfers run as agent-mediated `forcedTransfer`, with the
engine enforcing identity + freeze policy.

## Roadmap context

This is the foundational slice of the broader TokenLayer roadmap. Deliberately deferred:
**real** Fabric/Canton networks and full T-REX (ONCHAINID, modular compliance, trusted issuers),
real Besu/MST public deployments, KYC/AML provider integrations, cross-chain bridging, secondary
markets, payments/custody rails, AI analytics, and multi-tenant SaaS billing. The adapter seam,
declarative use cases, and compliance hooks are designed so these attach without rework.

## Notes & limitations (MVP)

- Simulated chains (mock, Fabric, Canton) are in-memory: balances reset when the API restarts
  (asset + use-case records persist in SQLite). EVM chains persist for the life of the node.
- ERC-721 token ids on EVM chains are numeric (the contract uses `uint256`); the simulated
  ledger accepts any string id.
- Fabric/Canton are behaviourally faithful simulations, not live networks; real SDK-backed
  adapters slot in behind the same `LedgerAdapter` interface.
- Auth is JWT-only; enterprise SSO (SAML/OIDC) is a later phase. SQLite is used for zero-setup
  dev; the Prisma datasource can point at Postgres.
```
