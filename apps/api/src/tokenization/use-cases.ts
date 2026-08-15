import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeUseCaseDefinition, type UseCaseContract, type UseCaseDefinition } from "@tokenlayer/core";
import { coded } from "../shared/executors.js";
import type { UseCaseRepository } from "../persistence/types.js";

/** Absolute path to the repo's declarative use-case config directory. */
const USE_CASE_DIR = fileURLToPath(new URL("../../../../config/use-cases", import.meta.url));

/**
 * Reads every *.json default use case from config/use-cases, validating and
 * filling derived fields (e.g. tokenType, which the JSON omits). Normalising
 * here — not just in UseCaseRegistry — matters because seedUseCases deploys
 * straight from these definitions, and the Fabric adapter passes tokenType to
 * chaincode as a raw arg (an undefined would crash its deploy).
 */
export function loadDefaultUseCaseDefinitions(dir: string = USE_CASE_DIR): UseCaseDefinition[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.map((f) => normalizeUseCaseDefinition(JSON.parse(readFileSync(`${dir}/${f}`, "utf8"))));
}

/**
 * Deploys a use case's contract on each allowed chain that is currently
 * available. Best-effort: a chain whose deploy throws is skipped (left pending),
 * never crashing the caller. `availableChainIds` is the set of chains present in
 * the registry (e.g. fabric/canton in the simulated stack). `deploy` performs the
 * per-chain deploy (engine.deployUseCaseContract). Returns the contracts map.
 */
export async function deployUseCaseContracts(
  def: UseCaseDefinition,
  availableChainIds: ReadonlySet<string>,
  deploy: (def: UseCaseDefinition, chainId: string) => Promise<UseCaseContract>,
  log: (msg: string) => void = (m) => console.warn(m),
): Promise<Record<string, UseCaseContract>> {
  const contracts: Record<string, UseCaseContract> = {};
  for (const chainId of def.allowedChainIds) {
    if (!availableChainIds.has(chainId)) continue;
    try {
      contracts[chainId] = await deploy(def, chainId);
    } catch (err) {
      log(`[use-cases] deploy of '${def.key}' on chain '${chainId}' failed: ${(err as Error).message} — leaving pending`);
    }
  }
  return contracts;
}

/**
 * Deploys a use case's contract on every allowed+available chain and persists it,
 * returning the created record. Throws `NO_DEPLOYABLE_CHAIN` (400) if not a single
 * allowed chain is available — the shared behaviour behind both the PlatformAdmin
 * direct-create path and the create-use-case proposal's execute step, so their
 * error surface can never drift. The caller must have already validated the
 * definition (normalise) and checked the key does not exist.
 */
export async function deployAndCreateUseCase(
  repo: UseCaseRepository,
  def: UseCaseDefinition,
  availableChainIds: ReadonlySet<string>,
  deploy: (def: UseCaseDefinition, chainId: string) => Promise<UseCaseContract>,
  log?: (msg: string) => void,
): Promise<UseCaseDefinition> {
  const contracts = await deployUseCaseContracts(def, availableChainIds, deploy, log);
  if (Object.keys(contracts).length === 0) {
    throw coded(400, "NO_DEPLOYABLE_CHAIN", `no allowed chain is available to deploy '${def.key}'; configure at least one of: ${def.allowedChainIds.join(", ")}`);
  }
  return repo.create({ ...def, contracts });
}

/**
 * Idempotently seeds the default use cases into a repository. When a use case
 * does not yet exist AND a deploy wiring is supplied, its contract is deployed on
 * every allowed+available chain (best-effort, tolerant of failures — NEVER
 * crashes boot). Seeded config use cases include "fabric" (always available in
 * the simulated stack), so they deploy on fabric at boot. If no chain is
 * available, the use case is seeded with empty contracts (pending) and logged.
 */
export async function seedUseCases(
  repo: UseCaseRepository,
  wiring?: {
    availableChainIds: ReadonlySet<string>;
    /**
     * Chains with NO durable state — their ledger lives in this process's memory
     * and is empty again the moment it restarts. See `redeployOnSimulatedChains`.
     */
    simulatedChainIds?: ReadonlySet<string>;
    deploy: (def: UseCaseDefinition, chainId: string) => Promise<UseCaseContract>;
  },
): Promise<void> {
  for (const def of loadDefaultUseCaseDefinitions()) {
    if (await repo.has(def.key)) {
      if (wiring) await redeployOnSimulatedChains(repo, def, wiring);
      continue;
    }
    let contracts: Record<string, UseCaseContract> = {};
    if (wiring) {
      contracts = await deployUseCaseContracts(def, wiring.availableChainIds, wiring.deploy);
      if (Object.keys(contracts).length === 0) {
        console.warn(`[use-cases] seeded '${def.key}' with no deployed contracts (no allowed chain available) — pending`);
      }
    }
    await repo.create({ ...def, contracts });
  }
}

/**
 * A DEPLOYMENT RECORD ON A SIMULATED CHAIN DOES NOT SURVIVE A RESTART.
 *
 * The database remembers that `invoice-tokenization` has a contract on `fabric`.
 * The simulated Fabric adapter does not — its ledger is a Map in this process,
 * and a restart empties it. Seeding used to `continue` on any existing use case,
 * so nothing ever told the adapter again, and the two drifted apart silently.
 *
 * What that costs is a long way from where it happened. The next issue or
 * allowlist call fails inside the adapter with `simulated: unknown asset
 * 'fabric:invoice-tokenization'`, surfaced to the caller as a flat
 * REQUEST_FAILED — a use case that worked yesterday, on a deployment nobody
 * changed, with an error naming neither the restart nor the chain. In compose it
 * is worse than a dev annoyance: the API runs `restart: unless-stopped`, so an
 * ordinary container restart quietly breaks every simulated-chain use case.
 *
 * Redeploying is the honest repair because on these chains a deploy IS the
 * registration and nothing is lost by repeating it — unlike a real chain, where
 * redeploying would burn gas and orphan the live contract. So this is scoped to
 * chains the registry reports as `mode: "simulated"`, and every other chain's
 * recorded contract is left exactly as it is.
 */
async function redeployOnSimulatedChains(
  repo: UseCaseRepository,
  def: UseCaseDefinition,
  wiring: {
    availableChainIds: ReadonlySet<string>;
    simulatedChainIds?: ReadonlySet<string>;
    deploy: (def: UseCaseDefinition, chainId: string) => Promise<UseCaseContract>;
  },
): Promise<void> {
  const simulated = wiring.simulatedChainIds;
  if (!simulated || simulated.size === 0) return;

  // The STORED definition, not the config file: an operator may have edited this
  // use case, and re-deriving its contracts must not quietly revert those edits.
  const existing = await repo.get(def.key).catch(() => null);
  if (!existing) return;

  const targets = existing.allowedChainIds.filter((c) => simulated.has(c) && wiring.availableChainIds.has(c));
  if (targets.length === 0) return;

  const contracts: Record<string, UseCaseContract> = { ...(existing.contracts ?? {}) };
  let changed = false;
  for (const chainId of targets) {
    try {
      contracts[chainId] = await wiring.deploy(existing, chainId);
      changed = true;
    } catch (err) {
      // Best-effort, exactly like the first-time path: a simulated chain that
      // cannot re-register is left as it was rather than crashing boot.
      console.warn(`[use-cases] re-register of '${existing.key}' on simulated chain '${chainId}' failed: ${(err as Error).message}`);
    }
  }
  if (changed) await repo.update(existing.key, { ...existing, contracts });
}
