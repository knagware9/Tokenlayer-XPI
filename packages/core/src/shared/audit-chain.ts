import { createHash } from "node:crypto";

/** The immutable fields of one audit entry that get hashed into the chain. */
export interface AuditChainFields {
  assetId: string;      // chain key ("__none__" for asset-less entries)
  seq: number;          // per-asset sequence, 0-based
  actorId: string;
  action: string;
  payload: Record<string, unknown>;
  txHash?: string;
  chainId?: string;
  createdAt: string;    // stored ISO timestamp
}

export interface ChainEntry { seq: number; prevHash: string; hash: string; fields: AuditChainFields; }
export interface VerifyResult { assetId: string; valid: boolean; count: number; head: string | null; brokenAt: number | null; reason?: string; }

/** Deterministic JSON: object keys sorted recursively, arrays preserved. */
function canonicalJSON(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJSON).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalJSON(o[k])).join(",") + "}";
}

const sha256hex = (s: string): string => "0x" + createHash("sha256").update(s, "utf8").digest("hex");

/** Distinct genesis per asset so entries cannot be spliced between chains. */
export function auditGenesis(assetId: string): string {
  return sha256hex("tokenlayer-audit-genesis|" + assetId);
}

/** hash = sha256(prevHash + "|" + canonicalJSON(normalized fields)). */
export function auditEntryHash(prevHash: string, fields: AuditChainFields): string {
  const canonical = canonicalJSON({
    assetId: fields.assetId, seq: fields.seq, actorId: fields.actorId, action: fields.action,
    payload: fields.payload, txHash: fields.txHash ?? null, chainId: fields.chainId ?? null, createdAt: fields.createdAt,
  });
  return sha256hex(prevHash + "|" + canonical);
}

/** Recompute one asset's chain (entries MUST be seq-ascending). First break wins. */
export function verifyChain(assetId: string, entries: ChainEntry[]): VerifyResult {
  let prev = auditGenesis(assetId);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i) return { assetId, valid: false, count: entries.length, head: null, brokenAt: i, reason: "seq-gap" };
    if (e.prevHash !== prev) return { assetId, valid: false, count: entries.length, head: null, brokenAt: e.seq, reason: "prevhash-mismatch" };
    if (e.hash !== auditEntryHash(prev, e.fields)) return { assetId, valid: false, count: entries.length, head: null, brokenAt: e.seq, reason: "hash-mismatch" };
    prev = e.hash;
  }
  return { assetId, valid: true, count: entries.length, head: entries.length ? prev : null, brokenAt: null };
}
