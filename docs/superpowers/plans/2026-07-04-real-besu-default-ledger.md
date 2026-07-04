# Real Besu Default Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real Besu QBFT network the default ledger — remove the silent mock fallback for EVM chains, add a required-chain boot connectivity check, flip the deploy pipeline to the Besu path, and badge simulated chains in the UI.

**Architecture:** The `LedgerAdapter` seam and real `EvmLedgerAdapter` (ethers v6) already exist. The change is confined to: `apps/api/src/chains.ts` (registry semantics: EVM chains are real or absent, never mocked; `required` chains abort boot when unconfigured/unreachable), `packages/adapters/src/evm-adapter.ts` (a `healthCheck()` probe), the chains API schema + web badges (`mode: "real" | "simulated"`), and the deploy scripts/compose files (Besu becomes the default; `--sim` is the opt-out that boots with `CHAIN_STRICT=0`).

**Tech Stack:** TypeScript (ESM), pnpm monorepo, Fastify, Vitest, ethers v6, React/Vite, Docker Compose, bash.

**Spec:** `docs/superpowers/specs/2026-07-04-real-besu-default-ledger-design.md`

**Key existing facts (verified):**
- `config/chains.json`: `besu` and `mst` carry `simulatedFallback: true` today; all 5 seeded use cases already have `defaultChainId: "besu"`.
- `buildChainRegistry(env)` in `apps/api/src/chains.ts` substitutes `new MockLedgerAdapter(d.id)` when an EVM chain's env is unset and `simulatedFallback` is true (lines 76–80).
- `EvmLedgerAdapter` (packages/adapters/src/evm-adapter.ts:68) has `private readonly provider: JsonRpcProvider` and `this.wallet = new Wallet(...)` (line 87).
- API tests build the registry with `buildChainRegistry({})` (apps/api/test/helpers.ts:20) and issue assets with `chainId: "besu"` throughout — today that silently hits the mock; after this change those tests must use `"fabric"` (same `SimulatedLedger` engine, identical behavior).
- `GET /chains` (apps/api/src/http/routes.ts:81) returns `ChainInfo[]`; the `Chain` JSON schema lives at apps/api/src/http/schemas.ts:36 with `additionalProperties: true`.
- Web: `ChainInfo` in `apps/web/src/types.ts:14`; `ChainPill` in `apps/web/src/components/AssetDetail.tsx:427`; chain dropdown in `apps/web/src/components/IssuePanel.tsx:124`.
- `scripts/deploy.sh` defaults `MODE="simulated"`; `scripts/verify.sh` always issues on `"besu"` (line 41); Makefile `deploy` = simulated path.
- Contract artifacts must exist for `EvmLedgerAdapter` construction: if `packages/contracts/artifacts/` is missing, run `pnpm --filter @tokenlayer/contracts build` first.

---

### Task 1: Registry — EVM chains are real or absent, `required` + `CHAIN_STRICT`, `mode` field

**Files:**
- Modify: `config/chains.json`
- Modify: `apps/api/src/chains.ts`
- Create: `apps/api/test/chains.test.ts`

- [ ] **Step 1: Update `config/chains.json`** — besu becomes `required`, no EVM chain has `simulatedFallback`:

```json
[
  { "id": "besu", "label": "Hyperledger Besu", "family": "evm", "kind": "evm", "rpcEnv": "BESU_RPC_URL", "keyEnv": "BESU_OPERATOR_KEY", "gas": "auto", "confirmations": 1, "required": true },
  { "id": "mst", "label": "MST Blockchain", "family": "evm", "kind": "evm", "rpcEnv": "MST_RPC_URL", "keyEnv": "MST_OPERATOR_KEY", "gas": "auto", "confirmations": 2 },
  { "id": "fabric", "label": "Hyperledger Fabric (simulated)", "family": "fabric", "kind": "simulated" },
  { "id": "canton", "label": "Canton Network (simulated)", "family": "canton", "kind": "simulated" },
  { "id": "local-evm", "label": "Local EVM (Hardhat)", "family": "evm", "kind": "evm", "rpcEnv": "EVM_RPC_URL", "keyEnv": "EVM_OPERATOR_KEY", "gas": "auto", "confirmations": 1 }
]
```

- [ ] **Step 2: Write the failing tests** — create `apps/api/test/chains.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildChainRegistry } from "../src/chains.js";

// A dev-only throwaway key (hardhat account #1) — never used on a live network here.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("chain registry", () => {
  it("throws at build time when a required chain (besu) has no env and CHAIN_STRICT is on", () => {
    expect(() => buildChainRegistry({})).toThrow(/besu.*required.*BESU_RPC_URL/s);
  });

  it("omits (never simulates) a required chain when CHAIN_STRICT=0", () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    const ids = reg.list().map((c) => c.id);
    expect(ids).not.toContain("besu");
    expect(() => reg.resolveAdapter("besu")).toThrow(/not configured/);
  });

  it("omits optional EVM chains (mst, local-evm) when their env is unset", () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    const ids = reg.list().map((c) => c.id);
    expect(ids).not.toContain("mst");
    expect(ids).not.toContain("local-evm");
  });

  it("keeps simulated chains available and labels their mode", () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    const fabric = reg.list().find((c) => c.id === "fabric");
    const canton = reg.list().find((c) => c.id === "canton");
    expect(fabric?.mode).toBe("simulated");
    expect(canton?.mode).toBe("simulated");
  });

  it("registers a configured EVM chain as mode 'real' (no mock path exists)", () => {
    const reg = buildChainRegistry({ BESU_RPC_URL: "http://127.0.0.1:59999", BESU_OPERATOR_KEY: KEY });
    const besu = reg.list().find((c) => c.id === "besu");
    expect(besu?.kind).toBe("evm");
    expect(besu?.mode).toBe("real");
  });

  it("assertConnectivity rejects with an actionable error when a configured EVM chain is unreachable", async () => {
    const reg = buildChainRegistry({ BESU_RPC_URL: "http://127.0.0.1:59999", BESU_OPERATOR_KEY: KEY });
    await expect(reg.assertConnectivity()).rejects.toThrow(/besu.*unreachable/s);
  });

  it("assertConnectivity resolves when no EVM chain is configured", async () => {
    const reg = buildChainRegistry({ CHAIN_STRICT: "0" });
    await expect(reg.assertConnectivity()).resolves.toBeUndefined();
  });
});
```

Note: `assertConnectivity` is implemented in Task 2 — in this task, stub it (see Step 4) so the two connectivity tests fail for the right reason, or add the test file in full now and accept the two connectivity tests failing until Task 2. Either way, run only this file and confirm the non-connectivity tests fail with "buildChainRegistry did not throw" / "mode undefined" style errors first.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @tokenlayer/api test -- test/chains.test.ts`
Expected: FAIL — `buildChainRegistry({})` does not throw (mock fallback still active), `mode` is `undefined`, `assertConnectivity` is not a function.

- [ ] **Step 4: Rewrite `apps/api/src/chains.ts`** — full replacement of the descriptor type, `ChainInfo`, `ChainRegistry`, the EVM branch, and `makeSimulatedOrReal`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CantonJsonApiAdapter,
  CantonLedgerAdapter,
  EvmLedgerAdapter,
  FabricGatewayAdapter,
  FabricLedgerAdapter,
  loadArtifact,
} from "@tokenlayer/adapters";
import type { ChainFamily, LedgerAdapter, TokenStandard } from "@tokenlayer/core";

const CHAINS_FILE = fileURLToPath(new URL("../../../config/chains.json", import.meta.url));

interface ChainDescriptor {
  id: string;
  label: string;
  family: ChainFamily;
  kind: "simulated" | "evm";
  rpcEnv?: string;
  keyEnv?: string;
  gas?: "auto" | "zero";
  confirmations?: number;
  /** EVM chains: the API refuses to start unless this chain is configured and reachable (CHAIN_STRICT=0 skips, leaving the chain absent). */
  required?: boolean;
}

export interface ChainInfo {
  id: string;
  label: string;
  family: ChainFamily;
  kind: "simulated" | "evm";
  /** "real" = live backend (EVM RPC / Fabric gateway / Canton JSON API); "simulated" = in-memory ledger. */
  mode: "real" | "simulated";
}

export interface ChainRegistry {
  resolveAdapter(chainId: string): LedgerAdapter;
  list(): ChainInfo[];
  /** Boot check: every configured EVM chain must answer eth_chainId, or this rejects. */
  assertConnectivity(): Promise<void>;
}

type Env = Record<string, string | undefined>;

function evmArtifacts(): Record<TokenStandard, ReturnType<typeof loadArtifact>> {
  return {
    "ERC-20": loadArtifact("ComplianceToken"),
    "ERC-721": loadArtifact("ComplianceNFT"),
    "ERC-3643": loadArtifact("ComplianceToken3643"),
  };
}

/**
 * Assembles every available ledger from config/chains.json. EVM chains are REAL
 * or ABSENT — there is no mock fallback. A `required` EVM chain (besu) aborts
 * startup when unconfigured, unless CHAIN_STRICT=0 (then it is absent, with a
 * loud warning — never simulated). Fabric/Canton run simulated until their
 * connection env upgrades them to real backends.
 */
export function buildChainRegistry(env: Env = process.env): ChainRegistry {
  const strict = env.CHAIN_STRICT !== "0";
  const descriptors = JSON.parse(readFileSync(CHAINS_FILE, "utf8")) as ChainDescriptor[];
  const adapters = new Map<string, LedgerAdapter>();
  const infos: ChainInfo[] = [];
  const evmChains: { descriptor: ChainDescriptor; adapter: EvmLedgerAdapter; rpcUrl: string }[] = [];
  let artifacts: Record<TokenStandard, ReturnType<typeof loadArtifact>> | null = null;

  for (const d of descriptors) {
    if (d.kind === "simulated") {
      const { adapter, real } = makeSimulatedOrReal(d.id, d.family, env);
      adapters.set(d.id, adapter);
      infos.push({ id: d.id, label: d.label, family: d.family, kind: "simulated", mode: real ? "real" : "simulated" });
      continue;
    }
    // EVM chain — real when its RPC + operator key are configured, otherwise absent.
    const rpcUrl = d.rpcEnv ? env[d.rpcEnv] : undefined;
    const privateKey = (d.keyEnv ? env[d.keyEnv] : undefined) ?? env.EVM_OPERATOR_KEY;
    if (rpcUrl && privateKey) {
      artifacts ??= evmArtifacts();
      const adapter = new EvmLedgerAdapter({ chainId: d.id, rpcUrl, privateKey, artifacts, gas: d.gas, confirmations: d.confirmations });
      adapters.set(d.id, adapter);
      infos.push({ id: d.id, label: d.label, family: d.family, kind: "evm", mode: "real" });
      evmChains.push({ descriptor: d, adapter, rpcUrl });
    } else if (d.required && strict) {
      throw new Error(
        `chain '${d.id}' is required but not configured: set ${d.rpcEnv} and ${d.keyEnv}. ` +
          `Run \`make deploy\` to start the Besu network, or set CHAIN_STRICT=0 to boot without it ` +
          `(the chain will be absent — never simulated).`,
      );
    } else if (d.required) {
      console.warn(`[chains] CHAIN_STRICT=0 — required chain '${d.id}' is NOT configured; it will be absent (not simulated).`);
    }
    // optional EVM chain without env (e.g. local-evm): omitted from the registry.
  }

  return {
    resolveAdapter(chainId: string): LedgerAdapter {
      const adapter = adapters.get(chainId);
      if (!adapter) throw new Error(`chain '${chainId}' is not configured`);
      return adapter;
    },
    list: () => infos,
    async assertConnectivity(): Promise<void> {
      for (const { descriptor: d, adapter, rpcUrl } of evmChains) {
        try {
          const h = await adapter.healthCheck();
          console.log(`[chains] '${d.id}' connected: chainId=${h.chainId} operator=${h.operator} balance=${h.balance} ETH`);
        } catch (err) {
          throw new Error(
            `chain '${d.id}' is configured (${d.rpcEnv}=${rpcUrl}) but unreachable: ${(err as Error).message}. ` +
              `Start the network (\`make deploy\`) or fix ${d.rpcEnv}.`,
          );
        }
      }
    },
  };
}

/**
 * Fabric/Canton: the real DLT adapter when its connection env is configured,
 * otherwise the in-memory simulated one (these chains are explicitly labeled
 * simulated in the UI via `mode`).
 */
function makeSimulatedOrReal(id: string, family: ChainFamily, env: Env): { adapter: LedgerAdapter; real: boolean } {
  if (family === "fabric") {
    if (env.FABRIC_CONNECTION_PROFILE) {
      return {
        real: true,
        adapter: new FabricGatewayAdapter({
          chainId: id,
          connectionProfile: env.FABRIC_CONNECTION_PROFILE,
          walletPath: env.FABRIC_WALLET ?? "./wallet",
          identity: env.FABRIC_IDENTITY ?? "appUser",
          channel: env.FABRIC_CHANNEL,
          chaincode: env.FABRIC_CHAINCODE,
        }),
      };
    }
    return { adapter: new FabricLedgerAdapter(id), real: false };
  }
  if (family === "canton") {
    if (env.CANTON_LEDGER_URL && env.CANTON_TOKEN && env.CANTON_OPERATOR_PARTY && env.CANTON_TEMPLATE_ID) {
      return {
        real: true,
        adapter: new CantonJsonApiAdapter({
          chainId: id,
          jsonApiUrl: env.CANTON_LEDGER_URL,
          token: env.CANTON_TOKEN,
          operatorParty: env.CANTON_OPERATOR_PARTY,
          templateId: env.CANTON_TEMPLATE_ID,
        }),
      };
    }
    return { adapter: new CantonLedgerAdapter(id), real: false };
  }
  throw new Error(`simulated chain '${id}' has unsupported family '${family}'`);
}
```

Note: `MockLedgerAdapter` is no longer imported — the mock now exists only for unit tests inside `packages/adapters`. The final `throw` in `makeSimulatedOrReal` replaces the old `return new MockLedgerAdapter(id)` catch-all: chains.json has no `kind: "simulated"` entry with another family, so this is unreachable-by-config and honest if someone adds one.

`adapter.healthCheck()` does not exist yet — Task 2 adds it. TypeScript will fail typecheck until Task 2; do Tasks 1+2 as one commit if running typecheck between them bothers you, but keep the test-first ordering within each.

- [ ] **Step 5: Run the non-connectivity tests**

Run: `pnpm --filter @tokenlayer/api test -- test/chains.test.ts`
Expected: the 5 non-connectivity tests PASS; the 2 `assertConnectivity` tests fail on the missing `healthCheck` (fixed in Task 2). Do not commit yet.

---

### Task 2: `EvmLedgerAdapter.healthCheck()` + boot check in server

**Files:**
- Modify: `packages/adapters/src/evm-adapter.ts`
- Modify: `apps/api/src/server.ts:20`
- Test: `apps/api/test/chains.test.ts` (from Task 1)

- [ ] **Step 1: Add `healthCheck()` to `EvmLedgerAdapter`** — in `packages/adapters/src/evm-adapter.ts`, add `formatEther` to the existing `ethers` import, then add this method inside the class (right after the constructor):

```ts
/** Boot-time probe: verifies the RPC answers and reports the operator account. */
async healthCheck(): Promise<{ chainId: string; operator: string; balance: string }> {
  const network = await this.provider.getNetwork();
  const balance = await this.provider.getBalance(this.wallet.address);
  return { chainId: network.chainId.toString(), operator: this.wallet.address, balance: formatEther(balance) };
}
```

- [ ] **Step 2: Run the full chains test file to verify it passes**

Run: `pnpm --filter @tokenlayer/api test -- test/chains.test.ts`
Expected: all 7 tests PASS (the unreachable-RPC test may take a few seconds while ethers retries the refused connection).

- [ ] **Step 3: Wire the boot check into `apps/api/src/server.ts`** — after line 20 (`const chains = buildChainRegistry();`):

```ts
const chains = buildChainRegistry();
await chains.assertConnectivity(); // fail fast: configured EVM chains must be reachable
```

- [ ] **Step 4: Typecheck**

Run: `pnpm -r typecheck`
Expected: PASS (adapters + api compile; `healthCheck` resolves).

- [ ] **Step 5: Commit**

```bash
git add config/chains.json apps/api/src/chains.ts apps/api/test/chains.test.ts packages/adapters/src/evm-adapter.ts apps/api/src/server.ts
git commit -m "feat(chains): EVM chains are real or absent — required besu + boot connectivity check, no mock fallback"
```

---

### Task 3: Update existing API tests (besu → fabric) and demo/e2e scripts

The API test suite issued assets on `"besu"`, which silently resolved to the mock. Besu is now absent in tests; `"fabric"` is the drop-in replacement (same `SimulatedLedger` engine, identical compliance behavior).

**Files:**
- Modify: `apps/api/test/helpers.ts:20,54`
- Modify: `apps/api/test/api.test.ts` (all `chainId: "besu"` call sites + the chain-list expectation at line 67)
- Modify: `apps/api/test/asset-sale-terms.test.ts:5`
- Modify: `apps/api/src/demo.ts:29`, `apps/api/src/e2e-carbon.ts:50`, `apps/api/src/e2e-usecases.ts:49`, `apps/api/src/e2e-buy.ts:45`, `apps/api/src/e2e-tenancy.ts:16`

- [ ] **Step 1: helpers.ts** — build the registry non-strict and issue on fabric:

Line 20: `const chains = buildChainRegistry({}); // simulated chains only — no EVM env`
→ `const chains = buildChainRegistry({ CHAIN_STRICT: "0" }); // simulated chains only — besu absent, never mocked`

Line 54: `chainId: "besu"` → `chainId: "fabric"`

- [ ] **Step 2: api.test.ts** — replace every `chainId: "besu"` with `chainId: "fabric"` (issuance/action payloads only — leave use-case definition fields `allowedChainIds: ["besu"]` / `defaultChainId: "besu"` untouched; they are pure data and some tests assert chain-not-allowed errors against them). Then fix the chain-list expectation at line 67:

```ts
expect(ids).toEqual(expect.arrayContaining(["fabric", "canton"]));
expect(ids).not.toContain("besu"); // EVM chains are never simulated
```

Watch for one trap: the `besu-only-asset` test (line ~220) issues on `"canton"` against `allowedChainIds: ["besu"]` and expects a CHAIN_NOT_ALLOWED-style rejection — the engine checks `allowedChainIds` before resolving the adapter, so it still passes unchanged.

- [ ] **Step 3: asset-sale-terms.test.ts** — line 5 fixture: `chainId: "besu"` → `chainId: "fabric"`.

- [ ] **Step 4: demo/e2e scripts stay runnable without besu** — in each of `demo.ts`, `e2e-carbon.ts`, `e2e-usecases.ts`, `e2e-buy.ts`, `e2e-tenancy.ts`, change the registry construction to default non-strict (a developer running a demo without the network gets available chains, not a crash — and still gets real besu when env is set):

```ts
const chains = buildChainRegistry({ ...process.env, CHAIN_STRICT: process.env.CHAIN_STRICT ?? "0" });
```

- [ ] **Step 5: Run the API suite**

Run: `pnpm --filter @tokenlayer/api test`
Expected: all tests PASS (previously ~15 + 7 new = ~22). If a test fails on `chain 'besu' is not configured`, a `chainId: "besu"` call site was missed — grep: `grep -n 'chainId: "besu"' apps/api/test/*.ts` should only match inside use-case definition payloads, not issuance payloads.

- [ ] **Step 6: Full workspace check**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: core 31, contracts 20, adapters 42 unchanged; api green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/test apps/api/src/demo.ts apps/api/src/e2e-carbon.ts apps/api/src/e2e-usecases.ts apps/api/src/e2e-buy.ts apps/api/src/e2e-tenancy.ts
git commit -m "test(api): issue on simulated fabric now that besu is never mocked; demos boot non-strict"
```

---

### Task 4: Surface `mode` through the API schema and badge it in the web UI

**Files:**
- Modify: `apps/api/src/http/schemas.ts:36` (the `Chain` schema)
- Modify: `apps/web/src/types.ts:14`
- Modify: `apps/web/src/components/AssetDetail.tsx:427` (`ChainPill`)
- Modify: `apps/web/src/components/IssuePanel.tsx:124` (chain dropdown)

- [ ] **Step 1: API schema** — in the `Chain` schema object (apps/api/src/http/schemas.ts:36), add `mode` to `properties` and `required`:

```ts
{
  $id: "Chain",
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    family: { type: "string", enum: ["evm", "fabric", "canton", "mock"] },
    kind: { type: "string", enum: ["simulated", "evm"] },
    mode: { type: "string", enum: ["real", "simulated"] },
  },
  required: ["id", "label", "family", "kind", "mode"],
},
```

- [ ] **Step 2: Web type** — in `apps/web/src/types.ts`:

```ts
export interface ChainInfo {
  id: string;
  label: string;
  family: ChainFamily;
  kind: "simulated" | "evm";
  mode: "real" | "simulated";
}
```

- [ ] **Step 3: `ChainPill` badges the mode** — replace the function in `apps/web/src/components/AssetDetail.tsx:427`:

```tsx
function ChainPill({ chain }: { chain?: ChainInfo }): JSX.Element {
  const real = chain?.mode === "real";
  const tone = real ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600";
  return (
    <span className={`px-1.5 py-0.5 rounded font-medium ${tone}`}>
      {chain?.label ?? "unknown chain"}
      <span className="ml-1 opacity-70">{real ? "· on-chain" : "· simulated"}</span>
    </span>
  );
}
```

- [ ] **Step 4: IssuePanel dropdown labels simulated chains** — in the `<select>` at `apps/web/src/components/IssuePanel.tsx:124`, where the options render the chain label, append a suffix for simulated chains that don't already say so in their label:

```tsx
{availableChains.map((c) => (
  <option key={c.id} value={c.id}>
    {c.label}{c.mode === "simulated" && !/simulat/i.test(c.label) ? " — simulated" : ""}
  </option>
))}
```

(Adapt to the exact existing option-rendering code in that file — only the suffix logic is new. The variable holding filtered chains is the `useMemo` at line ~40; keep its name.)

- [ ] **Step 5: Typecheck + build web**

Run: `pnpm -r typecheck && pnpm --filter @tokenlayer/web build`
Expected: PASS.

- [ ] **Step 6: Run API tests (schema change is load-bearing for `GET /chains`)**

Run: `pnpm --filter @tokenlayer/api test`
Expected: PASS — the registry now emits `mode`, satisfying the schema's `required`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http/schemas.ts apps/web/src/types.ts apps/web/src/components/AssetDetail.tsx apps/web/src/components/IssuePanel.tsx
git commit -m "feat(web+api): expose chain mode (real/simulated) and badge it in the dashboard"
```

---

### Task 5: Deploy pipeline flip — Besu is the default path

**Files:**
- Modify: `scripts/deploy.sh`
- Modify: `scripts/verify.sh`
- Modify: `Makefile`
- Modify: `docker-compose.yml` (api `environment`)
- Modify: `docker-compose.besu.yml` (api `environment`)

- [ ] **Step 1: `scripts/deploy.sh`** — Besu becomes the default; `--sim` opts out; the smoke test runs automatically:

Header comment (lines 4–7) becomes:

```bash
#   ./scripts/deploy.sh            # REAL Besu (default): starts the 5-node QBFT
#                                   # network and deploys on-chain
#   ./scripts/deploy.sh --sim      # simulated ledgers only (no external chain)
```

Line 19: `MODE="simulated"` → `MODE="besu"`

In the args loop (lines 28–37), keep `--besu` (now a no-op alias) and add:

```bash
    --besu) MODE="besu" ;;
    --sim)  MODE="simulated" ;;
```

After the web health check (after line 103), add the automatic smoke test:

```bash
# --- 5. smoke test ------------------------------------------------------------
log "Running the smoke test…"
if [[ "$MODE" == "besu" ]]; then
  ./scripts/verify.sh --besu
else
  ./scripts/verify.sh
fi
```

(The old summary block becomes section 6; drop the trailing "Smoke test:" hint line from the heredoc since it now runs automatically.)

- [ ] **Step 2: `scripts/verify.sh`** — issue on `fabric` in sim mode, `besu` with `--besu` (besu no longer exists in the sim stack):

Lines 12–14 become:

```bash
API="http://localhost:${API_PORT:-4000}/api/v1"
EXPECT_ONCHAIN="no"; CHAIN="fabric"
[[ "${1:-}" == "--besu" ]] && { EXPECT_ONCHAIN="yes"; CHAIN="besu"; }
```

Pass the chain into python (line 16): `python3 - "$API" "$EXPECT_ONCHAIN" "$CHAIN" <<'PY'` and read it: `API, EXPECT, CHAIN = sys.argv[1], sys.argv[2], sys.argv[3]`. Replace the hardcoded `"chainId":"besu"` (line ~41) with `"chainId":CHAIN` and the check label `"issue on besu with auto-mint (201)"` with `f"issue on {CHAIN} with auto-mint (201)"`. Update the header comment to match.

- [ ] **Step 3: `Makefile`** — flip defaults, add sim targets:

```make
deploy: ## Deploy on the REAL 5-node Besu QBFT network (default)
	./scripts/deploy.sh

deploy-besu: ## Alias of deploy
	./scripts/deploy.sh

deploy-sim: ## Deploy on simulated ledgers only (no external chain)
	./scripts/deploy.sh --sim

verify: ## Smoke test: issue + buy, assert real on-chain contract
	./scripts/verify.sh --besu

verify-sim: ## Smoke test against the simulated stack
	./scripts/verify.sh
```

(Replace the existing `deploy`/`deploy-besu`/`verify`/`verify-besu` targets; update `.PHONY` accordingly: remove `verify-besu`, add `deploy-sim verify-sim`.)

- [ ] **Step 4: Compose env** — the base stack (sim) boots non-strict; the Besu overlay restores strict:

`docker-compose.yml`, api `environment` block (after line 18), add:

```yaml
      # Simulated-only stack: boot without the required besu chain (absent, never mocked).
      CHAIN_STRICT: "0"
```

`docker-compose.besu.yml`, api `environment` block, add:

```yaml
      # Real-chain deploy: refuse to start unless besu is configured AND reachable.
      CHAIN_STRICT: "1"
```

- [ ] **Step 5: Shell-check the scripts**

Run: `bash -n scripts/deploy.sh && bash -n scripts/verify.sh && make -n deploy >/dev/null && make -n deploy-sim >/dev/null`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy.sh scripts/verify.sh Makefile docker-compose.yml docker-compose.besu.yml
git commit -m "feat(deploy): real Besu is the default deploy path; --sim opts out; smoke test runs automatically"
```

---

### Task 6: Docs — DEPLOY.md, README, .env examples

**Files:**
- Modify: `DEPLOY.md`
- Modify: `README.md` (the chains/quick-start mentions)
- Modify: `.env.example` (root)
- Modify: `apps/api/.env.example`

- [ ] **Step 1: `DEPLOY.md`** — rewrite the one-command block and defaults to lead with the real chain:

```markdown
## One-command deploy (automated)

​```bash
make deploy         # REAL Besu (default): starts the 5-node QBFT network, deploys on-chain, runs the smoke test
make deploy-sim     # simulated ledgers only (no external chain)
make verify         # re-run the on-chain smoke test
make help           # list all targets (status, logs, down, rebuild, …)
​```
```

Update the "Run on the real 5-node Hyperledger Besu" section: it is now the default (`make deploy`); the overlay explanation stays. Replace the sentence "By default every chain (incl. `besu`) uses the in-memory simulated ledger" with the new truth: "The `besu` chain is **required and always real** — the API refuses to start if it can't reach the RPC. The simulated-only stack (`make deploy-sim`) boots with `CHAIN_STRICT=0`, which leaves besu *absent* (never silently simulated); fabric/canton remain available as clearly-labeled simulated chains." Add `CHAIN_STRICT` to the configuration table:

```markdown
| `CHAIN_STRICT` | `1` | `0` boots the API without required chains (they become absent — never simulated). Set by `deploy-sim`. |
```

- [ ] **Step 2: root `.env.example`** — append:

```bash
# Real Besu chain (set automatically by the docker-compose.besu.yml overlay):
# BESU_RPC_URL=http://besu-node1:8545
# BESU_OPERATOR_KEY=0x…
# Boot without required chains (simulated-only demos): CHAIN_STRICT=0
```

- [ ] **Step 3: `apps/api/.env.example`** — add a local-dev block (check the file's existing content first and match its comment style):

```bash
# Local dev against the real Besu QBFT network (host-mapped RPC).
# Start it first:  make deploy   (or: cd /Users/kamleshnagware/deposittokenization && docker compose up -d besu-node1 …node5)
BESU_RPC_URL=http://localhost:8545
BESU_OPERATOR_KEY=0x8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63
# …or boot without besu (chain absent, never simulated):
# CHAIN_STRICT=0
```

- [ ] **Step 4: `README.md`** — in the chains/architecture overview, state that besu is the required real chain by default, fabric/canton are labeled simulated, and `make deploy` runs the real network end-to-end. Keep it to a few lines matching the existing tone.

- [ ] **Step 5: Commit**

```bash
git add DEPLOY.md README.md .env.example apps/api/.env.example
git commit -m "docs: real Besu is the default deploy; document CHAIN_STRICT and local-dev env"
```

---

### Task 7: Full verification — suites, typecheck, and the real on-chain deploy

- [ ] **Step 1: Workspace green**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all packages pass (core 31, contracts 20, adapters 42, api ~22).

- [ ] **Step 2: Sim stack still boots** (requires Docker):

Run: `make deploy-sim`
Expected: deploy script completes; the API log shows the `CHAIN_STRICT=0` warning about besu being absent; smoke test passes issuing on `fabric`. Then `make down`.

- [ ] **Step 3: The real thing** (requires Docker + the deposittokenization repo):

Run: `make deploy`
Expected: the 5-node QBFT network starts (≥4 validators), the stack builds, the API boot log shows `[chains] 'besu' connected: chainId=1337 operator=0xfe3b… balance=…`, and the smoke test passes with a real contract address in `contractRef` (the `--besu` verify asserts on-chain bytecode).

- [ ] **Step 4: Negative proof — hard fail is real**: stop the Besu network (`make besu-down`) and restart just the api container (`docker compose -f docker-compose.yml -f docker-compose.besu.yml restart api`); `docker compose logs api` must show the actionable "configured … but unreachable" error and the container exiting — not a silent mock. Bring it back with `make deploy`.

- [ ] **Step 5: Final commit if anything moved, then request review**

Use the superpowers:requesting-code-review skill against the spec.
