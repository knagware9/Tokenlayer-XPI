import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InterfaceAbi } from "ethers";

export interface ComplianceArtifact {
  abi: InterfaceAbi;
  bytecode: string;
}

/**
 * Loads a compiled contract artifact from the contracts package by name.
 * Requires `pnpm --filter @tokenlayer/contracts build` to have run first.
 */
export function loadArtifact(contractName: string): ComplianceArtifact {
  const url = new URL(
    `../../../contracts/artifacts/contracts/${contractName}.sol/${contractName}.json`,
    import.meta.url,
  );
  const json = JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as { abi: InterfaceAbi; bytecode: string };
  return { abi: json.abi, bytecode: json.bytecode };
}

/** Convenience loader for the ERC-20 ComplianceToken. */
export function loadComplianceArtifact(): ComplianceArtifact {
  return loadArtifact("ComplianceToken");
}
