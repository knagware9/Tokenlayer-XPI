import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InterfaceAbi } from "ethers";

export interface Artifact {
  abi: InterfaceAbi;
  bytecode: string;
}

/** Root of the contracts package's Hardhat artifacts output. */
const ARTIFACTS_ROOT = new URL("../../../contracts/artifacts/", import.meta.url);

/** Loads a Hardhat artifact by its source path, e.g. "@onchain-id/solidity/contracts/Identity.sol:Identity". */
export function loadByPath(sourcePath: string, contract: string): Artifact {
  const url = new URL(`${sourcePath}/${contract}.json`, ARTIFACTS_ROOT);
  const json = JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as { abi: InterfaceAbi; bytecode: string };
  return { abi: json.abi, bytecode: json.bytecode };
}

const T = "@tokenysolutions/t-rex/contracts";
const O = "@onchain-id/solidity/contracts";

/** All vendor artifacts needed to stand up a T-REX suite. */
export function loadTrexArtifacts(): Record<string, Artifact> {
  return {
    Identity: loadByPath(`${O}/Identity.sol`, "Identity"),
    ClaimIssuer: loadByPath(`${O}/ClaimIssuer.sol`, "ClaimIssuer"),
    IdFactory: loadByPath(`${O}/factory/IdFactory.sol`, "IdFactory"),
    OidImplementationAuthority: loadByPath(`${O}/proxy/ImplementationAuthority.sol`, "ImplementationAuthority"),
    ClaimTopicsRegistry: loadByPath(`${T}/registry/implementation/ClaimTopicsRegistry.sol`, "ClaimTopicsRegistry"),
    TrustedIssuersRegistry: loadByPath(`${T}/registry/implementation/TrustedIssuersRegistry.sol`, "TrustedIssuersRegistry"),
    IdentityRegistryStorage: loadByPath(`${T}/registry/implementation/IdentityRegistryStorage.sol`, "IdentityRegistryStorage"),
    IdentityRegistry: loadByPath(`${T}/registry/implementation/IdentityRegistry.sol`, "IdentityRegistry"),
    ModularCompliance: loadByPath(`${T}/compliance/modular/ModularCompliance.sol`, "ModularCompliance"),
    Token: loadByPath(`${T}/token/Token.sol`, "Token"),
    TREXImplementationAuthority: loadByPath(`${T}/proxy/authority/TREXImplementationAuthority.sol`, "TREXImplementationAuthority"),
    ClaimTopicsRegistryProxy: loadByPath(`${T}/proxy/ClaimTopicsRegistryProxy.sol`, "ClaimTopicsRegistryProxy"),
    TrustedIssuersRegistryProxy: loadByPath(`${T}/proxy/TrustedIssuersRegistryProxy.sol`, "TrustedIssuersRegistryProxy"),
    IdentityRegistryStorageProxy: loadByPath(`${T}/proxy/IdentityRegistryStorageProxy.sol`, "IdentityRegistryStorageProxy"),
    IdentityRegistryProxy: loadByPath(`${T}/proxy/IdentityRegistryProxy.sol`, "IdentityRegistryProxy"),
    ModularComplianceProxy: loadByPath(`${T}/proxy/ModularComplianceProxy.sol`, "ModularComplianceProxy"),
    TokenProxy: loadByPath(`${T}/proxy/TokenProxy.sol`, "TokenProxy"),
    CountryAllowModule: loadByPath(`${T}/compliance/modular/modules/CountryAllowModule.sol`, "CountryAllowModule"),
  };
}
