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
  /** EVM chains: the numeric chain id the RPC must report; a mismatch aborts startup (guards against pointing at the wrong network). */
  expectedChainId?: number;
  /** Public block explorer base URL (no trailing slash), e.g. https://testnet.mstscan.com — used to link addresses/txs in the dashboard. */
  explorerUrl?: string;
  /** Native gas-token symbol, e.g. tMSTC — informational. */
  currencySymbol?: string;
  /** Faucet URL for obtaining test funds — informational (surfaced in docs, not the API). */
  faucetUrl?: string;
}

export interface ChainInfo {
  id: string;
  label: string;
  family: ChainFamily;
  /** Descriptor class from chains.json ("evm" | "simulated" family group) — see `mode` for real vs simulated. */
  kind: "simulated" | "evm";
  /** "real" = live backend (EVM RPC / Fabric gateway / Canton JSON API); "simulated" = in-memory ledger. */
  mode: "real" | "simulated";
  /** false = a supported chain from the catalog that is not currently connected (no
   * adapter). It can still be selected as an allowed DLT when configuring a use case
   * (contracts deploy once the chain is brought online), but assets cannot be issued
   * on it yet. Live chains are `true`. */
  available: boolean;
  /** Public block-explorer base URL (no trailing slash), when the chain has one — lets the UI link contract addresses and tx hashes. */
  explorerUrl?: string;
  /** Native gas-token symbol (e.g. tMSTC), when known. */
  currencySymbol?: string;
  /** Whether the chain's connection config is present (EVM: rpc + operator key env; simulated-kind chains: always true). Mirrors adapter presence. */
  configured: boolean;
  /** EVM chains: the numeric chain id the RPC must report (from the catalog) — e.g. 91562037 for MST Testnet. */
  expectedChainId?: number;
  /** Faucet URL for obtaining test funds, when the chain has one. */
  faucetUrl?: string;
  /** Hostname of the configured RPC endpoint — NEVER the full URL (hosted RPC URLs can embed API keys). */
  rpcHost?: string;
}

/** Result of an on-demand liveness probe (GET /chains/:id/status). */
export interface ChainProbeResult {
  id: string;
  reachable: boolean;
  mode: "real" | "simulated";
  /** The numeric chain id the RPC reports (EVM), as a string. */
  chainId?: string;
  operator?: string;
  balance?: string;
  /** Failure detail — sanitised: never contains the RPC URL or host. */
  error?: string;
}

export interface ChainRegistry {
  resolveAdapter(chainId: string): LedgerAdapter;
  list(): ChainInfo[];
  /** Boot check: every configured EVM chain must answer eth_chainId, or this rejects. */
  assertConnectivity(): Promise<void>;
  /** On-demand liveness probe of one chain. Never rejects for an unreachable network
   * (that is `reachable: false` + error); throws only for an unknown/absent chain id. */
  probe(chainId: string): Promise<ChainProbeResult>;
}

type Env = Record<string, string | undefined>;

function evmArtifacts(): Record<TokenStandard, ReturnType<typeof loadArtifact>> {
  return {
    "ERC-20": loadArtifact("ComplianceToken"),
    "ERC-721": loadArtifact("ComplianceNFT"),
    "ERC-3643": loadArtifact("ComplianceToken3643"),
  };
}

/** Registry artifacts for the identity registries (EVM only). */
function registryArtifacts(): { didRegistry: ReturnType<typeof loadArtifact>; vcRegistry: ReturnType<typeof loadArtifact> } {
  return { didRegistry: loadArtifact("DidRegistry"), vcRegistry: loadArtifact("VcRegistry") };
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
  const evmChains: { descriptor: ChainDescriptor; adapter: EvmLedgerAdapter }[] = [];
  // Real non-EVM adapters (e.g. a configured Fabric gateway) that expose a healthCheck —
  // probed at boot just like EVM chains so a configured-but-down network fails fast.
  const realProbes: { id: string; adapter: { healthCheck(): Promise<{ chainId: string; operator: string; balance: string }> } }[] = [];
  // Configured RPC URLs per EVM chain — kept OUT of ChainInfo (hosted URLs can embed
  // API keys); used only to derive rpcHost and to scrub probe error messages.
  const rpcUrls = new Map<string, string>();
  let artifacts: Record<TokenStandard, ReturnType<typeof loadArtifact>> | null = null;

  for (const d of descriptors) {
    if (d.kind === "simulated") {
      const { adapter, real } = makeSimulatedOrReal(d.id, d.family, env);
      adapters.set(d.id, adapter);
      infos.push({ id: d.id, label: d.label, family: d.family, kind: "simulated", mode: real ? "real" : "simulated", available: true, configured: true, faucetUrl: d.faucetUrl });
      if (real && typeof (adapter as { healthCheck?: unknown }).healthCheck === "function") {
        realProbes.push({ id: d.id, adapter: adapter as unknown as (typeof realProbes)[number]["adapter"] });
      }
      continue;
    }
    // EVM chain — real when its RPC + operator key are configured, otherwise absent.
    const rpcUrl = d.rpcEnv ? env[d.rpcEnv] : undefined;
    const privateKey = (d.keyEnv ? env[d.keyEnv] : undefined) ?? env.EVM_OPERATOR_KEY;
    if (rpcUrl && privateKey) {
      artifacts ??= evmArtifacts();
      const adapter = new EvmLedgerAdapter({ chainId: d.id, rpcUrl, privateKey, artifacts, registryArtifacts: registryArtifacts(), gas: d.gas, confirmations: d.confirmations });
      adapters.set(d.id, adapter);
      rpcUrls.set(d.id, rpcUrl);
      infos.push({
        id: d.id, label: d.label, family: d.family, kind: "evm", mode: "real", available: true,
        explorerUrl: d.explorerUrl, currencySymbol: d.currencySymbol,
        configured: true, expectedChainId: d.expectedChainId, faucetUrl: d.faucetUrl, rpcHost: hostnameOf(rpcUrl),
      });
      evmChains.push({ descriptor: d, adapter });
    } else if (d.required && strict) {
      throw new Error(
        `chain '${d.id}' is required but not configured: set ${d.rpcEnv} and ${d.keyEnv}. ` +
          `Run \`make deploy\` to start the Besu network, or set CHAIN_STRICT=0 to boot without it ` +
          `(the chain will be absent — never simulated).`,
      );
    } else {
      // EVM chain not connected (CHAIN_STRICT=0 required chain like besu, or an
      // optional one like mst/local-evm without env). It has NO adapter — assets
      // cannot be issued on it — but it is a supported DLT from the catalog, so we
      // surface it as a selectable option (available:false) when configuring a use
      // case. Selecting it leaves that chain's contract pending until it comes online.
      if (d.required) console.warn(`[chains] CHAIN_STRICT=0 — required chain '${d.id}' is NOT configured; it will be absent (not simulated).`);
      infos.push({
        id: d.id, label: d.label, family: d.family, kind: "evm", mode: "real", available: false,
        explorerUrl: d.explorerUrl, currencySymbol: d.currencySymbol,
        configured: false, expectedChainId: d.expectedChainId, faucetUrl: d.faucetUrl,
      });
    }
  }

  return {
    resolveAdapter(chainId: string): LedgerAdapter {
      const adapter = adapters.get(chainId);
      if (!adapter) throw new Error(`chain '${chainId}' is not configured`);
      return adapter;
    },
    list: () => infos,
    async probe(chainId: string): Promise<ChainProbeResult> {
      const info = infos.find((c) => c.id === chainId);
      const adapter = adapters.get(chainId);
      // Unknown id, or a catalog chain with no adapter (absent EVM chain) — the
      // route maps this to 404; there is nothing to probe.
      if (!info || !adapter) throw new Error(`chain '${chainId}' is not configured`);
      if (info.mode === "simulated") return { id: chainId, reachable: true, mode: "simulated" };
      const target = adapter as { healthCheck?: () => Promise<{ chainId: string; operator: string; balance: string }> };
      if (typeof target.healthCheck !== "function") return { id: chainId, reachable: true, mode: "real" };
      try {
        const h = await target.healthCheck();
        return { id: chainId, reachable: true, mode: "real", chainId: h.chainId, operator: h.operator, balance: h.balance };
      } catch (err) {
        // Sanitised: never echo the RPC URL/host — hosted RPC URLs can embed API keys.
        return { id: chainId, reachable: false, mode: "real", error: sanitizeProbeError((err as Error).message, rpcUrls.get(chainId)) };
      }
    },
    async assertConnectivity(): Promise<void> {
      for (const { descriptor: d, adapter } of evmChains) {
        let h: { chainId: string; operator: string; balance: string };
        try {
          h = await adapter.healthCheck();
        } catch (err) {
          // Deliberately does NOT echo the RPC URL — hosted RPC URLs can embed API keys.
          throw new Error(
            `chain '${d.id}' is configured (via ${d.rpcEnv}) but unreachable: ${(err as Error).message}. ` +
              `Start the network (\`make deploy\`) or fix ${d.rpcEnv}.`,
          );
        }
        // Guard against pointing an env at the wrong network (e.g. mainnet vs testnet).
        if (d.expectedChainId !== undefined && h.chainId !== String(d.expectedChainId)) {
          throw new Error(
            `chain '${d.id}' connected to the wrong network: expected chainId ${d.expectedChainId} but the RPC (${d.rpcEnv}) reports ${h.chainId}. ` +
              `Point ${d.rpcEnv} at the correct network.`,
          );
        }
        console.log(`[chains] '${d.id}' connected: chainId=${h.chainId} operator=${h.operator} balance=${h.balance} ${d.currencySymbol ?? "ETH"}`);
      }
      // Real non-EVM ledgers (e.g. a configured Fabric network) — same fail-fast contract.
      for (const { id, adapter } of realProbes) {
        try {
          const h = await adapter.healthCheck();
          console.log(`[chains] '${id}' connected (real): operator=${h.operator} ${h.balance}`);
        } catch (err) {
          throw new Error(
            `chain '${id}' is configured as a real ledger but unreachable: ${(err as Error).message}. ` +
              `Bring its network up (e.g. \`make fabric-up\`) or fix its connection env.`,
          );
        }
      }
    },
  };
}

/** Hostname of an RPC URL, or undefined when unparsable. Never returns the full URL. */
function hostnameOf(rpcUrl: string): string | undefined {
  try {
    return new URL(rpcUrl).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Strips anything that could leak the RPC endpoint from a probe error message:
 * every URL-shaped token, plus the configured endpoint's host/hostname (hosted
 * RPC URLs can embed API keys; hosts alone can identify private infrastructure).
 */
function sanitizeProbeError(message: string, rpcUrl?: string): string {
  let out = message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<rpc>");
  if (rpcUrl) {
    try {
      const u = new URL(rpcUrl);
      out = out.split(u.host).join("<rpc-host>");
      out = out.split(u.hostname).join("<rpc-host>");
    } catch {
      out = out.split(rpcUrl).join("<rpc>");
    }
  }
  return out;
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
