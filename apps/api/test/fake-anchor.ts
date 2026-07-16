import { createHash } from "node:crypto";
import type { CredentialAnchor, DidRegistration, OnChainCredentialStatus } from "@tokenlayer/adapters";
import type { IdentityRegistry } from "../src/registry.js";

const hash = (s: string): string => "0x" + createHash("sha256").update(s).digest("hex");

/** In-memory CredentialAnchor for wiring tests. `failNext` forces the next write to throw. */
export class FakeAnchor implements CredentialAnchor {
  readonly credentials = new Map<string, { vcHash: string; revoked: boolean; revokedAt: number | null }>();
  readonly dids = new Map<string, boolean>(); // did -> active
  failNext: string | null = null;

  private boom(op: string): void {
    if (this.failNext === op) {
      this.failNext = null;
      throw new Error(`fake anchor: ${op} failed`);
    }
  }
  private receipt() {
    return { txHash: `0xfake${this.credentials.size}${this.dids.size}`, chainId: "besu", timestamp: new Date().toISOString() };
  }

  async deployRegistries() {
    return { didRegistry: "0xdid", vcRegistry: "0xvc", txHash: "0xdeploy" };
  }
  async registerDid(_registry: string, did: string) {
    this.boom("registerDid");
    this.dids.set(did, true);
    return this.receipt();
  }
  async deactivateDid(_registry: string, did: string) {
    this.boom("deactivateDid");
    this.dids.set(did, false);
    return this.receipt();
  }
  async didRegistration(_registry: string, did: string): Promise<DidRegistration> {
    return this.dids.has(did) ? { registered: true, active: this.dids.get(did)! } : { registered: false, active: false };
  }
  async anchorCredential(_registry: string, credentialId: string, vcJwt: string, _issuedAt: number, _expiresAt: number) {
    this.boom("anchorCredential");
    this.credentials.set(credentialId, { vcHash: hash(vcJwt), revoked: false, revokedAt: null });
    return this.receipt();
  }
  async revokeCredential(_registry: string, credentialId: string) {
    this.boom("revokeCredential");
    const rec = this.credentials.get(credentialId);
    if (rec) { rec.revoked = true; rec.revokedAt = Math.floor(Date.now() / 1000); }
    return this.receipt();
  }
  async credentialStatusOf(_registry: string, credentialId: string): Promise<OnChainCredentialStatus> {
    const rec = this.credentials.get(credentialId);
    if (!rec) return { exists: false, revoked: false, revokedAt: null, vcHash: "0x" + "0".repeat(64) };
    return { exists: true, revoked: rec.revoked, revokedAt: rec.revokedAt, vcHash: rec.vcHash };
  }
}

export function fakeRegistry(anchor: FakeAnchor): IdentityRegistry {
  return { chainId: "besu", didRegistry: "0xdid", vcRegistry: "0xvc", deployTxHash: "0xdeploy", anchor };
}
