/**
 * The on-chain identity registries: boot-time deploy + resolution.
 *
 * Exactly one chain hosts them (REGISTRY_CHAIN_ID, default "besu"). Absent chain
 * ⇒ no registry ⇒ the platform issues UNANCHORED credentials and says so at the
 * status endpoint. This mirrors the platform's "real or absent, never mocked"
 * rule: we never fake an anchor.
 *
 * THIS OBJECT KNOWS NOTHING ABOUT USE CASES, AND THAT IS THE HAZARD (EN-D2).
 * It is resolved once at boot on ONE chain, so neither `sandboxChainsValid`
 * (which governs a use case's chains) nor `modeGate` (which governs its
 * principals) stands between a caller and a real transaction — a live
 * walkthrough proved a sandbox credential issuance spending real gas on real
 * Besu through exactly this seam. Every WRITE must therefore either go through
 * `sandbox.ts#writableRegistry` (credential issuance and revocation), take the
 * sandbox flag itself (`ensureOrg`), or be a deliberate live-only act of
 * platform governance no machine principal can reach (the boot-time
 * platform-org bootstrap, `POST /orgs`, `POST /orgs/:id/approve`). Each says so
 * at its call site; a new writer that fits none of those three is a bug.
 */
import { supportsCredentialAnchor, type CredentialAnchor } from "@tokenlayer/adapters";
import type { ChainRegistry } from "../shared/chains.js";
import type { RegistryDeploymentRepository } from "../persistence/types.js";

export interface IdentityRegistry {
  chainId: string;
  didRegistry: string;
  vcRegistry: string;
  deployTxHash: string;
  anchor: CredentialAnchor;
}

/**
 * Resolve the identity registry, deploying it once if this chain has never had
 * one. Returns undefined when the chain is absent or cannot host registries.
 * Never throws: a broken deploy must not brick the platform — it degrades to
 * unanchored, loudly.
 */
export async function resolveIdentityRegistry(opts: {
  chainId: string;
  chains: ChainRegistry;
  deployments: RegistryDeploymentRepository;
  log?: (msg: string) => void;
}): Promise<IdentityRegistry | undefined> {
  const log = opts.log ?? ((m: string) => console.log(m));
  let adapter;
  try {
    adapter = opts.chains.resolveAdapter(opts.chainId);
  } catch {
    log(`[registry] chain '${opts.chainId}' is absent — credentials will be issued UNANCHORED (status reports source: "database")`);
    return undefined;
  }
  if (!supportsCredentialAnchor(adapter)) {
    log(`[registry] chain '${opts.chainId}' cannot host identity registries (not an EVM adapter) — credentials will be issued UNANCHORED`);
    return undefined;
  }

  const existing = await opts.deployments.get(opts.chainId);
  if (existing) {
    return { chainId: opts.chainId, didRegistry: existing.didRegistry, vcRegistry: existing.vcRegistry, deployTxHash: existing.deployTxHash, anchor: adapter };
  }
  try {
    const d = await adapter.deployRegistries();
    await opts.deployments.create({ chainId: opts.chainId, didRegistry: d.didRegistry, vcRegistry: d.vcRegistry, deployTxHash: d.txHash });
    log(`[registry] deployed identity registries on '${opts.chainId}': did=${d.didRegistry} vc=${d.vcRegistry}`);
    return { chainId: opts.chainId, didRegistry: d.didRegistry, vcRegistry: d.vcRegistry, deployTxHash: d.txHash, anchor: adapter };
  } catch (err) {
    log(`[registry] deploy on '${opts.chainId}' FAILED: ${(err as Error).message} — continuing UNANCHORED`);
    return undefined;
  }
}
