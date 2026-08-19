/**
 * A STORED ADDRESS IS NOT EVIDENCE THAT A CONTRACT EXISTS.
 *
 * After a Besu re-genesis, GET /registry kept serving 0x630e594e… — an address
 * holding no bytecode — because boot read the RegistryDeployment row and never
 * asked the chain. Same rule the chain registry already applies to chains: real
 * or absent, never assumed.
 */
import { describe, expect, it } from "vitest";
import type {
  AssetDeploymentSpec,
  AssetRef,
  ChainFamily,
  DeployResult,
  LedgerAdapter,
  TxReceipt,
} from "@tokenlayer/core";
import type { CredentialAnchor, DidRegistration, OnChainCredentialStatus } from "@tokenlayer/adapters";
import type { ChainInfo, ChainProbeResult, ChainRegistry } from "../src/shared/chains.js";
import { MemoryRegistryDeploymentRepository } from "../src/persistence/memory/index.js";
import { registryIsLive, resolveIdentityRegistry } from "../src/identity/registry.js";

describe("registryIsLive", () => {
  it("is true when the address holds bytecode", async () => {
    const provider = { getCode: async () => "0x6080604052" };
    expect(await registryIsLive(provider, "0xC")).toBe(true);
  });

  it("is false for an address wiped by a re-genesis", async () => {
    const provider = { getCode: async () => "0x" };
    expect(await registryIsLive(provider, "0xC")).toBe(false);
  });

  it("is false — not a throw — when the chain cannot be reached", async () => {
    // Boot must not crash because a chain is down; absent is a valid answer.
    const provider = { getCode: async () => { throw new Error("ECONNREFUSED"); } };
    expect(await registryIsLive(provider, "0xC")).toBe(false);
  });
});

/**
 * A scripted EVM-shaped adapter: implements CredentialAnchor (so
 * `supportsCredentialAnchor` accepts it) plus `getCode`, and tracks how many
 * times `deployRegistries` runs so the test can prove a redeploy happens
 * exactly once, not on every boot.
 */
class ScriptedRegistryAdapter implements LedgerAdapter, CredentialAnchor {
  readonly chainId: string;
  readonly family: ChainFamily = "evm";
  readonly codeByAddress = new Map<string, string>();
  deployCount = 0;

  constructor(chainId: string) {
    this.chainId = chainId;
  }

  async getCode(address: string): Promise<string> {
    return this.codeByAddress.get(address) ?? "0x";
  }

  async deployRegistries(): Promise<{ didRegistry: string; vcRegistry: string; txHash: string }> {
    this.deployCount += 1;
    const didRegistry = `0xnew-did-${this.deployCount}`;
    const vcRegistry = `0xnew-vc-${this.deployCount}`;
    // The freshly-deployed addresses hold real bytecode from this point on.
    this.codeByAddress.set(didRegistry, "0x6080604052");
    this.codeByAddress.set(vcRegistry, "0x6080604052");
    return { didRegistry, vcRegistry, txHash: `0xdeploy-${this.deployCount}` };
  }

  private unused(): never {
    throw new Error("registry resolution does not call this adapter method");
  }
  registerDid(_registry: string, _did: string): Promise<TxReceipt> {
    return this.unused();
  }
  deactivateDid(_registry: string, _did: string): Promise<TxReceipt> {
    return this.unused();
  }
  didRegistration(_registry: string, _did: string): Promise<DidRegistration> {
    return this.unused();
  }
  anchorCredential(_registry: string, _credentialId: string, _vcJwt: string, _issuedAt: number, _expiresAt: number): Promise<TxReceipt> {
    return this.unused();
  }
  revokeCredential(_registry: string, _credentialId: string): Promise<TxReceipt> {
    return this.unused();
  }
  credentialStatusOf(_registry: string, _credentialId: string): Promise<OnChainCredentialStatus> {
    return this.unused();
  }
  deployAsset(_spec: AssetDeploymentSpec): Promise<DeployResult> {
    return this.unused();
  }
  mint(_ref: AssetRef, _to: string, _amount: string): Promise<TxReceipt> {
    return this.unused();
  }
  transfer(_ref: AssetRef, _from: string, _to: string, _amount: string): Promise<TxReceipt> {
    return this.unused();
  }
  burn(_ref: AssetRef, _from: string, _amount: string): Promise<TxReceipt> {
    return this.unused();
  }
  balanceOf(_ref: AssetRef, _account: string): Promise<string> {
    return this.unused();
  }
  totalSupply(_ref: AssetRef): Promise<string> {
    return this.unused();
  }
  mintToken(_ref: AssetRef, _to: string, _tokenId: string, _uri?: string): Promise<TxReceipt> {
    return this.unused();
  }
  transferToken(_ref: AssetRef, _from: string, _to: string, _tokenId: string): Promise<TxReceipt> {
    return this.unused();
  }
  burnToken(_ref: AssetRef, _tokenId: string): Promise<TxReceipt> {
    return this.unused();
  }
  ownerOf(_ref: AssetRef, _tokenId: string): Promise<string | null> {
    return this.unused();
  }
  tokensOf(_ref: AssetRef, _account: string): Promise<string[]> {
    return this.unused();
  }
  setFrozen(_ref: AssetRef, _account: string, _frozen: boolean): Promise<TxReceipt> {
    return this.unused();
  }
  setAllowed(_ref: AssetRef, _account: string, _allowed: boolean): Promise<TxReceipt> {
    return this.unused();
  }
  isFrozen(_ref: AssetRef, _account: string): Promise<boolean> {
    return this.unused();
  }
  isAllowed(_ref: AssetRef, _account: string): Promise<boolean> {
    return this.unused();
  }
  anchor(_ref: AssetRef, _hash: string): Promise<TxReceipt> {
    return this.unused();
  }
}

function fakeChains(adapter: ScriptedRegistryAdapter): ChainRegistry {
  return {
    resolveAdapter: (_chainId: string) => adapter,
    list: (): ChainInfo[] => [],
    assertConnectivity: async () => {},
    probe: async (_chainId: string): Promise<ChainProbeResult> => {
      throw new Error("not used by this test");
    },
  };
}

describe("resolveIdentityRegistry — dead-registry redeploy", () => {
  it("redeploys and REPLACES the stored row when the stored address holds no bytecode, without duplicating or losing it", async () => {
    const adapter = new ScriptedRegistryAdapter("besu");
    const deployments = new MemoryRegistryDeploymentRepository();
    // A stored row surviving a re-genesis: the address is on record but the
    // chain holds no bytecode there (adapter.codeByAddress has nothing for it).
    await deployments.create({ chainId: "besu", didRegistry: "0xdead-did", vcRegistry: "0xdead-vc", deployTxHash: "0xdead-deploy" });

    const logs: string[] = [];
    const result = await resolveIdentityRegistry({
      chainId: "besu",
      chains: fakeChains(adapter),
      deployments,
      log: (m) => logs.push(m),
    });

    // Redeployed exactly once, and the result carries the NEW addresses, not
    // the dead stored ones.
    expect(adapter.deployCount).toBe(1);
    expect(result?.didRegistry).toBe("0xnew-did-1");
    expect(result?.vcRegistry).toBe("0xnew-vc-1");
    expect(logs.some((m) => m.includes("no bytecode") || m.includes("redeploying"))).toBe(true);

    // The stored row is REPLACED, not lost and not duplicated: `get` returns
    // exactly one row, and it is the new deployment.
    const stored = await deployments.get("besu");
    expect(stored).not.toBeNull();
    expect(stored?.didRegistry).toBe("0xnew-did-1");
    expect(stored?.vcRegistry).toBe("0xnew-vc-1");
    expect(stored?.didRegistry).not.toBe("0xdead-did");

    // A second boot against the now-live registry must NOT redeploy again.
    const second = await resolveIdentityRegistry({
      chainId: "besu",
      chains: fakeChains(adapter),
      deployments,
      log: () => {},
    });
    expect(adapter.deployCount).toBe(1);
    expect(second?.didRegistry).toBe("0xnew-did-1");
  });

  it("keeps the live stored registry as-is without redeploying", async () => {
    const adapter = new ScriptedRegistryAdapter("besu");
    adapter.codeByAddress.set("0xlive-did", "0x6080604052");
    const deployments = new MemoryRegistryDeploymentRepository();
    await deployments.create({ chainId: "besu", didRegistry: "0xlive-did", vcRegistry: "0xlive-vc", deployTxHash: "0xlive-deploy" });

    const result = await resolveIdentityRegistry({
      chainId: "besu",
      chains: fakeChains(adapter),
      deployments,
      log: () => {},
    });

    expect(adapter.deployCount).toBe(0);
    expect(result?.didRegistry).toBe("0xlive-did");
  });
});
