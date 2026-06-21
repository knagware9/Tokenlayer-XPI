import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CantonJsonApiAdapter,
  CantonLedgerAdapter,
  EvmLedgerAdapter,
  FabricGatewayAdapter,
  FabricLedgerAdapter,
  MockLedgerAdapter,
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
  /** EVM chains: run on the in-memory simulated ledger until their RPC is configured. */
  simulatedFallback?: boolean;
}

export interface ChainInfo {
  id: string;
  label: string;
  family: ChainFamily;
  kind: "simulated" | "evm";
}

export interface ChainRegistry {
  resolveAdapter(chainId: string): LedgerAdapter;
  list(): ChainInfo[];
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
 * Assembles every available ledger from config/chains.json. Fabric, Canton, and
 * any EVM chain flagged `simulatedFallback` (Besu, MST) are always present,
 * running on the in-memory simulated ledger and upgrading to their real backend
 * once the connection env is set. Each use case chooses which it may deploy to.
 */
export function buildChainRegistry(env: Env = process.env): ChainRegistry {
  const descriptors = JSON.parse(readFileSync(CHAINS_FILE, "utf8")) as ChainDescriptor[];
  const adapters = new Map<string, LedgerAdapter>();
  const infos: ChainInfo[] = [];
  let artifacts: Record<TokenStandard, ReturnType<typeof loadArtifact>> | null = null;

  for (const d of descriptors) {
    if (d.kind === "simulated") {
      adapters.set(d.id, makeSimulatedOrReal(d.id, d.family, env));
      infos.push({ id: d.id, label: d.label, family: d.family, kind: "simulated" });
      continue;
    }
    // EVM chain — real when its RPC + operator key are configured...
    const rpcUrl = d.rpcEnv ? env[d.rpcEnv] : undefined;
    const privateKey = (d.keyEnv ? env[d.keyEnv] : undefined) ?? env.EVM_OPERATOR_KEY;
    if (rpcUrl && privateKey) {
      artifacts ??= evmArtifacts();
      adapters.set(d.id, new EvmLedgerAdapter({ chainId: d.id, rpcUrl, privateKey, artifacts, gas: d.gas, confirmations: d.confirmations }));
      infos.push({ id: d.id, label: d.label, family: d.family, kind: "evm" });
    } else if (d.simulatedFallback) {
      // ...otherwise run on the simulated ledger so the chain is always usable.
      adapters.set(d.id, new MockLedgerAdapter(d.id));
      infos.push({ id: d.id, label: d.label, family: d.family, kind: "simulated" });
    }
    // else (e.g. local-evm with no RPC): not configured, omitted from the registry.
  }

  return {
    resolveAdapter(chainId: string): LedgerAdapter {
      const adapter = adapters.get(chainId);
      if (!adapter) throw new Error(`chain '${chainId}' is not configured`);
      return adapter;
    },
    list: () => infos,
  };
}

/**
 * Returns the real DLT adapter when its connection is configured, otherwise the
 * in-memory simulated one — so the platform always runs and upgrades to real
 * infrastructure by configuration alone.
 */
function makeSimulatedOrReal(id: string, family: ChainFamily, env: Env): LedgerAdapter {
  if (family === "fabric") {
    if (env.FABRIC_CONNECTION_PROFILE) {
      return new FabricGatewayAdapter({
        chainId: id,
        connectionProfile: env.FABRIC_CONNECTION_PROFILE,
        walletPath: env.FABRIC_WALLET ?? "./wallet",
        identity: env.FABRIC_IDENTITY ?? "appUser",
        channel: env.FABRIC_CHANNEL,
        chaincode: env.FABRIC_CHAINCODE,
      });
    }
    return new FabricLedgerAdapter(id);
  }
  if (family === "canton") {
    if (env.CANTON_LEDGER_URL && env.CANTON_TOKEN && env.CANTON_OPERATOR_PARTY && env.CANTON_TEMPLATE_ID) {
      return new CantonJsonApiAdapter({
        chainId: id,
        jsonApiUrl: env.CANTON_LEDGER_URL,
        token: env.CANTON_TOKEN,
        operatorParty: env.CANTON_OPERATOR_PARTY,
        templateId: env.CANTON_TEMPLATE_ID,
      });
    }
    return new CantonLedgerAdapter(id);
  }
  return new MockLedgerAdapter(id);
}
