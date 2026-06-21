# TokenLayer — Multi-DLT, Multi-Standard, Low-Code Expansion

## Context

The Core Platform MVP shipped a chain-agnostic tokenization engine with config-driven use
cases, one in-memory mock chain, one EVM chain, and a single ERC-20-style compliance token.
This expansion delivers four user-requested capabilities by extending the existing seams:

1. **Multi-DLT** — Besu, Hyperledger Fabric, Canton, MST (public EVM); the use case selects
   which DLT(s) it can deploy to.
2. **Multi-standard** — ERC-20, ERC-721, ERC-3643; the use case selects the token standard.
3. **Low-code, configurable for any asset** — a visual Use-Case Builder; use cases become
   DB-backed and creatable without code.
4. **API-driven** — the platform already exposes everything over REST; new capabilities keep
   that property (use-case CRUD endpoints, NFT action routes).

Scope decisions (confirmed with user): Fabric/Canton are **simulated adapters behind the real
seam** (no Docker/Daml to run); ERC-3643 is a **simplified permissioned token** (not full
T-REX); low-code means a **visual builder** backed by a DB registry; the engine is
**generalized to support both fungible and non-fungible** standards.

## A. Multi-DLT

Chain families behind the existing `LedgerAdapter` interface:

- **EVM family** — one `EvmLedgerAdapter` instantiated per chain from config: `local-evm`,
  `besu`, `mst`. Real EVM; each enabled when its RPC URL is configured.
- **`FabricLedgerAdapter`, `CantonLedgerAdapter`** — full adapters over a shared in-memory
  `SimulatedLedger`. Always available. Tagged with `family` and distinct labels. Real
  SDK-backed versions drop in later behind the same interface.
- **`MockLedgerAdapter`** — reimplemented on the same `SimulatedLedger`.

`config/chains.json` declares every chain `{ id, label, family, kind }`. Each use case declares
`allowedChainIds` + `defaultChainId`; issuance restricts the chain picker to those.

## B. Multi-standard + engine generalization

Use case gains `tokenStandard: "ERC-20" | "ERC-721" | "ERC-3643"`, which determines `tokenType`
(`ERC-721` → non-fungible; others → fungible). Validation enforces consistency.

`LedgerAdapter` gains non-fungible operations alongside the fungible ones:

```ts
interface LedgerAdapter {
  readonly chainId: string;
  readonly family: ChainFamily;
  deployAsset(spec): Promise<DeployResult>;          // spec carries tokenStandard
  // fungible
  mint(ref, to, amount); transfer(ref, from, to, amount); burn(ref, from, amount);
  balanceOf(ref, account); totalSupply(ref);
  // non-fungible
  mintToken(ref, to, tokenId, uri?); transferToken(ref, from, to, tokenId); burnToken(ref, tokenId);
  ownerOf(ref, tokenId); tokensOf(ref, account);
  // compliance (shared)
  setFrozen; setAllowed; isFrozen; isAllowed;
}
```

The `LifecycleEngine` dispatches fungible vs non-fungible methods based on the use case's
`tokenType`, applying the same RBAC → lifecycle → compliance → audit pipeline to both.

**Contracts** (Hardhat, EVM chains):
- `ComplianceToken.sol` — ERC-20 (existing).
- `ComplianceNFT.sol` — ERC-721-style, operator-mediated mint(to,tokenId,uri)/transfer/burn +
  allowlist + freeze.
- `ComplianceToken3643.sol` — simplified ERC-3643: mandatory identity allowlist + transfer
  compliance + freeze + operator forced-transfer.

`EvmLedgerAdapter.deployAsset` selects the artifact by standard. The `SimulatedLedger` models
both fungible and NFT semantics so behaviour is identical across DLTs. The shared adapter
parity suite gains NFT and 3643 cases.

## C. Low-code Use-Case Builder

- New Prisma `UseCase` model (key, name, description, tokenStandard, tokenType, defaultChainId,
  allowedChainIds JSON, metadataSchema JSON, lifecycle JSON, compliance JSON, roles JSON).
  Seeded from the existing `config/use-cases/*.json` on startup (idempotent).
- Engine depends on a `UseCaseSource` interface `{ get, has, list }`; both the static
  `UseCaseRegistry` (core tests) and a DB-backed repository implement it.
- **API**: `GET /use-cases`, `GET /use-cases/:key`, `POST /use-cases`, `PUT /use-cases/:key`
  (create/edit Admin-only). Issuance validates `chainId ∈ allowedChainIds`.
- **Dashboard "Use-Case Builder"** (Admin): name/key, token standard, allowed chains, metadata
  field editor, lifecycle + compliance toggles, roles → creates an asset type with no code.
  Asset detail becomes NFT-aware (token list vs balances).

## Data model additions (Prisma)

- `UseCase` (above).
- `Asset` gains `tokenStandard`. NFT assets track token IDs via the ledger; the registry row is
  unchanged otherwise.

## Build order (TDD milestones — each green + runnable)

1. **Core** — `tokenStandard` + NFT ops in types/interface, `UseCaseSource`, engine NFT
   methods, validation. Unit tests.
2. **Simulated ledger** — shared `SimulatedLedger` (fungible+NFT); mock/fabric/canton adapters;
   extended parity suite.
3. **Contracts** — `ComplianceNFT` + `ComplianceToken3643` + Hardhat tests; EVM adapter deploys
   per standard + NFT ops; run parity against a local node.
4. **API** — DB-backed use cases + seed, multi-chain registry + `config/chains.json`, use-case
   CRUD, chain-restricted issuance, NFT action routes; integration tests.
5. **Dashboard** — Use-Case Builder page, chain/standard badges, NFT-aware detail, chain
   selector scoped to the use case.
6. **Demo + verification + README** — extend the E2E narrative across DLTs and standards.

## Verification

- `pnpm -r test` — core, adapter parity (mock/fabric/canton + EVM, fungible + NFT), Solidity,
  API integration.
- `pnpm -r typecheck`, `pnpm build`.
- `pnpm --filter @tokenlayer/api demo` — issue ERC-20 / ERC-721 / ERC-3643 across multiple DLTs,
  run lifecycle + compliance, confirm identical behaviour; create a use case via API.
- Dashboard walkthrough: build a new use case, issue an NFT, mint a token, transfer it.

## Out of scope

Real Fabric/Canton networks, full T-REX (ONCHAINID/compliance modules/trusted issuers), real
Besu/MST public deployments — all reachable behind the same seams later.
