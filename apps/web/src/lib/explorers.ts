import type { ChainInfo } from "../types.js";

/** Explorer tx URL for a hash, or null when the chain has no explorer (local Besu). */
export function explorerTxUrl(chains: ChainInfo[] | undefined, chainId: string | null | undefined, hash: string): string | null {
  // Only link genuine on-chain hex refs — never interpolate an untrusted value into an href.
  if (!chains || !chainId || !/^0x[0-9a-fA-F]+$/.test(hash)) return null;
  const base = chains.find((c) => c.id === chainId)?.explorerUrl;
  return base ? `${base.replace(/\/$/, "")}/tx/${hash}` : null;
}
