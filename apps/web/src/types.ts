export type Role = "PlatformAdmin" | "UseCaseAdmin" | "Issuer" | "Trader" | "Buyer" | "Auditor";

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  useCaseKey: string | null;
  walletAddress?: string | null;
}

export type TokenStandard = "ERC-20" | "ERC-721" | "ERC-3643";
export type ChainFamily = "evm" | "fabric" | "canton" | "mock";

export interface ChainInfo {
  id: string;
  label: string;
  family: ChainFamily;
  kind: "simulated" | "evm";
  mode: "real" | "simulated";
}

export interface PropertySchema {
  type: "string" | "number" | "boolean";
  description?: string;
}

export interface MetadataSchema {
  type: "object";
  properties: Record<string, PropertySchema>;
  required?: string[];
}

export interface UseCase {
  key: string;
  name: string;
  description?: string;
  tokenStandard: TokenStandard;
  tokenType: "fungible" | "nonfungible";
  allowedChainIds: string[];
  defaultChainId: string;
  metadataSchema: MetadataSchema;
  lifecycle: { mint: boolean; transfer: boolean; burn: boolean; freeze: boolean };
  compliance: { allowlist: boolean; transferRestrictions: boolean };
  roles: Role[];
}

export interface Asset {
  id: string;
  useCaseKey: string;
  name: string;
  symbol: string;
  chainId: string;
  contractRef: string;
  tokenType: "fungible" | "nonfungible";
  tokenStandard: TokenStandard;
  metadata: Record<string, unknown>;
  status: string;
  createdBy: string;
  createdAt: string;
  totalSupply?: string | null;
  availableSupply?: string | null;
  unitPrice?: string | null;
  currency?: string | null;
  treasuryAccount?: string | null;
}

export interface TokenInfo {
  tokenId: string;
  owner: string;
  ownerLabel: string;
  frozen: boolean;
}

export interface AccountState {
  address: string;
  label: string;
  balance: string;
  frozen: boolean;
  allowed: boolean;
}

export interface AuditEntry {
  id: string;
  assetId?: string;
  actorId: string;
  action: string;
  payload: Record<string, unknown>;
  txHash?: string;
  chainId?: string;
  createdAt: string;
}
