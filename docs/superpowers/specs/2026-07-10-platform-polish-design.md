# Platform Polish — UI Refresh, Wizard Builder, Contract Code, Networks, In-Repo Besu

**Date:** 2026-07-10
**Status:** Approved (user picked: full visual refresh; "show generated contract code" over bespoke codegen)

## Goals (user's 5 items)

1. **Make the UI great** — full visual refresh across all screens; structure/flows unchanged.
2. **Use-case configuration perfect and simple** — the builder becomes a guided 4-step wizard with
   strong defaults and minimal required input.
3. **Use-case definition generates code per selected ledger** — v1 = show the ACTUAL contract code
   that deploys per chain (EVM Solidity by token standard + constructor args; Fabric/Canton contract
   model with simulated/real note), in the builder review step and per use case; downloadable.
4. **MST Blockchain configuration visible** — a Networks view showing every chain's configuration
   (mode, chain id, masked RPC, explorer/faucet links) + a live status probe.
5. **Besu network copied from deposittokenization** — vendor the 5-node QBFT network (genesis, dev
   node keys, compose) into `infra/besu-network/` so TokenLayer is self-contained.

## Architecture

### Web (items 1, 2, 3-view, 4-view)

- **`apps/web/src/components/ui.tsx`** (new): Card, SectionHeader (title + description), Pill
  (status tones), DataTable (thead/tbody styling), EmptyState, Skeleton, Icon (small inline SVG set:
  chain, shield, doc, users, spark, check, warn, code, globe). Zero new dependencies.
- **Design tokens**: tailwind.config refinements only where needed (keep `brand` palette); global
  polish via the primitives, consistent `rounded-xl`/`shadow-sm`/`border-slate-200`, unified type
  scale (page title / section / body / caption).
- **Reskin** (no flow changes): Login (split panel: left brand pitch w/ 3 value bullets, right form),
  Header (chain-agnostic tagline, active use-case chip), PlatformHome (overview + use-case cards +
  Networks tab + wizard), Dashboard (stat cards w/ icons), AssetManagement/AssetList/AssetDetail,
  UserManagement, IntegrityPanel-style pills everywhere, InvestorPortal.
- **`UseCaseBuilder` → wizard** (same POST /use-cases payload at the end):
  - Step 1 Basics: Name (key auto-slugged, editable-advanced), Symbol (auto-suggest from name,
    uppercase ≤6), Description, Token standard (3 radio cards: ERC-20 fungible / ERC-721 NFT /
    ERC-3643 permissioned).
  - Step 2 Ledgers: chain CARDS (label, family icon, live mode badge from /chains + /chains/:id/status;
    "not connected — deploys when online" for absent), multi-select + default chain star.
  - Step 3 Asset fields: field rows (name, type incl. document/enum, required) + "Start from
    preset" (Invoice / Bond / Carbon / Gold templates prefill fields+rules) + live schema preview.
  - Step 4 Rules: lifecycle toggles (default all on), compliance (allowlist default ON,
    jurisdictions, max holders, lockup), fees (bps/flat), maker-checker approvals per gated op.
  - Review: full summary + per-selected-chain **Contract code** tabs (from the new API) +
    Create button. Progress rail with step validation; Back/Next; everything after step 1 has
    working defaults so "Next → Next → Next → Create" yields a valid use case.

### API (items 3, 4)

- **`GET /use-cases/:key/code?chainId=<id>`** (auth read; also works pre-create via
  `POST /use-cases/preview-code` with `{ tokenStandard, symbol, name, compliance, chainId }` for the
  wizard — same renderer, no persistence). Response:
  `{ chainId, family, language, filename, source, constructorArgs, mode: "real"|"simulated", deployed?: { contractRef, txHash } }`.
  - EVM: `language: "solidity"`; source = the real bundled `.sol` for the use case's standard
    (ComplianceToken / ComplianceNFT / ComplianceToken3643 — read from
    `packages/contracts/contracts/*.sol`, which ship in the api image alongside artifacts);
    `constructorArgs` = exactly what `EvmLedgerAdapter.deployUseCaseContract` passes (name, symbol,
    allowlist flag…, read the adapter to mirror).
  - Fabric: `language: "go"` if a real chaincode source dir exists in-repo, else the simulated
    contract model (`language: "typescript"`, source = the SimulatedAdapter contract semantics
    excerpt) with `mode: "simulated"`.
  - Canton: `language: "daml"` placeholder model when simulated (same pattern).
  - New `apps/api/src/contract-code.ts` module owns file resolution + arg rendering; routes stay thin.
- **`GET /chains/:id/status`**: on-demand probe → `{ id, reachable, mode, chainId?, operator?, balance?, error? }`
  (EVM healthCheck; real fabric/canton healthCheck; simulated → reachable true, mode simulated).
  **`GET /chains` enriched**: add `configured: boolean` (rpc+key env present for EVM), `expectedChainId?`,
  `faucetUrl?`, `rpcHost?` (hostname only, never the full URL — hosted RPC URLs can embed keys).

### Infra (item 5)

- Copy `deposittokenization/besu-network/` → `infra/besu-network/` (genesis.json, per-node keys —
  DEV ONLY, README noting that) and the 5 `besu-node*` service definitions into a new
  `docker-compose.besu-nodes.yml` (project-scoped, explicit `name: besu-network` docker network so
  the existing `docker-compose.besu.yml` overlay's `external: besu-network` reference resolves
  regardless of compose project name — overlay updated accordingly).
- `Makefile`: `besu-up`/`besu-down` default to the in-repo compose; `BESU_PROJECT_DIR` env still
  overrides to an external checkout. README section updated.

## Error handling

- `/use-cases/:key/code`: 404 unknown key/chain not allowed; unknown standard → 400.
- `/chains/:id/status`: never 500 on unreachable — `{ reachable: false, error }` with 200.
- Wizard: per-step inline validation (duplicate key, bad symbol, no chain selected); server errors
  surface verbatim on Review.

## Testing

- API tests: code endpoint (per standard source + args, 404s, preview-code), chains status
  (simulated reachable; absent EVM → configured:false), enriched /chains fields; suites stay green.
- Web: tsc + build; browser pass with screenshots of EVERY reskinned screen + the wizard end-to-end
  (create a use case through it) + Networks tab showing MST config + code viewer rendering Solidity.
- Live: `make besu-up` from the vendored network → overlay stack boots (CHAIN_STRICT=1) → deploy a
  use case on besu → on-chain bytecode check (reuse scripts/multi-dlt-e2e.mjs).

## Out of scope

Bespoke per-use-case Solidity codegen/compilation · editing existing use cases in the wizard
(create-only; PUT stays API-level) · dark mode · mobile-first layouts (responsive-reasonable only).
