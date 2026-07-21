import type { AccountState, ActivityEvent, AnalyticsSummary, Asset, AuditEntry, AuditSummary, AuditVerify, Cashflow, CashflowPreview, ChainInfo, ChainStatus, CompanyCategory, ContractCode, CredentialStatusInfo, CredentialTypeInfo, DidDocument, HeldCredential, IdentityRegistryInfo, IdentityResult, IssuedCredential, Listing, OrgMember, OrgType, Organization, Portfolio, Proposal, Role, SessionUser, TokenInfo, TokenStandard, Trade, UseCase, VerificationRequest, VerificationResult } from "./types.js";

export interface Currency { code: string; label: string; }
export interface CashBalance { currency: string; address: string; amount: string; }

const ORIGIN = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4000";
const BASE = `${ORIGIN}/api/v1`;

/** List endpoints return { data, pagination }; the dashboard only needs the rows. */
interface Listed<T> {
  data: T[];
  pagination: { limit: number; offset: number; total: number };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(body?.message ?? body?.error ?? res.statusText, res.status, body?.error);
  }
  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: SessionUser }>("/auth/login", null, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  // Public: an unauthenticated visitor self-registers their company. 202 → the org
  // (and its admin) are pending until a PlatformAdmin approves.
  registerOrg: (body: {
    company: {
      name: string; orgType: OrgType; cin: string; pan: string; gstin?: string;
      state: string; pincode: string; dateOfIncorporation: string;
      category: CompanyCategory; companyStatus: "active" | "inactive";
      documents: { cinCertificate: { id: string }; gstinCertificate?: { id: string } };
    };
    admin: { name: string; email: string; password: string };
  }) => request<{ organizationId: string; status: string }>("/orgs/register", null, { method: "POST", body: JSON.stringify(body) }),
  // Public: upload a KYB certificate before registering (no auth, throttled).
  uploadKybDocument: (contentType: string, dataBase64: string) =>
    request<{ id: string; sha256: string; size: number }>("/orgs/register/documents", null, { method: "POST", body: JSON.stringify({ contentType, dataBase64 }) }),
  // Authenticated raw download for the reviewer (returns a Blob, not JSON).
  downloadDocument: async (token: string, id: string): Promise<Blob> => {
    const res = await fetch(`${BASE}/documents/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text();
      let body: { message?: string; error?: string } | null = null;
      try { body = text ? (JSON.parse(text) as { message?: string; error?: string }) : null; } catch { /* non-JSON error body */ }
      throw new ApiError(body?.message ?? body?.error ?? res.statusText, res.status, body?.error);
    }
    return res.blob();
  },
  chains: (token: string) => request<ChainInfo[]>("/chains", token),
  chainStatus: (token: string, id: string) =>
    request<ChainStatus>(`/chains/${encodeURIComponent(id)}/status`, token),
  useCaseCode: (token: string, key: string, chainId: string) =>
    request<ContractCode>(`/use-cases/${encodeURIComponent(key)}/code?chainId=${encodeURIComponent(chainId)}`, token),
  previewCode: (token: string, body: { tokenStandard: TokenStandard; symbol: string; name: string; allowlist?: boolean; chainId: string }) =>
    request<ContractCode>("/use-cases/preview-code", token, { method: "POST", body: JSON.stringify(body) }),
  useCases: (token: string) => request<UseCase[]>("/use-cases", token),
  analytics: (token: string, opts: { useCaseKey?: string; days?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.useCaseKey) q.set("useCaseKey", opts.useCaseKey);
    if (opts.days) q.set("days", String(opts.days));
    const qs = q.toString();
    return request<AnalyticsSummary>(`/analytics${qs ? `?${qs}` : ""}`, token);
  },
  accounts: (token: string) => request<{ address: string; label: string }[]>("/accounts", token),
  // 201 → the UseCase; 202 (gated: an OrgAdmin proposes) → { proposal } pending platform approval.
  createUseCase: (token: string, def: UseCase) =>
    request<UseCase | { proposal: Proposal }>("/use-cases", token, { method: "POST", body: JSON.stringify(def) }),
  deployUseCase: (token: string, key: string, chainId: string) =>
    request<UseCase>(`/use-cases/${encodeURIComponent(key)}/deploy`, token, { method: "POST", body: JSON.stringify({ chainId }) }),
  assets: (token: string, useCaseKey?: string) =>
    request<Listed<Asset>>(`/assets?limit=200${useCaseKey ? `&useCaseKey=${encodeURIComponent(useCaseKey)}` : ""}`, token).then((r) => r.data),
  asset: (token: string, id: string) => request<Asset>(`/assets/${id}`, token),
  assetAccounts: (token: string, id: string) => request<AccountState[]>(`/assets/${id}/accounts`, token),
  assetTokens: (token: string, id: string) => request<TokenInfo[]>(`/assets/${id}/tokens`, token),
  audit: (token: string, id: string) => request<Listed<AuditEntry>>(`/assets/${id}/audit?limit=200`, token).then((r) => r.data),
  issue: (
    token: string,
    input: { useCaseKey: string; name: string; chainId: string; metadata: Record<string, unknown>; treasuryAccount?: string; initialSupply?: string; sale?: { unitPrice: string; currency: string; treasuryAccount: string } },
    // 201 → { asset }; 202 (maker-checker gated) → { proposal, asset }.
  ) => request<{ asset: Asset; txHash?: string; proposal?: Proposal }>("/assets", token, { method: "POST", body: JSON.stringify(input) }),
  action: (token: string, id: string, action: string, body: Record<string, string>) =>
    // 200 → { receipt }; 202 (gated) → { proposal }.
    request<{ receipt?: { txHash: string }; proposal?: Proposal }>(`/assets/${id}/actions/${action}`, token, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  uploadDocument: (token: string, contentType: string, dataBase64: string) =>
    request<{ id: string; url: string; sha256: string; size: number }>("/documents", token, { method: "POST", body: JSON.stringify({ contentType, dataBase64 }) }),
  currencies: (token: string) => request<Currency[]>("/currencies", token),
  cashBalances: (token: string, address: string) =>
    request<CashBalance[]>(`/cash/balances?address=${encodeURIComponent(address)}`, token),
  buy: (token: string, id: string, quantity: string) =>
    request<{ receipt: unknown; paid: { amount: string; currency: string }; delivered: { amount: string; to: string } }>(
      `/assets/${id}/buy`, token, { method: "POST", body: JSON.stringify({ quantity }) }),
  setPrice: (token: string, id: string, terms: { unitPrice: string; currency: string; treasuryAccount: string }) =>
    request<{ ok: boolean }>(`/assets/${id}/actions/setPrice`, token, { method: "POST", body: JSON.stringify(terms) }),
  listings: (token: string, assetId: string) => request<Listing[]>(`/assets/${assetId}/listings`, token),
  createListing: (token: string, assetId: string, input: { quantity: string; unitPrice: string; currency: string }) =>
    request<Listing>(`/assets/${assetId}/listings`, token, { method: "POST", body: JSON.stringify(input) }),
  takeListing: (token: string, listingId: string, quantity: string) =>
    request<{ listing: Listing; txHash: string; fee?: { amount: string; account: string } }>(
      `/listings/${listingId}/take`, token, { method: "POST", body: JSON.stringify({ quantity }) }),
  cancelListing: (token: string, listingId: string) =>
    request<void>(`/listings/${listingId}`, token, { method: "DELETE" }),
  trades: (token: string, assetId: string) => request<Trade[]>(`/assets/${assetId}/trades`, token),
  cashflows: (token: string, assetId: string) =>
    request<{ cashflows: Cashflow[]; preview: CashflowPreview | null }>(`/assets/${assetId}/cashflows`, token),
  executeCashflow: (token: string, assetId: string, cfId: string, from?: string) =>
    // 200 → { cashflow }; 202 (gated settlement) → { proposal }.
    request<{ cashflow?: Cashflow; proposal?: Proposal }>(`/assets/${assetId}/cashflows/${cfId}/execute`, token, { method: "POST", body: JSON.stringify(from ? { from } : {}) }),
  verifyAudit: (token: string, assetId: string) => request<AuditVerify>(`/assets/${assetId}/audit/verify`, token),
  auditSummary: (token: string) => request<AuditSummary>("/audit/verify", token),
  anchorAudit: (token: string) =>
    request<{ anchored: { assetId: string; seq: number; txHash: string }[] }>("/audit/anchor", token, { method: "POST", body: JSON.stringify({}) }),
  proposals: (token: string, status?: string) =>
    request<Proposal[]>(`/proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`, token),
  approveProposal: (token: string, id: string) =>
    request<{ proposal: Proposal }>(`/proposals/${id}/approve`, token, { method: "POST", body: JSON.stringify({}) }),
  rejectProposal: (token: string, id: string) =>
    request<{ proposal: Proposal }>(`/proposals/${id}/reject`, token, { method: "POST", body: JSON.stringify({}) }),
  creditCash: (token: string, account: string, currency: string, amount: string) =>
    request<{ ok: boolean; balance: string }>("/cash/credit", token, { method: "POST", body: JSON.stringify({ account, currency, amount }) }),
  users: (token: string) => request<{ id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null; active: boolean; kycStatus: "pending" | "approved" | "rejected"; kyc: { legalName?: string; country?: string; idType?: string; idNumber?: string; documentRef?: string } | null }[]>("/users", token),
  // 202 → { proposal }: non-org onboarding is gated; the user does not exist until it is approved.
  createUser: (token: string, input: { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; kyc?: { legalName?: string; country?: string; idType?: string; idNumber?: string; documentRef?: string } }) =>
    request<{ proposal: Proposal }>("/users", token, { method: "POST", body: JSON.stringify(input) }),
  // 202 → { proposal }: identity revocation is gated.
  revokeUserIdentity: (token: string, id: string, reason: string) =>
    request<{ proposal: Proposal }>(`/users/${encodeURIComponent(id)}/revoke-identity`, token, { method: "POST", body: JSON.stringify({ reason }) }),
  updateUser: (token: string, id: string, patch: { password?: string; active?: boolean; kycStatus?: "approved" | "rejected" }) =>
    request<{ id: string }>(`/users/${id}`, token, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteUser: (token: string, id: string) => request<void>(`/users/${id}`, token, { method: "DELETE" }),
  identityChallenge: (token: string, userId: string) => request<{ challenge: string; expiresAt: string }>(`/users/${userId}/identity/challenge`, token, { method: "POST", body: JSON.stringify({}) }),
  identityVerify: (token: string, userId: string, presentation: string) => request<IdentityResult>(`/users/${userId}/identity/verify`, token, { method: "POST", body: JSON.stringify({ presentation }) }),
  identityMint: (token: string, body: { subjectDid?: string; holderSeed?: string; claims: Record<string, unknown>; challenge: string }) => request<{ presentation: string; holderDid: string; issuerDid: string }>(`/identity/mint`, token, { method: "POST", body: JSON.stringify(body) }),
  mePortfolio: (token: string) => request<Portfolio>("/me/portfolio", token),
  meActivity: (token: string) => request<ActivityEvent[]>("/me/activity", token),
  orgs: (token: string) => request<Organization[]>("/orgs", token),
  // PlatformAdmin: the self-service registration queue and its decisions.
  pendingOrgs: (token: string) => request<Organization[]>("/orgs?status=pending", token),
  approveOrg: (token: string, id: string) =>
    request<Organization & { issuerDid: string | null; orgCredentialId: string | null }>(`/orgs/${encodeURIComponent(id)}/approve`, token, { method: "POST", body: JSON.stringify({}) }),
  rejectOrg: (token: string, id: string, reason: string) =>
    request<Organization>(`/orgs/${encodeURIComponent(id)}/reject`, token, { method: "POST", body: JSON.stringify({ reason }) }),
  createOrg: (token: string, body: { name: string; orgType: OrgType; registrationId?: string; jurisdiction?: string }) =>
    request<Organization>("/orgs", token, { method: "POST", body: JSON.stringify(body) }),
  org: (token: string, id: string) => request<Organization>(`/orgs/${encodeURIComponent(id)}`, token),
  orgMembers: (token: string, id: string) => request<OrgMember[]>(`/orgs/${encodeURIComponent(id)}/members`, token),
  createMember: (token: string, id: string, body: { email: string; password: string; role: string; useCaseKey?: string; walletAddress?: string }) =>
    request<{ id: string; did: string; membershipVc: boolean }>(`/orgs/${encodeURIComponent(id)}/users`, token, { method: "POST", body: JSON.stringify(body) }),
  myCredentials: (token: string) => request<HeldCredential[]>("/me/credentials", token),
  didDocument: (token: string, did: string) => request<DidDocument>(`/dids/${encodeURIComponent(did)}/document`, token),
  credentialTypes: (token: string) => request<CredentialTypeInfo[]>("/credential-types", token),
  // 202 → { proposal }: issuance is gated; nothing is issued until it is approved.
  requestCredential: (token: string, body: { type: string; subjectUserId: string; claims: Record<string, unknown>; issuerOrgId?: string }) =>
    request<{ proposal: Proposal }>("/credentials/requests", token, { method: "POST", body: JSON.stringify(body) }),
  orgCredentials: (token: string, orgId: string) => request<IssuedCredential[]>(`/orgs/${encodeURIComponent(orgId)}/credentials`, token),
  // 202 → { proposal }: revocation is gated too.
  revokeCredential: (token: string, id: string, reason: string) =>
    request<{ proposal: Proposal }>(`/credentials/${encodeURIComponent(id)}/revoke`, token, { method: "POST", body: JSON.stringify({ reason }) }),
  // null → no chain hosts the registry; credentials are issued unanchored.
  identityRegistry: (token: string) => request<IdentityRegistryInfo | null>("/registry", token),
  // Public: a verifier must be able to check a credential without an account.
  credentialStatus: (id: string) => request<CredentialStatusInfo>(`/credentials/${encodeURIComponent(id)}/status`, null),
  createVerificationRequest: (token: string, body: { holderDid: string; requestedTypes: string[]; purpose: string }) =>
    request<VerificationRequest>("/verification-requests", token, { method: "POST", body: JSON.stringify(body) }),
  myVerificationRequests: (token: string) => request<VerificationRequest[]>("/me/verification-requests", token),
  consentVerification: (token: string, id: string, credentialIds: string[]) =>
    request<VerificationRequest>(`/verification-requests/${encodeURIComponent(id)}/consent`, token, { method: "POST", body: JSON.stringify({ credentialIds }) }),
  rejectVerification: (token: string, id: string) =>
    request<VerificationRequest>(`/verification-requests/${encodeURIComponent(id)}/reject`, token, { method: "POST", body: JSON.stringify({}) }),
  verifyVerification: (token: string, id: string) => request<VerificationResult>(`/verification-requests/${encodeURIComponent(id)}/verify`, token),
};
