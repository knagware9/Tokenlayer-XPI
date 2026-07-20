import { describe, expect, it } from "vitest";
import { loadDefaultUseCaseDefinitions } from "../src/use-cases.js";

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
