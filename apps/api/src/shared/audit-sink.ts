import type { AuditRecord, AuditSink } from "@tokenlayer/core";
import type { AuditRepository } from "../persistence/types.js";

/** Bridges the engine's AuditSink to a persistence-layer AuditRepository. */
export class RepositoryAuditSink implements AuditSink {
  constructor(private readonly repo: AuditRepository) {}

  async record(entry: AuditRecord): Promise<void> {
    await this.repo.append({
      assetId: entry.assetId,
      actorId: entry.actorId,
      action: entry.action,
      payload: entry.payload,
      txHash: entry.txHash,
      chainId: entry.chainId,
      createdAt: entry.at,
    });
  }
}
