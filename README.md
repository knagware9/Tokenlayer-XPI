# TokenLayer

> One platform. Any asset. Any chain.

A **chain-agnostic, multi-standard tokenization platform** with **low-code, configurable use
cases**. Issue and operate compliance-aware tokens through one engine and one API — across
multiple DLTs and token standards — where the platform code stays identical regardless of which
ledger or standard an asset uses.

## What it does

- **Multi-DLT** — one `LedgerAdapter` seam, many chains: an **EVM** family
  (**Besu**, **MST Testnet**, `local-evm`) plus **Hyperledger Fabric** and **Canton**.
  The default deploy (`make deploy`) runs the **real Besu** chain — it is required and
  refuses to boot if the RPC is unreachable. EVM chains are **real-or-absent** (never
  silently mocked); `fabric`/`canton` remain in-memory simulations (labeled as such in the
  dashboard). A simulated-only stack is available via `make deploy-sim` / `CHAIN_STRICT=0`.
  **Each use case chooses which DLTs it may deploy to.** A single behavioural suite passes
  identically against every adapter.
- **Multi-standard** — **ERC-20**, **ERC-721** (NFT), and **ERC-3643**. On EVM chains, ERC-3643
  issues a **full, official T-REX suite** (vendored `@tokenysolutions/t-rex` + `@onchain-id/solidity`):
  ONCHAINID identities, IdentityRegistry, TrustedIssuers, and ModularCompliance. The use case
  selects the standard; the engine handles fungible (amount) and non-fungible (token-id)
  operations uniformly. The simulated ledger (fabric/canton/local dev) mirrors the rules so
  behaviour matches everywhere.
- **Low-code use cases** — token behaviour (standard, allowed chains, required metadata,
  lifecycle actions, compliance) is declarative config, stored in a DB and editable via a
  **dashboard Use-Case Builder**. New asset types need **no code**.
- **Lifecycle engine** — one policy chokepoint enforcing, in order: RBAC → lifecycle rules →
  token-type → compliance (allowlist + freeze), then dispatching to the bound chain and writing
  an immutable audit record.
- **RBAC** — six roles with strict per-use-case isolation, enforced server-side and mirrored in the UI (see [Users & Roles](#users--roles) below).
- **API-driven** — Fastify + JWT over Prisma/SQLite; everything (issuance, lifecycle,
  use-case CRUD) is a REST endpoint.
- **React dashboard** — login, per-use-case routing (`/<use-case-key>`), and a two-section
  nav structure:
  - **Asset Management** (sub-tabs: Token Issuance · Marketplace · My Holdings) — role-gated
    issuance, lifecycle actions (fungible *and* NFT), holders + token tables, audit timeline.
  - **User Management** (sub-tabs: Add User · Manage Users) — invite users, reset passwords,
    revoke/reactivate (suspended users cannot log in: `ACCOUNT_SUSPENDED`), and delete.
    Onboarding captures KYC details (legal name, country, ID type/number, document reference).
    New users start KYC **pending**; a UseCaseAdmin/PlatformAdmin **Approves/Rejects** them in
    Manage Users. A wallet can only be allowlisted on an asset once its owner is KYC-approved
    (`KYC_NOT_APPROVED` otherwise); unlinked demo wallets are exempt.
  - **PlatformAdmin** lands on `/` (use-case catalog/switcher + the Use-Case Builder); scoped
    users (Issuer, Trader, Buyer, Auditor, UseCaseAdmin) land directly on their own use case.

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
  chains.json        Declarative chain registry (besu, mst, fabric, canton, local-evm).
  use-cases/         Default use cases: generic-asset (ERC-20), generic-certificate (ERC-721),
                     gold-loan (ERC-20), corporate-bond (ERC-3643). Seeded into the DB on startup.
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

Open http://localhost:5173 and log in with any of the seeded demo accounts below. For pure
local dev without a chain, boot non-strict (`CHAIN_STRICT=0 pnpm api:dev`) to explore with the
simulated `fabric`/`canton` chains, or point `BESU_RPC_URL` at a real Besu node to make the
required `besu` chain available. Three standards (ERC-20 / ERC-721 / ERC-3643) are available
regardless.

## Users & Roles

### Six roles

| Role | Scope | What it can do |
| ---- | ----- | -------------- |
| **PlatformAdmin** | global | Create/edit use cases, create the first UseCaseAdmin for each use case, view all assets |
| **UseCaseAdmin** | own use case | Manage that use case's user roster (Issuer / Trader / Buyer / Auditor), manage assets |
| **Issuer** | own use case | Issue (tokenize) assets, mint, KYC-allowlist accounts, freeze/unfreeze accounts |
| **Trader** | own use case | Transfer and burn tokens |
| **Buyer** | own use case | Read-only: browse the catalog and view own holdings |
| **Auditor** | own use case | Read-only: full audit trail + asset details |

**Strict per-use-case isolation** — every non-PlatformAdmin user belongs to exactly one use case
and only sees and acts within it. A gold-loan Issuer cannot read, list, or act on any carbon-credit
asset (and vice versa).

### Provisioning flow

```
PlatformAdmin
  → creates use case
  → creates first UseCaseAdmin for that use case

UseCaseAdmin (scoped)
  → creates Issuer / Trader / Buyer / Auditor (all scoped to same use case)
  → cannot create another UseCaseAdmin (escalation blocked)
```

### Demo credentials

**Platform Admin (global)**

| Role | Email | Password |
| ---- | ----- | -------- |
| PlatformAdmin | admin@tokenlayer.dev | admin123 |

**Carbon Credit use case**

| Role | Email | Password |
| ---- | ----- | -------- |
| UseCaseAdmin | carbon.admin@tokenlayer.dev | carbon123 |
| Issuer | carbon.issuer@tokenlayer.dev | carbon123 |
| Trader | carbon.trader@tokenlayer.dev | carbon123 |
| Buyer | carbon.buyer@tokenlayer.dev | carbon123 |
| Auditor | carbon.auditor@tokenlayer.dev | carbon123 |

**Gold Loan use case**

| Role | Email | Password |
| ---- | ----- | -------- |
| UseCaseAdmin | gold.admin@tokenlayer.dev | gold123 |
| Issuer | gold.issuer@tokenlayer.dev | gold123 |
| Trader | gold.trader@tokenlayer.dev | gold123 |
| Buyer | gold.buyer@tokenlayer.dev | gold123 |
| Auditor | gold.auditor@tokenlayer.dev | gold123 |

**Corporate Bond use case**

| Role | Email | Password |
| ---- | ----- | -------- |
| UseCaseAdmin | bond.admin@tokenlayer.dev | bond123 |
| Issuer | bond.issuer@tokenlayer.dev | bond123 |
| Trader | bond.trader@tokenlayer.dev | bond123 |
| Buyer | bond.buyer@tokenlayer.dev | bond123 |
| Auditor | bond.auditor@tokenlayer.dev | bond123 |

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

In the Docker deploy, `make deploy` wires Besu automatically via the `docker-compose.besu.yml`
overlay; because `besu` is `required`, the default strict boot needs it reachable (see
[DEPLOY.md](DEPLOY.md)).

#### MST Testnet

The `mst` chain is preconfigured for the public **MST Testnet** (chainId `91562037`, native
`tMSTC`, explorer [testnet.mstscan.com](https://testnet.mstscan.com)). Fund an operator address
with test `tMSTC` from the [MST faucet](https://faucet.mstblockchain.com/), then:

```bash
MST_RPC_URL=https://testnetrpc.mstblockchain.com \
MST_OPERATOR_KEY=0x<funded-testnet-key> \
CHAIN_STRICT=0 pnpm api:dev
```

`mst` then appears in the chain picker and deploys real contracts on the testnet; the dashboard
links each asset's contract address and tx hashes to the MST explorer. At boot the API validates
the RPC reports chainId `91562037` and refuses to start against the wrong network. (`CHAIN_STRICT=0`
lets the API boot without the `required` `besu` chain while you work on MST.)

## Low-code: create a use case (no code)

Sign in as **PlatformAdmin** → navigate to `/` (Platform home) → **Use-Case Builder** panel.
Pick a token standard, choose which DLTs it may deploy to, define metadata fields, toggle
lifecycle actions and compliance, set roles, and create it. It is immediately available
in the **Token Issuance** sub-tab of any scoped user's **Asset Management** view. The same
is available over the API:

```bash
POST /use-cases     # create (PlatformAdmin)
PUT  /use-cases/:key  # edit  (PlatformAdmin)
```

## REST API

The platform is fully API-driven. All endpoints are versioned under **`/api/v1`**, validated by
JSON schema, and documented with **OpenAPI 3**:

- **Swagger UI:** `http://localhost:4000/docs` (with an Authorize button for the Bearer token)
- **OpenAPI document:** `http://localhost:4000/openapi.json`

Auth is a JWT obtained from `POST /api/v1/auth/login`, sent as `Authorization: Bearer <token>`.

| Method & path | Purpose |
| --- | --- |
| `POST /api/v1/auth/login` | Obtain a JWT |
| `GET /api/v1/chains` · `GET /api/v1/accounts` | Catalog |
| `GET/POST/PUT /api/v1/use-cases[/:key]` | Low-code asset-type definitions (create/edit = PlatformAdmin) |
| `POST /api/v1/assets` | Issue (tokenize) an asset |
| `GET /api/v1/assets?useCaseKey=&chainId=&status=&limit=&offset=` | List assets (filter + paginate) |
| `GET /api/v1/assets/:id` · `/accounts` · `/tokens` · `/audit` | Asset, holders, NFT tokens, audit (paginated) |
| `POST /api/v1/assets/:id/actions/{mint\|transfer\|burn\|freeze\|unfreeze\|allow\|disallow}` | Lifecycle |
| `POST /api/v1/assets/:id/actions/setPrice` | Set sale terms on an existing asset (Issuer / UseCaseAdmin) |
| `POST /api/v1/assets/:id/buy` | Buyer self-service DvP purchase (see below) |
| `POST /api/v1/cash/credit` | Credit CBDC to a wallet (Issuer / UseCaseAdmin / PlatformAdmin) |
| `GET /api/v1/cash/balances?address=` | Query CBDC balances for a wallet |
| `GET /api/v1/currencies` | List supported currencies |

**Conventions.** Errors use a uniform envelope `{ "error": "<CODE>", "message": "...", "details"?: {} }`
(`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `NOT_ALLOWLISTED`, `ACCOUNT_FROZEN`, …).
Unbounded collections return `{ "data": [...], "pagination": { "limit", "offset", "total" } }`.

## Marketplace Buy & CBDC Payment

### Listing an asset for sale

Include a `sale` object when issuing (`POST /assets`), or call `POST /assets/:id/actions/setPrice`
after issuance:

```json
{ "unitPrice": "5", "currency": "CBDC-INR", "treasuryAccount": "0x..." }
```

`unitPrice` is a positive integer (smallest CBDC unit). `treasuryAccount` is the on-chain wallet
that holds the tokens and receives payment.

### Supported currencies

Configured in `config/currencies.json` (defaults: `CBDC-INR`, `USDC`, `e-GBP`).
Query the live list via `GET /api/v1/currencies`.

### Funding buyers

`POST /api/v1/cash/credit { "account", "currency", "amount" }` — restricted to
Issuer / UseCaseAdmin / PlatformAdmin. Amounts must be positive integers.
Scoped users can only fund wallets within their own use case.

### Buyer self-service DvP

`POST /api/v1/assets/:id/buy { "quantity": "<positive-integer>" }` — validates buyer has
a linked wallet, sufficient CBDC balance (`quantity × unitPrice`), and the treasury holds
enough tokens, then transfers cash first; if the token delivery fails (including allowlist
checks), the cash is automatically refunded. On success the response includes the receipt,
the amount paid, and the delivery details.

```bash
TOKEN=$(curl -s localhost:4000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"gold.issuer@tokenlayer.dev","password":"gold123"}' | jq -r .token)
curl -s localhost:4000/api/v1/assets -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"useCaseKey":"gold-loan","name":"GL-1","symbol":"GLD","chainId":"besu","metadata":{"borrower":"R","goldWeightGrams":250,"loanAmountInr":500000}}'
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
chain is simulated or real. EVM chains (besu/mst/local-evm) are **real when their RPC + key are
configured, otherwise absent** — never silently mocked; `fabric`/`canton` fall back to the
simulated adapter when unconfigured. Activation is by **configuration**.

| Integration | Status | How to enable |
| ----------- | ------ | ------------- |
| **T-REX ERC-3643** (ONCHAINID + registries + modular compliance) | **Real & verified** — issued through the platform on any EVM chain | automatic for ERC-3643 use cases on an EVM chain |
| **Besu / MST Testnet** (and any EVM) | **Real** — the adapter deploys real contracts incl. T-REX; MST Testnet (chainId 91562037) is preconfigured with explorer links + a boot chainId guard | set `BESU_RPC_URL` (see [`infra/besu`](infra/besu/README.md)) or `MST_RPC_URL=https://testnetrpc.mstblockchain.com` + a funded key (faucet: https://faucet.mstblockchain.com/) |
| **Hyperledger Fabric** | **Production scaffolding** (Go chaincode + `fabric-network` adapter); not run in this env | [`infra/fabric`](infra/fabric/README.md): set `FABRIC_CONNECTION_PROFILE` |
| **Canton / Daml** | **Production scaffolding** (Daml model + JSON-API adapter); not run in this env | [`infra/canton`](infra/canton/README.md): set `CANTON_LEDGER_URL` + party/token/template |

On EVM, ERC-3643 issuance deploys the full T-REX stack and **"Allow" an account = registering an
ONCHAINID identity + KYC claim**; transfers run as agent-mediated `forcedTransfer`, with the
engine enforcing identity + freeze policy.

## Roadmap context

This is the foundational slice of the broader TokenLayer roadmap. The default deploy now runs on a
**real** Hyperledger Besu (QBFT) network, and ERC-3643 issuance deploys the full T-REX stack.
The `mst` chain is preconfigured for the public MST Testnet. Deliberately deferred: **real**
Fabric/Canton networks, MST mainnet / production key management, KYC/AML provider integrations,
cross-chain bridging, secondary markets, payments/custody rails, AI analytics, and multi-tenant
SaaS billing. The adapter seam, declarative use cases, and compliance hooks are
designed so these attach without rework.

## Notes & limitations (MVP)

- Unconfigured **fabric/canton** chains run on the in-memory simulated ledger (balances reset when
  the API restarts); set each chain's connection env to use its real backend. **EVM chains (besu,
  mst, local-evm) are real-or-absent** — with no RPC + key they simply don't appear, never mocked;
  `besu` is required, so a strict boot (the default) needs it reachable, or set `CHAIN_STRICT=0` to
  boot without it. Asset + use-case records persist in SQLite; EVM chain state persists for the life
  of the node.
- ERC-721 token ids on EVM chains are numeric (the contract uses `uint256`); the simulated
  ledger accepts any string id.
- Fabric/Canton are behaviourally faithful simulations, not live networks; real SDK-backed
  adapters slot in behind the same `LedgerAdapter` interface.
- Auth is JWT-only; enterprise SSO (SAML/OIDC) is a later phase. SQLite is used for zero-setup
  dev; the Prisma datasource can point at Postgres.
```
