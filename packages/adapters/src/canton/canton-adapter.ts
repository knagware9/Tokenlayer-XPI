import type {
  AssetDeploymentSpec,
  AssetRef,
  ChainFamily,
  DeployResult,
  LedgerAdapter,
  TxReceipt,
} from "@tokenlayer/core";

export interface CantonAdapterConfig {
  chainId?: string;
  /** Daml JSON API base URL, e.g. http://localhost:7575 */
  jsonApiUrl: string;
  /** JWT bearer token authorising the operator party. */
  token: string;
  /** The operator Party id (e.g. "Operator::1220abc..."). */
  operatorParty: string;
  /** Fully-qualified template id, e.g. "<pkgId>:TokenLayer:Asset". */
  templateId: string;
}

type Pairs = [string, unknown][];

/**
 * Real Canton adapter. Drives the TokenLayer Daml model (infra/canton/daml) via
 * the Daml ledger JSON API: each asset is one `Asset` contract keyed by
 * (operator, assetId); mutating choices are exercised by key, reads come from
 * querying the contract payload. Compliance (allowlist + freeze) is enforced in
 * Daml, mirroring the EVM and simulated ledgers.
 *
 * Only constructed when CANTON_LEDGER_URL is configured; otherwise the platform
 * falls back to the simulated Canton adapter. NOTE: requires a running Canton /
 * Daml ledger with the DAR uploaded; not exercised in CI.
 */
export class CantonLedgerAdapter implements LedgerAdapter {
  readonly chainId: string;
  readonly family: ChainFamily = "canton";

  constructor(private readonly config: CantonAdapterConfig) {
    this.chainId = config.chainId ?? "canton";
  }

  private async rpc(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.config.jsonApiUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.token}` },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as any;
    if (!res.ok || json.status >= 400) {
      throw new Error(`canton: ${path} failed: ${JSON.stringify(json.errors ?? json)}`);
    }
    return json;
  }

  private async exercise(assetId: string, choice: string, argument: Record<string, unknown>): Promise<TxReceipt> {
    const result = await this.rpc("/v1/exercise", {
      templateId: this.config.templateId,
      key: [this.config.operatorParty, assetId],
      choice,
      argument,
    });
    return { txHash: result.result?.exerciseResult ?? assetId, chainId: this.chainId, timestamp: new Date().toISOString() };
  }

  /** Fetch the active Asset contract's payload for an asset id. */
  private async payload(assetId: string): Promise<any | null> {
    const res = await this.rpc("/v1/query", { templateIds: [this.config.templateId], query: { assetId } });
    const active = (res.result ?? []).filter((c: any) => c.payload?.assetId === assetId);
    return active.length ? active[active.length - 1].payload : null;
  }

  private static toMap(pairs: Pairs | undefined): Map<string, unknown> {
    return new Map((pairs ?? []).map(([k, v]) => [k, v]));
  }

  async deployAsset(spec: AssetDeploymentSpec): Promise<DeployResult> {
    await this.rpc("/v1/create", {
      templateId: this.config.templateId,
      payload: {
        operator: this.config.operatorParty,
        assetId: spec.id,
        tokenType: spec.tokenType,
        allowlistEnabled: spec.allowlistEnabled,
        balances: [],
        supply: "0",
        owners: [],
        frozen: [],
        allowed: [],
      },
    });
    return { contractRef: spec.id, txHash: spec.id };
  }

  mint = (ref: AssetRef, to: string, amount: string) => this.exercise(ref.contractRef, "Mint", { to, amount });
  transfer = (ref: AssetRef, from: string, to: string, amount: string) =>
    this.exercise(ref.contractRef, "Transfer", { from, to, amount });
  burn = (ref: AssetRef, from: string, amount: string) => this.exercise(ref.contractRef, "Burn", { from, amount });
  mintToken = (ref: AssetRef, to: string, tokenId: string) =>
    this.exercise(ref.contractRef, "MintToken", { to, tokenId });
  transferToken = (ref: AssetRef, from: string, to: string, tokenId: string) =>
    this.exercise(ref.contractRef, "TransferToken", { from, to, tokenId });
  burnToken = (ref: AssetRef, tokenId: string) => this.exercise(ref.contractRef, "BurnToken", { tokenId });
  setFrozen = (ref: AssetRef, account: string, frozen: boolean) =>
    this.exercise(ref.contractRef, "SetFrozen", { account, isFrozen: frozen });
  setAllowed = (ref: AssetRef, account: string, allowed: boolean) =>
    this.exercise(ref.contractRef, "SetAllowed", { account, isAllowed: allowed });

  async balanceOf(ref: AssetRef, account: string): Promise<string> {
    const p = await this.payload(ref.contractRef);
    if (!p) return "0";
    if (p.tokenType === "nonfungible") {
      return String((p.owners as Pairs).filter(([, owner]) => owner === account).length);
    }
    return String(CantonLedgerAdapter.toMap(p.balances).get(account) ?? "0");
  }
  async totalSupply(ref: AssetRef): Promise<string> {
    const p = await this.payload(ref.contractRef);
    if (!p) return "0";
    return p.tokenType === "nonfungible" ? String((p.owners as Pairs).length) : String(p.supply ?? "0");
  }
  async ownerOf(ref: AssetRef, tokenId: string): Promise<string | null> {
    const p = await this.payload(ref.contractRef);
    const owner = p ? CantonLedgerAdapter.toMap(p.owners).get(tokenId) : undefined;
    return (owner as string) ?? null;
  }
  async tokensOf(ref: AssetRef, account: string): Promise<string[]> {
    const p = await this.payload(ref.contractRef);
    return p ? (p.owners as Pairs).filter(([, owner]) => owner === account).map(([id]) => id) : [];
  }
  async isFrozen(ref: AssetRef, account: string): Promise<boolean> {
    const p = await this.payload(ref.contractRef);
    return Boolean(p && CantonLedgerAdapter.toMap(p.frozen).get(account));
  }
  async isAllowed(ref: AssetRef, account: string): Promise<boolean> {
    const p = await this.payload(ref.contractRef);
    return Boolean(p && CantonLedgerAdapter.toMap(p.allowed).get(account));
  }
}
