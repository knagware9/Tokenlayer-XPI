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
  explorerUrl?: string;
  currencySymbol?: string;
}

export interface PropertySchema {
  type: "string" | "number" | "boolean" | "document";
  description?: string;
  enum?: string[];
  min?: number;
  max?: number;
  pattern?: string;
}

export interface MetadataSchema {
  type: "object";
  properties: Record<string, PropertySchema>;
  required?: string[];
}

export interface UseCaseContract {
  contractRef: string;
  deployTxHash: string;
}

export interface UseCase {
  key: string;
  name: string;
  description?: string;
  tokenStandard: TokenStandard;
  tokenType: "fungible" | "nonfungible";
  symbol: string;
  allowedChainIds: string[];
  defaultChainId: string;
  /** Deployed contract per chainId; a chain is deployed iff it has an entry. */
  contracts?: Record<string, UseCaseContract>;
  metadataSchema: MetadataSchema;
  lifecycle: { mint: boolean; transfer: boolean; burn: boolean; freeze: boolean };
  compliance: {
    allowlist: boolean;
    transferRestrictions: boolean;
    maxHolders?: number;
    lockupDays?: number;
    allowedJurisdictions?: string[];
  };
  fees?: { marketplaceBps?: number; issuanceFlat?: string };
  saleTermsDefault?: { unitPrice?: string; currency?: string };
  /** How analytics values tokens with no unitPrice (e.g. invoice face value). */
  valuation?: { metadataField: string; currency: string };
  /** Metadata fields the platform derives on issue (client value ignored). */
  derivedFields?: Record<string, string>;
  /** A metadata field whose value must be unique across the use case's assets. */
  uniqueBy?: string;
  /** Financial terms template driving the cashflow schedule. */
  terms?: { principalField: string; maturityField: string; rateField?: string; frequency?: string; currency: string };
  /** Maker-checker policy: gated op → required approvals. */
  workflow?: { approvals?: Record<string, number> };
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

export interface Listing {
  id: string;
  /** Present on create/take responses; the asset-scoped list omits it. */
  assetId?: string;
  seller: string;
  /** REMAINING quantity on the listing. */
  quantity: string;
  unitPrice: string;
  currency: string;
  status?: "open" | "filled" | "cancelled";
  createdAt: string;
  updatedAt?: string;
}

export interface Cashflow {
  id: string;
  assetId: string;
  seq: number;
  kind: "coupon" | "redemption";
  dueDate: string;
  amount: string;
  currency: string;
  status: "scheduled" | "due" | "overdue" | "executing" | "executed";
  executedAt: string | null;
}

export interface CashflowPreview {
  cashflowId: string;
  split: { address: string; amount: string }[];
}

export interface Trade {
  at: string;
  amount: string | null;
  unitPrice: string | null;
  currency: string | null;
  from: string | null;
  to: string | null;
  secondary: boolean;
}

export interface ProposalApproval {
  userId: string;
  email: string;
  at: string;
}

/** A maker-checker proposal: a gated operation captured pending approval. */
export interface Proposal {
  id: string;
  useCaseKey: string;
  assetId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  proposerId: string;
  proposerLabel: string;
  required: number;
  approvals: ProposalApproval[];
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
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

export interface AnalyticsSummary {
  scope: "platform" | "use-case";
  useCaseKey: string | null;
  totals: {
    assets: number;
    useCases: number;
    holders: number;
    supply: string;
    valueByCurrency: Record<string, string>;
    tradedByCurrency: Record<string, string>;
    trades: number;
  };
  byLedger: { chainId: string; mode: "real" | "simulated"; assets: number; supply: string; holders: number }[];
  byUseCase: { useCaseKey: string; name: string; symbol: string; chainId: string; supply: string; holders: number; valueByCurrency: Record<string, string> }[];
  activity: { date: string; count: number; tradedByCurrency: Record<string, string> }[];
  recent: { at: string; action: string; assetId: string; assetName: string; chainId: string; summary: string }[];
}
