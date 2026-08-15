/**
 * Renders the contract code that backs a use case on one chain family — the
 * REAL artifact where one exists (EVM: the bundled Solidity source that
 * EvmLedgerAdapter deploys), and a truthful contract model for the simulated
 * families (Fabric/Canton). Used by GET /use-cases/:key/code and
 * POST /use-cases/preview-code; routes stay thin.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { coded } from "../shared/executors.js";

/** The bundled Solidity source per token standard — the exact files compiled into
 * the artifacts that EvmLedgerAdapter deploys. */
const EVM_SOURCES: Record<string, string> = {
  "ERC-20": "ComplianceToken.sol",
  "ERC-721": "ComplianceNFT.sol",
  "ERC-3643": "ComplianceToken3643.sol",
};

const solPath = (file: string): string =>
  fileURLToPath(new URL(`../../../../packages/contracts/contracts/${file}`, import.meta.url));

export interface RenderedContractCode {
  language: string;
  filename: string;
  source: string;
  /** Constructor/instantiation arguments, mirrored from what the adapter actually passes. */
  constructorArgs: { name: string; value: string }[];
}

export interface RenderContractCodeInput {
  tokenStandard: string;
  symbol: string;
  name: string;
  allowlist: boolean;
  chainFamily: string;
  mode: "real" | "simulated";
}

export function renderContractCode(input: RenderContractCodeInput): RenderedContractCode {
  if (!(input.tokenStandard in EVM_SOURCES)) {
    throw coded(400, "UNKNOWN_TOKEN_STANDARD", `unknown token standard '${input.tokenStandard}' — expected one of: ${Object.keys(EVM_SOURCES).join(", ")}`);
  }
  switch (input.chainFamily) {
    case "evm":
      return renderEvm(input);
    case "fabric":
    case "mock": // the generic simulated family shares the fabric contract model
      return renderFabric(input);
    case "canton":
      return renderCanton(input);
    default:
      throw coded(400, "UNKNOWN_CHAIN_FAMILY", `no contract code renderer for chain family '${input.chainFamily}'`);
  }
}

/**
 * EVM: the real bundled `.sol` for the standard. constructorArgs mirror
 * EvmLedgerAdapter.deployAsset exactly: ERC-20/721 deploy the artifact with
 * `(name, symbol, allowlistEnabled)`; ERC-3643 deploys the official T-REX suite
 * via `deploySuite(name, symbol)` (allowlisting is identity-registry based).
 */
function renderEvm(input: RenderContractCodeInput): RenderedContractCode {
  // Presence checked by renderContractCode before dispatch.
  const filename = EVM_SOURCES[input.tokenStandard] as string;
  const source = readFileSync(solPath(filename), "utf8");
  const constructorArgs =
    input.tokenStandard === "ERC-3643"
      ? [
          { name: "name", value: input.name },
          { name: "symbol", value: input.symbol },
        ]
      : [
          { name: "name", value: input.name },
          { name: "symbol", value: input.symbol },
          { name: "allowlistEnabled", value: String(input.allowlist) },
        ];
  return { language: "solidity", filename, source, constructorArgs };
}

/**
 * Fabric: the contract-state model the platform runs — a truthful excerpt of the
 * SimulatedAdapter/SimulatedLedger semantics (packages/adapters/src). On a real
 * network the chaincode equivalent implements this same interface.
 */
function renderFabric(input: RenderContractCodeInput): RenderedContractCode {
  const header =
    input.mode === "real"
      ? `// Fabric contract model for '${input.name}' (${input.symbol}) — the deployed
// chaincode implements this interface; the platform drives it via the Fabric Gateway.`
      : `// Simulated Fabric contract model for '${input.name}' (${input.symbol}) — a real
// network runs the chaincode equivalent. This is the exact in-memory state machine
// the platform executes (SimulatedAdapter -> SimulatedLedger), mirroring the
// on-chain compliance contracts' rules.`;
  const source = `${header}

interface AssetState {
  tokenType: "fungible" | "nonfungible";
  allowlistEnabled: boolean;            // ${input.allowlist ? "ON for this use case" : "OFF for this use case"}
  balances: Map<string, bigint>;        // fungible holdings
  supply: bigint;
  owners: Map<string, string>;          // tokenId -> owner (non-fungible)
  uris: Map<string, string>;
  frozen: Set<string>;                  // freeze list — blocks mint/transfer
  allowed: Set<string>;                 // allowlist — required when allowlistEnabled
}

class ContractStateMachine {
  private readonly assets = new Map<string, AssetState>();

  /** Deploy: contractRef = "<chainId>:<useCaseKey>". */
  create(contractRef: string, tokenType: "fungible" | "nonfungible", allowlistEnabled: boolean): void;

  // --- fungible (${input.symbol}) -----------------------------------------
  // mint: rejects non-allowlisted (when enabled) and frozen recipients.
  mint(ref: string, to: string, amount: string): void;
  // transfer: operator-mediated; both parties must be unfrozen and (when
  // allowlistEnabled) allowlisted; balance-checked.
  transfer(ref: string, from: string, to: string, amount: string): void;
  // burn: balance-checked; reduces supply.
  burn(ref: string, from: string, amount: string): void;
  balanceOf(ref: string, account: string): string;
  totalSupply(ref: string): string;

  // --- non-fungible --------------------------------------------------------
  mintToken(ref: string, to: string, tokenId: string, uri?: string): void;
  transferToken(ref: string, from: string, to: string, tokenId: string): void;
  burnToken(ref: string, tokenId: string): void;

  // --- compliance ----------------------------------------------------------
  setFrozen(ref: string, account: string, frozen: boolean): void;
  setAllowed(ref: string, account: string, allowed: boolean): void;
  isFrozen(ref: string, account: string): boolean;
  isAllowed(ref: string, account: string): boolean;
}
`;
  return {
    language: "typescript",
    filename: "simulated-fabric-contract.ts",
    source,
    constructorArgs: [
      { name: "tokenType", value: input.tokenStandard === "ERC-721" ? "nonfungible" : "fungible" },
      { name: "allowlistEnabled", value: String(input.allowlist) },
    ],
  };
}

/**
 * Canton: a DAML-style template sketch with the same operator-mediated semantics
 * as the simulated ledger (which is what actually runs when the chain is simulated).
 */
function renderCanton(input: RenderContractCodeInput): RenderedContractCode {
  const note =
    input.mode === "real"
      ? `-- Canton template model for '${input.name}' (${input.symbol}) — the deployed
-- DAML package implements this interface via the JSON API.`
      : `-- Simulated Canton contract model for '${input.name}' (${input.symbol}) — a real
-- Canton network runs the DAML equivalent; the platform currently executes these
-- semantics on its in-memory simulated ledger.`;
  const source = `${note}

module TokenModel where

template Holding
  with
    operator     : Party      -- the platform: sole transfer agent
    owner        : Party
    symbol       : Text       -- "${input.symbol}"
    amount       : Decimal
    frozen       : Bool       -- freeze list: blocks Move/Mint when True
    allowlisted  : Bool       -- required when the use case enables the allowlist (${input.allowlist ? "enabled" : "disabled"})
  where
    signatory operator
    observer owner

    choice Mint : ContractId Holding
      with qty : Decimal
      controller operator
      do assertMsg "not allowlisted" (${input.allowlist ? "allowlisted" : "True"})
         assertMsg "account frozen" (not frozen)
         create this with amount = amount + qty

    choice Move : ContractId Holding
      with to : Party; qty : Decimal
      controller operator
      do assertMsg "account frozen" (not frozen)
         assertMsg "insufficient balance" (amount >= qty)
         create this with owner = to, amount = qty

    choice Burn : ContractId Holding
      with qty : Decimal
      controller operator
      do assertMsg "insufficient balance" (amount >= qty)
         create this with amount = amount - qty

    choice SetFrozen : ContractId Holding
      with value : Bool
      controller operator
      do create this with frozen = value

    choice SetAllowed : ContractId Holding
      with value : Bool
      controller operator
      do create this with allowlisted = value
`;
  return {
    language: "daml",
    filename: "TokenModel.daml",
    source,
    constructorArgs: [
      { name: "symbol", value: input.symbol },
      { name: "allowlisted", value: String(input.allowlist) },
    ],
  };
}
