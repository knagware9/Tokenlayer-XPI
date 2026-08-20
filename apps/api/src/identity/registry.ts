/**
 * The on-chain identity registries: boot-time deploy + resolution.
 *
 * Exactly one chain hosts them (REGISTRY_CHAIN_ID, default "besu"). Absent chain
 * ⇒ no registry ⇒ the platform issues UNANCHORED credentials and says so at the
 * status endpoint. This mirrors the platform's "real or absent, never mocked"
 * rule: we never fake an anchor.
 *
 * It is resolved once at boot on ONE chain and knows nothing about use cases —
 * every WRITE reads `deps.registry` directly and anchors unconditionally
 * (credential issuance and revocation in `credential-issuance.ts`), or is a
 * deliberate live-only act of platform governance no machine principal can
 * reach (the boot-time platform-org bootstrap, `POST /orgs`,
 * `POST /orgs/:id/approve`, `ensureOrg`). Each says so at its call site; a new
 * writer that fits neither of those is a bug.
 */
import { supportsCredentialAnchor, type CredentialAnchor } from "@tokenlayer/adapters";
import type { ChainRegistry } from "../shared/chains.js";
import type { RegistryDeploymentRepository } from "../persistence/types/index.js";

export interface IdentityRegistry {
  chainId: string;
  didRegistry: string;
  vcRegistry: string;
  deployTxHash: string;
  anchor: CredentialAnchor;
}

/**
 * Does a contract still exist at `address`?
 *
 * FALSE ON ERROR, NOT A THROW. A chain we cannot reach is indistinguishable
 * from one where the code is gone, and both mean the same thing to boot: do not
 * trust the stored deployment. Crashing instead would take the whole API down
 * because one chain was briefly unreachable.
 */
export async function registryIsLive(
  provider: { getCode: (address: string) => Promise<string> },
  address: string,
): Promise<boolean> {
  try {
    const code = await provider.getCode(address);
    return !!code && code !== "0x";
  } catch {
    return false;
  }
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
    // A STORED ADDRESS IS NOT EVIDENCE THAT A CONTRACT EXISTS. After a
    // re-genesis the row survives but the bytecode is gone, and boot must not
    // hand out an anchor that resolves to nothing. `adapter.getCode` is only
    // declared on EVM adapters (optional on `LedgerAdapter`); we are already
    // past the `supportsCredentialAnchor` guard above, so a real EVM adapter is
    // guaranteed to have it here, but treat it as absent rather than crash if
    // some future adapter satisfies CredentialAnchor without exposing bytecode.
    // BOTH registries, not just the DID one. They are deployed together and a
    // re-genesis wipes both, but they are two independent addresses: checking
    // one and inferring the other is a check that answers the wrong question —
    // it would keep serving a dead `vcRegistry` for as long as the DID address
    // happened to hold code, and every credential anchored there would go
    // nowhere.
    const codeProvider = { getCode: (a: string) => adapter.getCode!(a) };
    const live = adapter.getCode
      ? (await registryIsLive(codeProvider, existing.didRegistry)) && (await registryIsLive(codeProvider, existing.vcRegistry))
      : false;
    if (live) {
      return { chainId: opts.chainId, didRegistry: existing.didRegistry, vcRegistry: existing.vcRegistry, deployTxHash: existing.deployTxHash, anchor: adapter };
    }
    log(`[registry] stored ${opts.chainId} registries do not both hold bytecode (re-genesis?) — redeploying`);
  }
  try {
    const d = await adapter.deployRegistries();
    // upsert, not create: `chainId` is the primary key, so replacing a stale
    // row must overwrite it rather than throw a duplicate-key error that would
    // land in the catch below and leave the chain UNANCHORED — strictly worse
    // than the stale registry we are replacing.
    await opts.deployments.upsert({ chainId: opts.chainId, didRegistry: d.didRegistry, vcRegistry: d.vcRegistry, deployTxHash: d.txHash });
    log(`[registry] deployed identity registries on '${opts.chainId}': did=${d.didRegistry} vc=${d.vcRegistry}`);
    return { chainId: opts.chainId, didRegistry: d.didRegistry, vcRegistry: d.vcRegistry, deployTxHash: d.txHash, anchor: adapter };
  } catch (err) {
    log(`[registry] deploy on '${opts.chainId}' FAILED: ${(err as Error).message} — continuing UNANCHORED`);
    return undefined;
  }
}
