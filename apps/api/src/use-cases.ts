import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeUseCaseDefinition, type UseCaseContract, type UseCaseDefinition } from "@tokenlayer/core";
import { coded } from "./executors.js";
import type { UseCaseRepository } from "./persistence/types.js";

/** Absolute path to the repo's declarative use-case config directory. */
const USE_CASE_DIR = fileURLToPath(new URL("../../../config/use-cases", import.meta.url));

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
    deploy: (def: UseCaseDefinition, chainId: string) => Promise<UseCaseContract>;
  },
): Promise<void> {
  for (const def of loadDefaultUseCaseDefinitions()) {
    if (await repo.has(def.key)) continue;
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
