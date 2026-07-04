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
