import type { ChainInfo } from "../types.js";

/** Explorer tx URL for a hash, or null when the chain has no explorer (local Besu). */
export function explorerTxUrl(chains: ChainInfo[] | undefined, chainId: string | null | undefined, hash: string): string | null {
  if (!chains || !chainId) return null;
  const base = chains.find((c) => c.id === chainId)?.explorerUrl;
  return base ? `${base.replace(/\/$/, "")}/tx/${hash}` : null;
}
