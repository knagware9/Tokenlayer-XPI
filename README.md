# XI Tokenize

> One platform. Any asset. Any chain. Any credential.

A **chain-agnostic tokenization and digital-identity platform**. Asset types and credential
types are **declarative configuration**, not code — an organization signs itself up, describes
what it wants to issue, and the platform deploys the contract and operates the lifecycle.
The application code is identical regardless of which ledger, token standard, or credential
type an asset uses.

---

## Two domains, one application

XI Tokenize ships as one app with two pluggable domains. An organization is granted one or
both, and the console shows only what its envelope allows.

| Domain | What it does |
| --- | --- |
| **Tokenization** | Issue and operate compliance-aware tokens — ERC-20, ERC-721, ERC-3643 — across multiple DLTs, with a marketplace, cashflows, an invoice register and cross-ledger analytics. |
| **Identity** | Issue, hold, present and verify **W3C Verifiable Credentials** against custodial `did:key` identities, anchored on-chain, with PDF certificates and QR-based login. |

The two meet: a tokenization use case can require a **valid KYC credential** before an account
may buy, and revoking that credential closes the gate on the next attempt.

## How work gets authorised

Two ideas run through everything, and most of the security review effort went into them.

**Maker–checker by default.** Most mutations answer **`202` with a proposal**, not the object you
asked for. The request records an intent; the work happens when a second, distinct authorised
principal approves it. Self-approval is refused. This covers issuance, revocation, user
onboarding, use-case creation and capability changes.

**Capability envelopes.** Every organization carries an explicit envelope of **domains** and
**operating roles** (Issuer / Holder / Verifier). Every gate is `role && envelope && scope` —
narrowing only, never widening. An org-scoped API key authenticates *as* its bound service user,
so that user's role, the org's envelope and maker–checker all still apply.

## The corporate journey

```
Public sign-up (India KYB + certificate uploads)
  → PlatformAdmin review queue
  → approve = ISSUANCE CEREMONY
        · organization DID registered on-chain
        · platform-signed OrganizationCredential anchored
        · admin membership VC minted, login activated
  → OrgAdmin configures a use case      → 202 proposal
  → PlatformAdmin approves              → contract deployed, org-owned
  → the corporate onboards an Issuer and tokenizes
```

Each org can also set its **own logo and accent colour**; members see them across the console
and on the certificates the org issues.

---

## Architecture

```
packages/
  core/        Domain, pure and fully tested: LedgerAdapter interface, LifecycleEngine,
               RBAC, capability envelopes, use-case + credential-use-case validation,
               proposal kinds, certificate field vocabulary.
  adapters/    SimulatedLedger · EvmLedgerAdapter (ethers v6) · real T-REX/ERC-3643 deployer
               · Fabric · Canton · credential anchoring. One shared parity suite runs
               against every adapter.
  contracts/   Hardhat: ComplianceToken (ERC-20), ComplianceNFT (ERC-721),
               ComplianceToken3643, DidRegistry, VcRegistry + vendored official
               T-REX / ONCHAINID.
apps/
  api/         Fastify + JWT + Prisma/SQLite. Every capability is a REST endpoint under
               /api/v1, JSON-schema validated and documented with OpenAPI 3.
  web/         React + Vite + Tailwind console: domain switcher, low-code builders,
               approvals inbox, wallets, developer portal.
config/        chains.json · use-cases/*.json · currencies.json — declarative, seeded at boot.
infra/         besu-network/ (5-node QBFT, vendored) · fabric/ · canton/
scripts/       23 executable end-to-end walkthroughs (see Verify).
```

The chain-agnostic seam — every ledger implements this and nothing else leaks chain specifics:

```ts
interface LedgerAdapter {
  readonly chainId: string;
  readonly family: "evm" | "fabric" | "canton" | "mock";
  deployAsset(spec): Promise<DeployResult>;                  // spec carries the standard
  mint / transfer / burn / balanceOf / totalSupply           // fungible (ERC-20 / ERC-3643)
  mintToken / transferToken / burnToken / ownerOf / tokensOf // non-fungible (ERC-721)
  setFrozen / setAllowed / isFrozen / isAllowed              // compliance (all standards)
}
```

### Ledgers

EVM chains are **real or absent — never silently mocked**. If the RPC and operator key are not
configured, the chain simply does not appear.

| Chain | Status |
| --- | --- |
| **Besu** (QBFT, 5 nodes, vendored in `infra/besu-network/`) | Real. `make besu-up`, RPC on `:8545`, chainId 1337. |
| **MST Testnet** | Real. chainId 91562037, explorer links, boot-time chainId guard. |
| **Fabric · Canton** | Behaviourally faithful simulations; real SDK adapters slot in behind the same seam. |

---

## Quick start

Requires Node ≥ 20 and `pnpm`.

```bash
pnpm install
pnpm --filter @tokenlayer/contracts build    # compile the Solidity contracts
pnpm --filter @tokenlayer/api db:setup       # create the SQLite database
```

Then, in two terminals:

```bash
pnpm api:dev      # API      → http://localhost:4000
pnpm web:dev      # console  → http://localhost:5173
```

Open http://localhost:5173. Sign in as `admin@tokenlayer.dev` / `admin123`, or register a
company from the public homepage to walk the corporate journey end to end.

To boot without a chain, use `CHAIN_STRICT=0 pnpm api:dev` — EVM chains become absent and the
simulated ledgers remain. To run against real Besu:

```bash
make besu-up
BESU_RPC_URL=http://localhost:8545 \
BESU_OPERATOR_KEY=0x<dev-key> \
REGISTRY_CHAIN_ID=besu pnpm api:dev
```

See [`DEPLOY.md`](DEPLOY.md) for the Docker deployment and
[`apps/api/.env.example`](apps/api/.env.example) for every variable.

---

## Roles

| Role | Scope | What it can do |
| --- | --- | --- |
| **PlatformAdmin** | global | Everything: approve organizations, approve proposals, manage use cases. |
| **OrgAdmin** | own organization | Manage the org's roster, branding, API keys and webhooks; propose use cases. Deliberately holds `read` alone in the lifecycle matrix — org administration is not asset operation. |
| **UseCaseAdmin** | one use case | Full lifecycle within that use case; manage its roster. |
| **Issuer** | one use case | Issue, mint, allowlist, freeze. |
| **Trader** | one use case | Transfer, burn, buy, list. |
| **Buyer** | one use case | Buy, list, read. |
| **Auditor** | one use case | Read-only, including the full audit trail. |
| **Holder** | identity | Hold credentials, consent to presentations. |
| **Verifier** | identity | Request and verify credential presentations. |

**Strict per-use-case and per-organization isolation.** A gold-loan Issuer cannot read, list or
act on a carbon-credit asset; one organization cannot read another's documents, credentials or
brand assets.

---

## For integrators

Everything a system needs without a person signing in — credentials, event delivery, the full
reference and worked integrations — lives in the console under **Developers**.

- **OpenAPI document** — `GET /openapi.json`; committed as
  [`apps/api/openapi.snapshot.json`](apps/api/openapi.snapshot.json), so any change to the
  published surface shows up in a diff.
- **Changelog for the REST surface** — [`docs/api/CHANGELOG.md`](docs/api/CHANGELOG.md), written
  to answer *what changed* and *what must I do differently*.
- **Guides** — [`docs/api/guides/`](docs/api/guides/), each executed against a live stack rather
  than written from memory.

Two credentials travel in the same `Authorization: Bearer` header and are told apart by shape: a
**human session** JWT from `POST /auth/login`, and an **organization API key** (`tl_live_…` /
`tl_test_…`) shown once at creation and stored only as a hash.

---

## Verify

```bash
pnpm -r test        # core 291 · adapters 55 · api 887 · web 159   (1,392 tests)
pnpm -r typecheck
```

The adapter parity suite boots an isolated Hardhat node automatically and skips rather than
fails if one cannot start.

### End-to-end, against a real chain

`scripts/` holds 23 executable walkthroughs. They are HTTP-only against a running API, and
several carry **independent on-chain proof** — `eth_call` with the API out of the loop.

```bash
make besu-up                                    # real Besu
pnpm api:dev                                    # API on :4000
node scripts/full-platform-e2e.mjs              # identity ↔ tokenization arc
node scripts/corporate-e2e.mjs                  # KYB sign-up → DID on-chain → tokenize
node scripts/org-branding-e2e.mjs               # per-org logo + accent, tenant boundary
node scripts/onchain-registry-e2e.mjs           # DID + credential anchoring, verified by eth_call
```

Ten of these currently pass against live Besu — 181 individual checks, zero failures.

---

## Notes and limitations

- **SQLite** is used for zero-setup development; the Prisma datasource can point at Postgres.
- **Fabric and Canton** are faithful simulations here, not live networks.
- Auth is JWT and API keys; enterprise SSO (SAML/OIDC) is a later phase.
- The vendored Besu network, its keys and the seeded demo logins are **development-only** and
  must never be reused anywhere real.
- Deliberately deferred: production key management/HSM, KYC/AML provider integrations,
  cross-chain bridging, custody rails, and multi-tenant SaaS billing. The adapter seam,
  declarative use cases and capability envelopes are designed so these attach without rework.
