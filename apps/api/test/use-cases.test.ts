import { describe, expect, it } from "vitest";
import type { UseCaseDefinition } from "@tokenlayer/core";
import { loadDefaultUseCaseDefinitions, seedUseCases } from "../src/tokenization/use-cases.js";
import type { UseCaseRepository } from "../src/persistence/types/index.js";

describe("loadDefaultUseCaseDefinitions", () => {
  // Regression: the loader must normalise (fill derived fields) — not just
  // JSON.parse — because seedUseCases deploys straight from these definitions and
  // the Fabric adapter passes tokenType to chaincode as a raw arg. An undefined
  // tokenType crashed Fabric deploy for EVERY use case (Cannot read properties of
  // undefined (reading 'toString')) while EVM silently tolerated it.
  it("fills the derived tokenType on every default use case", () => {
    const defs = loadDefaultUseCaseDefinitions();
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      expect(def.tokenType, `${def.key} missing tokenType`).toBeDefined();
      expect(["fungible", "nonfungible"]).toContain(def.tokenType);
    }
  });

  it("derives tokenType from tokenStandard (ERC-20 → fungible)", () => {
    const invoice = loadDefaultUseCaseDefinitions().find((d) => d.key === "invoice-tokenization");
    expect(invoice?.tokenStandard).toBe("ERC-20");
    expect(invoice?.tokenType).toBe("fungible");
  });
});

/**
 * THE RESTART THAT SILENTLY BREAKS A SIMULATED CHAIN.
 *
 * Found by running the container stack twice: an ordinary API restart left every
 * simulated-chain use case unusable, failing deep inside the adapter with
 * `simulated: unknown asset 'fabric:carbon-credit'` and reaching the caller as a
 * flat REQUEST_FAILED. The database had the contract; the in-memory ledger did
 * not; nothing reconciled them because seeding skipped any use case that already
 * existed.
 *
 * The pair of tests below is the point. Re-registering on a simulated chain is
 * necessary, and NOT re-deploying on a real one is equally necessary — a fix
 * that redeployed everything would pass the first test while burning gas and
 * orphaning live contracts on every boot.
 */
describe("seedUseCases re-registers simulated chains after a restart", () => {
  const fakeRepo = (stored: Map<string, UseCaseDefinition>): UseCaseRepository => ({
    has: async (key) => stored.has(key),
    get: async (key) => {
      const d = stored.get(key);
      if (!d) throw new Error(`no use case '${key}'`);
      return d;
    },
    list: async () => [...stored.values()],
    create: async (def) => { stored.set(def.key, def); return def; },
    update: async (key, def) => { stored.set(key, def); return def; },
  });

  /** A use case already in the database, as it would be after a first boot. */
  const seeded = (key: string, allowedChainIds: string[]): UseCaseDefinition =>
    ({
      ...loadDefaultUseCaseDefinitions()[0]!,
      key,
      allowedChainIds,
      contracts: Object.fromEntries(allowedChainIds.map((c) => [c, { address: `0xOLD-${c}` }])),
    }) as UseCaseDefinition;

  it("re-deploys an EXISTING use case on a simulated chain (the restart repair)", async () => {
    const stored = new Map<string, UseCaseDefinition>();
    const defs = loadDefaultUseCaseDefinitions();
    for (const d of defs) stored.set(d.key, seeded(d.key, ["fabric"]));

    const deployed: string[] = [];
    await seedUseCases(fakeRepo(stored), {
      availableChainIds: new Set(["fabric"]),
      simulatedChainIds: new Set(["fabric"]),
      deploy: async (def, chainId) => { deployed.push(`${def.key}:${chainId}`); return { address: `0xNEW-${chainId}` }; },
    });

    // Every seeded use case is re-registered, not skipped.
    expect(deployed.length).toBe(defs.length);
    expect(deployed.every((d) => d.endsWith(":fabric"))).toBe(true);
    // …and the refreshed contract is persisted, so reads agree with the ledger.
    expect(stored.get(defs[0]!.key)?.contracts?.fabric).toEqual({ address: "0xNEW-fabric" });
  });

  it("does NOT re-deploy on a REAL chain — that would burn gas and orphan the contract", async () => {
    const stored = new Map<string, UseCaseDefinition>();
    for (const d of loadDefaultUseCaseDefinitions()) stored.set(d.key, seeded(d.key, ["besu"]));

    const deployed: string[] = [];
    await seedUseCases(fakeRepo(stored), {
      availableChainIds: new Set(["besu"]),
      simulatedChainIds: new Set(["fabric"]), // besu is real
      deploy: async (def, chainId) => { deployed.push(`${def.key}:${chainId}`); return { address: "0xNEW" }; },
    });

    expect(deployed).toEqual([]);
    // The recorded on-chain address is untouched.
    expect(stored.get([...stored.keys()][0]!)?.contracts?.besu).toEqual({ address: "0xOLD-besu" });
  });

  it("leaves everything alone when the caller names no simulated chains", async () => {
    // Back-compat: the old two-field wiring must behave exactly as before.
    const stored = new Map<string, UseCaseDefinition>();
    for (const d of loadDefaultUseCaseDefinitions()) stored.set(d.key, seeded(d.key, ["fabric"]));
    const deployed: string[] = [];
    await seedUseCases(fakeRepo(stored), {
      availableChainIds: new Set(["fabric"]),
      deploy: async (def, chainId) => { deployed.push(`${def.key}:${chainId}`); return { address: "0xNEW" }; },
    });
    expect(deployed).toEqual([]);
  });
});
