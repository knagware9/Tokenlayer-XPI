# Platform Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full UI refresh, wizard use-case builder, per-ledger contract-code viewer, Networks configuration view, and the Besu QBFT network vendored in-repo.

**Architecture:** Web work rides on a new shared primitives layer (`ui.tsx`) so the reskin is consistent and cheap; two thin API additions (`contract-code.ts` renderer + chain status probe) feed the wizard's Review step and the Networks view; infra copies the existing 5-node network config (dev keys) into `infra/besu-network/` with an explicit `besu-network` docker network name.

**Tech Stack:** React + Tailwind (no new deps), Fastify + Vitest, docker compose.

**Spec:** `docs/superpowers/specs/2026-07-10-platform-polish-design.md`

---

## Tasks (batchable: T1 infra ∥ T2 api ∥ T3 web-foundation, then T4 web-features, then T5 verify)

### Task 1: vendor the Besu network in-repo (spec item 5)

**Files:** Create `infra/besu-network/` (copied genesis + node keys + README), `docker-compose.besu-nodes.yml`; Modify `Makefile` (`besu-up`/`besu-down` default in-repo, `BESU_PROJECT_DIR` override preserved), `docker-compose.besu.yml` (external network name → `besu-network`), README section.

- [ ] Copy `/Users/kamleshnagware/deposittokenization/besu-network/` → `infra/besu-network/` verbatim; add `infra/besu-network/README.md` stating the node keys are DEV-ONLY (never production).
- [ ] Extract the 5 `besu-node*` services from `/Users/kamleshnagware/deposittokenization/docker-compose.yml` into `docker-compose.besu-nodes.yml`, paths rewritten to `./infra/besu-network/...`, with:
  ```yaml
  networks:
    besu-network:
      name: besu-network
  ```
  and every node on that network. Keep ports/args/healthchecks identical.
- [ ] `docker-compose.besu.yml`: change the external network to `name: besu-network` (comment: created by `make besu-up` from the in-repo nodes, or by an external checkout that names it the same).
- [ ] `Makefile`: `besu-up` = `docker compose -f docker-compose.besu-nodes.yml up -d` (in-repo default); if `BESU_PROJECT_DIR` set, keep today's external invocation. `besu-down` mirrors.
- [ ] Verify: `make besu-up` → 5 nodes healthy, `curl localhost:8545 eth_blockNumber` advances; `docker network inspect besu-network` exists. Commit.

### Task 2: API — chain status + enrichment + contract code (spec items 3, 4)

**Files:** Create `apps/api/src/contract-code.ts`; Modify `apps/api/src/chains.ts` (ChainInfo + registry enrichment: `configured`, `expectedChainId`, `faucetUrl`, `rpcHost` hostname-only, and a `probe(chainId)` on the registry), `apps/api/src/http/routes.ts` + `schemas.ts`; Test: `apps/api/test/contract-code.test.ts`, `apps/api/test/chains-status.test.ts`.

- [ ] `chains.ts`: ChainInfo gains `configured: boolean; expectedChainId?: number; faucetUrl?: string; rpcHost?: string` (rpcHost = `new URL(rpcUrl).hostname` ONLY — never the URL; hosted RPCs embed keys). Registry gains `probe(chainId): Promise<{ id, reachable, mode, chainId?, operator?, balance?, error? }>` — EVM/real adapters call healthCheck (catch → reachable:false + error message), simulated → `{ reachable: true, mode: "simulated" }`, unknown id → throw (route 404s).
- [ ] `contract-code.ts`: `renderContractCode({ tokenStandard, symbol, name, allowlist, chainFamily, mode, deployed })` → `{ language, filename, source, constructorArgs }`. EVM: read the real `.sol` (`fileURLToPath(new URL("../../../packages/contracts/contracts/<X>.sol", import.meta.url))`; ComplianceToken=ERC-20, ComplianceNFT=ERC-721, ComplianceToken3643=ERC-3643); constructorArgs mirrored from `EvmLedgerAdapter.deployUseCaseContract` (read it). Fabric/Canton: a truthful model block (typescript/daml) noting simulated vs real. Confirm the api Docker image contains `packages/contracts/contracts` (it copies the workspace for artifacts; if `.sol` sources are excluded, add them in the api Dockerfile COPY).
- [ ] Routes: `GET /chains/:id/status` (auth read) → registry.probe; `GET /use-cases/:key/code?chainId=` (scoped read; chainId must be in allowedChainIds; merges `deployed` from useCase.contracts) ; `POST /use-cases/preview-code` (auth read; body `{ tokenStandard, symbol, name, compliance?, chainId }`) for the wizard pre-create. Schemas mirror house style.
- [ ] Tests: ERC-20/721/3643 sources contain the right `contract X` declaration + args include symbol; 404 unknown key / disallowed chain; preview-code works unauthenticated→401, authed→200; status: fabric (simulated) reachable, `mst` when unconfigured in tests → configured:false via /chains list. Suite target: 139 + ~6.
- [ ] Commit per house style.

### Task 3: web foundation — primitives + tokens + Login/Header (spec item 1)

**Files:** Create `apps/web/src/components/ui.tsx`; Modify `tailwind.config.*` (only if a token is missing), `apps/web/src/components/Login.tsx`, `Header.tsx`, `index.css` (type scale utilities if needed).

- [ ] `ui.tsx` exports (all styled, zero deps): `Card({title?, description?, actions?, children})`, `SectionHeader({title, description?, actions?})`, `Pill({tone: "ok"|"warn"|"danger"|"info"|"muted", children})`, `StatCard({label, value, sub?, icon?})`, `EmptyState({icon?, title, hint?, action?})`, `Skeleton({lines?})`, `Icon({name, className?})` with inline SVG set {chain, shield, doc, users, spark, check, warn, code, globe, coins, arrow}.
- [ ] Login: split layout — left panel (brand gradient, product name, 3 bullets: multi-DLT issuance / fail-closed compliance / tamper-evident audit), right card with the existing form logic untouched.
- [ ] Header: keep logic; refine spacing, active use-case chip, user block.
- [ ] `pnpm --filter @tokenlayer/web exec tsc --noEmit && build` clean. Commit.

### Task 4: web features — wizard, Networks, code viewer, reskin (spec items 1-4)

**Files:** Rewrite `apps/web/src/components/UseCaseBuilder.tsx` (wizard, same final POST payload); Create `NetworksPanel.tsx`, `ContractCodeView.tsx`; Modify `PlatformHome.tsx` (tabs: Overview · Use cases · Networks · Create), `api.ts`/`types.ts` (chainStatus, useCaseCode, previewCode + enriched ChainInfo), and reskin `Dashboard.tsx`, `AssetList.tsx`, `AssetDetail.tsx` (section cards), `UserManagement.tsx`, `InvestorPortal.tsx` on the primitives.

- [ ] Wizard per spec: 5 panes (Basics / Ledgers / Fields / Rules / Review) with a left progress rail, per-step validation, presets (invoice/bond/carbon/gold prefills), auto key-slug + symbol-suggest, chain cards with live status, Review = summary grid + ContractCodeView tabs (previewCode per selected chain) + Create.
- [ ] `NetworksPanel`: card per chain from enriched `/chains` + on-demand `/chains/:id/status` probe button (spinner → operator/balance/chainId or error), MST card shows chainId 91562037 + explorer/faucet links + masked rpcHost, absent chains show "not configured" + the env vars needed.
- [ ] `ContractCodeView({code})`: filename header, language pill, mono `<pre>` (`overflow-x-auto`), constructor-args list, Download button (`data:` URI), "simulated model" note when applicable. Used by wizard Review AND a "Code" action on each use-case card in PlatformHome (calls `/use-cases/:key/code`).
- [ ] Reskins: swap ad-hoc cards/tables/pills for primitives; add EmptyStates + Skeletons on loading paths; no logic changes.
- [ ] tsc + build clean. Commits: wizard; networks+code; reskin.

### Task 5: verify + live + merge

- [ ] Full suites (core 135, api ≥145, adapters 42, contracts 20) + web build.
- [ ] Live: `make besu-up` (in-repo) → `docker compose -f docker-compose.yml -f docker-compose.besu.yml build api web && down -v && up -d` (CHAIN_STRICT=1 passes against vendored nodes) → `node scripts/multi-dlt-e2e.mjs` (real bytecode on besu+mst) — proves item 5 end to end. (Watch host load: never run the build while the api container is booting — newosproc/EAGAIN.)
- [ ] Browser (5173 against the stack): screenshot Login, PlatformHome (Overview/Use cases/Networks incl. MST card + a live probe), full wizard run creating a use case (preset invoice, 2 chains) with the code preview visible, code viewer on an existing use case, Dashboard, AssetManagement, UserManagement, InvestorPortal.
- [ ] Merge `feat/platform-polish` → main; update memory.

## Self-review
Spec coverage: item 1 (T3+T4 reskins), 2 (T4 wizard), 3 (T2 endpoints + T4 viewer/Review), 4 (T2 enrichment/status + T4 NetworksPanel), 5 (T1 + T5 live proof). Placeholders: none — code-level detail lives in the implementer prompts; file-level contracts are pinned here (ui.tsx export signatures, endpoint shapes, network name). Type consistency: ChainInfo enrichment named identically in T2 (api) and T4 (web types); `probe` result shape matches `/chains/:id/status` route and NetworksPanel usage; previewCode body matches wizard call. ✅
