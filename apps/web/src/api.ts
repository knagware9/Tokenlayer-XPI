import type { ResourceMode } from "./lib/modes.js";
import type { AccountState, ActivityEvent, AnalyticsSummary, ApiKeyView, Asset, AuditEntry, AuditSummary, AuditVerify, Cashflow, CashflowPreview, ChainInfo, ChainStatus, CompanyCategory, ContractCode, CredentialStatusInfo, CredentialTypeInfo, CredentialTypeSpec, CredentialUseCase, DidDocument, EligibleHolder, HeldCredential, IdentityDashboardData, IdentityRegistryInfo, IdentityResult, InvoiceRowResult, IssuedCredential, Listing, LoginKeyInfo, MintedApiKey, MintedWebhook, OrgCapabilities, OrgMember, OrgType, Organization, PlatformEvent, Portfolio, ProvisionResult, Proposal, QrLoginPoll, QrLoginStart, Role, SessionPrincipal, SessionUser, StagedInvoice, TokenInfo, TokenStandard, TokenizeResult, Trade, UseCase, UseCaseTemplate, UseCaseTemplateMeta, VerificationRequest, VerificationResult, WebhookDelivery, WebhookEndpoint } from "./types.js";

export interface Currency { code: string; label: string; }
export interface CashBalance { currency: string; address: string; amount: string; }

const ORIGIN = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4000";
const BASE = `${ORIGIN}/api/v1`;

/** The versioned API root, exported so a surface can SHOW an integrator a real
 *  URL to call (the Developers page's curl snippet) rather than a fake one. */
export const API_BASE = BASE;

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
    /** The parsed error body, when the server returned JSON. Lets callers read
     * structured detail such as a 400's `problems: string[]` list. */
    readonly body?: unknown,
  ) {
    super(message);
  }

  /** Convenience accessor for a validation-style `problems` array on the body. */
  get problems(): string[] | undefined {
    const p = (this.body as { problems?: unknown } | null | undefined)?.problems;
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : undefined;
  }

  /** Convenience accessor for a batch 400's `problems: { index, error }[]` (BATCH_INVALID) — a
   * different shape from the string-array `problems` above, so it gets its own getter. */
  get rowProblems(): { index: number; error: string }[] | undefined {
    const p = (this.body as { problems?: unknown } | null | undefined)?.problems;
    if (!Array.isArray(p)) return undefined;
    const rows = p.filter((x): x is { index: number; error: string } => typeof x === "object" && x !== null && typeof (x as { index?: unknown }).index === "number" && typeof (x as { error?: unknown }).error === "string");
    return rows.length > 0 ? rows : undefined;
  }
}

/** Friendlier copy for error codes worth explaining beyond the raw API message. */
const FRIENDLY_ERROR_MESSAGES: Record<string, string> = {
  IDENTITY_NOT_VERIFIED: "This asset requires a verified DID/VC identity — you need a valid KYC credential to participate.",
};

/** Renders a caught error for display: known codes get friendlier copy, other
 * ApiErrors show `code: message`, anything else falls back to a generic message. */
export function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const friendly = err.code ? FRIENDLY_ERROR_MESSAGES[err.code] : undefined;
    if (friendly) return friendly;
    return `${err.code ?? "Error"}: ${err.message}`;
  }
  return fallback;
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
    throw new ApiError(body?.message ?? body?.error ?? res.statusText, res.status, body?.error, body);
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
    /** EN-A: the requested capability envelope. OMIT the key for an unrestricted
     * legacy org — an explicit null is rejected by the request schema. */
    capabilities?: OrgCapabilities;
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
  /** Render a DRAFT certificate design. Returns a PDF Blob, always stamped SAMPLE. */
  previewCertificate: async (
    token: string,
    body: { credentialType: unknown; sampleClaims?: Record<string, unknown> },
  ): Promise<Blob> => {
    const res = await fetch(`${BASE}/credential-use-cases/preview-certificate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: { message?: string; error?: string } | null = null;
      try { parsed = text ? (JSON.parse(text) as { message?: string; error?: string }) : null; } catch { /* non-JSON error body */ }
      throw new ApiError(parsed?.message ?? parsed?.error ?? res.statusText, res.status, parsed?.error);
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
  // EN-D2: sandbox use cases are OUT of the aggregate unless `includeSandbox` is
  // passed — a simulated asset inside a real supply total is a reporting defect
  // nobody catches. The flag is ignored for an API key (its environment is fixed
  // by its own mode), so it only ever means anything for a human session.
  analytics: (token: string, opts: { useCaseKey?: string; days?: number; includeSandbox?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.useCaseKey) q.set("useCaseKey", opts.useCaseKey);
    if (opts.days) q.set("days", String(opts.days));
    if (opts.includeSandbox) q.set("includeSandbox", "true");
    const qs = q.toString();
    return request<AnalyticsSummary>(`/analytics${qs ? `?${qs}` : ""}`, token);
  },
  // Same sandbox exclusion as `/analytics`, and for the same reason.
  identityDashboard: (token: string, includeSandbox = false) =>
    request<IdentityDashboardData>(`/identity/dashboard${includeSandbox ? "?includeSandbox=true" : ""}`, token),
  accounts: (token: string) => request<{ address: string; label: string }[]>("/accounts", token),
  // 201 → the UseCase; 202 (gated: an OrgAdmin proposes) → { proposal } pending platform approval.
  createUseCase: (token: string, def: UseCase) =>
    request<UseCase | { proposal: Proposal }>("/use-cases", token, { method: "POST", body: JSON.stringify(def) }),
  // EN-D2: THE SUPPORTED WAY OUT OF THE SANDBOX. `sandbox` cannot be changed on
  // an existing use case (409 SANDBOX_IMMUTABLE), so this copies a sandbox one's
  // CONFIGURATION — schema, lifecycle, compliance, fees — and NO data: no
  // assets, holders, staged invoices, proposals or events come with it, and the
  // clone starts undeployed. Governance is POST /use-cases's verbatim: 201 for a
  // PlatformAdmin, 202 → { proposal } for an OrgAdmin.
  //
  // SESSION ONLY. The act spans both environments, so an API key of EITHER mode
  // is refused with 403 WRONG_MODE — which is why this console offers it and an
  // integration cannot script it.
  cloneUseCaseToLive: (token: string, key: string, body: { key?: string; allowedChainIds: string[]; defaultChainId?: string }) =>
    request<UseCase | { proposal: Proposal; key: string; clonedFrom: string }>(
      `/use-cases/${encodeURIComponent(key)}/clone-to-live`, token, { method: "POST", body: JSON.stringify(body) }),
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
  // 202 → { proposal } (one proposal covering the whole batch); 400 BATCH_INVALID → { error, message, problems }.
  onboardUsersBatch: (token: string, rows: unknown[]) =>
    request<{ proposal: Proposal }>("/users/batch", token, { method: "POST", body: JSON.stringify({ rows }) }),
  // 202 → { proposal }: identity revocation is gated.
  revokeUserIdentity: (token: string, id: string, reason: string) =>
    request<{ proposal: Proposal }>(`/users/${encodeURIComponent(id)}/revoke-identity`, token, { method: "POST", body: JSON.stringify({ reason }) }),
  updateUser: (token: string, id: string, patch: { password?: string; active?: boolean; kycStatus?: "approved" | "rejected" }) =>
    request<{ id: string }>(`/users/${id}`, token, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteUser: (token: string, id: string) => request<void>(`/users/${id}`, token, { method: "DELETE" }),
  identityChallenge: (token: string, userId: string) => request<{ challenge: string; expiresAt: string }>(`/users/${userId}/identity/challenge`, token, { method: "POST", body: JSON.stringify({}) }),
  identityVerify: (token: string, userId: string, presentation: string) => request<IdentityResult>(`/users/${userId}/identity/verify`, token, { method: "POST", body: JSON.stringify({ presentation }) }),
  identityMint: (token: string, body: { subjectDid?: string; holderSeed?: string; claims: Record<string, unknown>; challenge: string }) => request<{ presentation: string; holderDid: string; issuerDid: string }>(`/identity/mint`, token, { method: "POST", body: JSON.stringify(body) }),
  // The live session principal. Returns LESS than SessionUser (no email/orgId/
  // did/walletAddress) — callers merge it over the stored user, never replace.
  me: (token: string) => request<SessionPrincipal>("/me", token),
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
  // EN-A capability envelope. PATCH is the PlatformAdmin's direct grant (`null`
  // clears back to unrestricted legacy); the request route is the OrgAdmin's
  // 202 → { proposal } path, applied only once a PlatformAdmin approves it.
  setOrgCapabilities: (token: string, id: string, capabilities: OrgCapabilities | null) =>
    request<Organization>(`/orgs/${encodeURIComponent(id)}/capabilities`, token, { method: "PATCH", body: JSON.stringify({ capabilities }) }),
  requestOrgCapabilities: (token: string, id: string, capabilities: OrgCapabilities) =>
    request<{ proposal: Proposal }>(`/orgs/${encodeURIComponent(id)}/capabilities/request`, token, { method: "POST", body: JSON.stringify({ capabilities }) }),
  orgMembers: (token: string, id: string) => request<OrgMember[]>(`/orgs/${encodeURIComponent(id)}/members`, token),
  createMember: (token: string, id: string, body: { email: string; password: string; role: string; useCaseKey?: string; walletAddress?: string }) =>
    request<{ id: string; did: string; membershipVc: boolean }>(`/orgs/${encodeURIComponent(id)}/users`, token, { method: "POST", body: JSON.stringify(body) }),
  // EN-B machine API access. `createApiKey`/`rotateApiKey` are the ONLY calls in
  // this app that ever see a key secret, and it is in the response body alone —
  // no read route returns it and nothing here stores it.
  listApiKeys: (token: string, orgId: string) =>
    request<ApiKeyView[]>(`/orgs/${encodeURIComponent(orgId)}/api-keys`, token),
  // `mode` (EN-D2) picks the ENVIRONMENT the key acts in and is fixed at
  // creation — rotation preserves it and no route moves a key between the two.
  // Omitted means `live`, the server's own default. Binding a key to a use case
  // in the other environment is refused with 403 WRONG_MODE.
  createApiKey: (token: string, orgId: string, body: { name: string; role: Role; useCaseKey?: string; scopes: string[]; expiresAt?: string; mode?: ResourceMode }) =>
    // 201 → { key, secret }.
    request<MintedApiKey>(`/orgs/${encodeURIComponent(orgId)}/api-keys`, token, { method: "POST", body: JSON.stringify(body) }),
  rotateApiKey: (token: string, orgId: string, keyId: string) =>
    // 200 → { key, secret }: a NEW secret; the previous one stops working at once.
    request<MintedApiKey>(`/orgs/${encodeURIComponent(orgId)}/api-keys/${encodeURIComponent(keyId)}/rotate`, token, { method: "POST", body: "{}" }),
  revokeApiKey: (token: string, orgId: string, keyId: string) =>
    // 200 → { key }: a SOFT revoke — the row stays as the audit trail.
    request<{ key: ApiKeyView }>(`/orgs/${encodeURIComponent(orgId)}/api-keys/${encodeURIComponent(keyId)}`, token, { method: "DELETE" }),
  // EN-C webhooks. `createWebhook`/`rotateWebhookSecret` are the only calls that
  // ever see a signing secret; no read route returns it and nothing here stores
  // it. Unlike the api-key routes above, every webhook route answers with a
  // NAMED ENVELOPE (`{ endpoints }`, `{ endpoint }`, `{ deliveries }`), so each
  // wrapper unwraps it — callers get the row(s) and never the envelope.
  listWebhooks: (token: string, orgId: string) =>
    request<{ endpoints: WebhookEndpoint[] }>(`/orgs/${encodeURIComponent(orgId)}/webhooks`, token).then((r) => r.endpoints),
  // `mode` (EN-D2) picks which stream the endpoint joins and is FIXED at
  // registration — there is no PATCH for it, which is why `updateWebhook` below
  // does not offer one. Omitted means `live`, the server's own default.
  createWebhook: (token: string, orgId: string, body: { url: string; description?: string; eventTypes: string[]; useCaseKey?: string; mode?: ResourceMode }) =>
    // 201 → { endpoint, secret }. 400 INVALID_WEBHOOK_URL when the URL fails the
    // SSRF guard; 403 ORG_CAPABILITY_MISSING when a type is outside the envelope.
    request<MintedWebhook>(`/orgs/${encodeURIComponent(orgId)}/webhooks`, token, { method: "POST", body: JSON.stringify(body) }),
  updateWebhook: (token: string, orgId: string, whId: string, body: { url?: string; description?: string | null; eventTypes?: string[]; useCaseKey?: string | null; status?: "active" | "disabled" }) =>
    // 200 → { endpoint }. `status: "active"` is the RE-ENABLE: the server clears
    // disabledReason/disabledAt and resets both failure counters and failingSince.
    request<{ endpoint: WebhookEndpoint }>(`/orgs/${encodeURIComponent(orgId)}/webhooks/${encodeURIComponent(whId)}`, token, { method: "PATCH", body: JSON.stringify(body) })
      .then((r) => r.endpoint),
  rotateWebhookSecret: (token: string, orgId: string, whId: string) =>
    // 200 → { endpoint, secret }: a NEW signing secret with NO overlap window —
    // the previous one stops signing anything the moment this returns.
    request<MintedWebhook>(`/orgs/${encodeURIComponent(orgId)}/webhooks/${encodeURIComponent(whId)}/rotate`, token, { method: "POST", body: "{}" }),
  deleteWebhook: (token: string, orgId: string, whId: string) =>
    // 200 → { endpoint }: a SOFT delete. The row stays so its delivery history
    // keeps a destination to point at, but it stops matching new events at once.
    request<{ endpoint: WebhookEndpoint }>(`/orgs/${encodeURIComponent(orgId)}/webhooks/${encodeURIComponent(whId)}`, token, { method: "DELETE" })
      .then((r) => r.endpoint),
  testWebhook: (token: string, orgId: string, whId: string) =>
    // 202 → { delivery, event }: QUEUED, not delivered — the dispatcher sends on
    // its own poll. 409 ENDPOINT_DISABLED when the endpoint is switched off.
    request<{ delivery: WebhookDelivery; event: { id: string; seq: number; type: string; occurredAt: string } }>(
      `/orgs/${encodeURIComponent(orgId)}/webhooks/${encodeURIComponent(whId)}/test`, token, { method: "POST", body: "{}" },
    ),
  webhookDeliveries: (token: string, orgId: string, whId: string, limit?: number) =>
    request<{ deliveries: WebhookDelivery[] }>(
      `/orgs/${encodeURIComponent(orgId)}/webhooks/${encodeURIComponent(whId)}/deliveries${limit ? `?limit=${limit}` : ""}`, token,
    ).then((r) => r.deliveries),
  replayWebhookDelivery: (token: string, orgId: string, whId: string, deliveryId: string) =>
    // 200 → { delivery } reset to pending with a fresh retry budget.
    // 409 DELIVERY_INFLIGHT when a dispatcher already claimed the row.
    request<{ delivery: WebhookDelivery }>(
      `/orgs/${encodeURIComponent(orgId)}/webhooks/${encodeURIComponent(whId)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      token, { method: "POST", body: "{}" },
    ).then((r) => r.delivery),
  // The durable cursor. `after` is EXCLUSIVE, so the documented catch-up loop is
  // `after = nextAfter` — it never re-reads and never skips, and an empty page
  // hands the caller's own cursor back.
  events: (token: string, opts: { after?: number; type?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.after !== undefined) q.set("after", String(opts.after));
    if (opts.type) q.set("type", opts.type);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return request<{ events: PlatformEvent[]; nextAfter: number }>(`/events${qs ? `?${qs}` : ""}`, token);
  },
  certificateUrl: (id: string): string => `${BASE}/credentials/${encodeURIComponent(id)}/certificate.pdf`,
  didResolveUrl: (did: string): string => `${BASE}/dids/${encodeURIComponent(did)}/resolve`,
  myCredentials: (token: string) => request<HeldCredential[]>("/me/credentials", token),
  orgWallet: (token: string, orgId: string) => request<HeldCredential[]>(`/orgs/${encodeURIComponent(orgId)}/wallet`, token),
  didDocument: (token: string, did: string) => request<DidDocument>(`/dids/${encodeURIComponent(did)}/document`, token),
  credentialTypes: (token: string) => request<CredentialTypeInfo[]>("/credential-types", token),
  // 202 → { proposal }: issuance is gated; nothing is issued until it is approved.
  requestCredential: (token: string, body: { type: string; subjectUserId: string; claims: Record<string, unknown>; issuerOrgId?: string }) =>
    request<{ proposal: Proposal }>("/credentials/requests", token, { method: "POST", body: JSON.stringify(body) }),
  orgCredentials: (token: string, orgId: string) => request<IssuedCredential[]>(`/orgs/${encodeURIComponent(orgId)}/credentials`, token),
  // 202 → { proposal }: revocation is gated too.
  revokeCredential: (token: string, id: string, reason: string) =>
    request<{ proposal: Proposal }>(`/credentials/${encodeURIComponent(id)}/revoke`, token, { method: "POST", body: JSON.stringify({ reason }) }),
  // Holder acceptance lifecycle: accept, reject (optional note, revokes), or request changes (note required).
  acceptCredential: (token: string, id: string) =>
    request<{ id: string; acceptance: string }>(`/me/credentials/${encodeURIComponent(id)}/accept`, token, { method: "POST", body: "{}" }),
  rejectHeldCredential: (token: string, id: string, note?: string) =>
    request<{ id: string; acceptance: string }>(`/me/credentials/${encodeURIComponent(id)}/reject`, token, { method: "POST", body: JSON.stringify(note ? { note } : {}) }),
  requestCredentialChanges: (token: string, id: string, note: string) =>
    request<{ id: string; acceptance: string }>(`/me/credentials/${encodeURIComponent(id)}/request-changes`, token, { method: "POST", body: JSON.stringify({ note }) }),
  // null → no chain hosts the registry; credentials are issued unanchored.
  identityRegistry: (token: string) => request<IdentityRegistryInfo | null>("/registry", token),
  // Public: a verifier must be able to check a credential without an account.
  credentialStatus: (id: string) => request<CredentialStatusInfo>(`/credentials/${encodeURIComponent(id)}/status`, null),
  createVerificationRequest: (token: string, body: { holderDid: string; requestedTypes: string[]; purpose: string; credentialUseCaseKey?: string }) =>
    request<VerificationRequest>("/verification-requests", token, { method: "POST", body: JSON.stringify(body) }),
  myVerificationRequests: (token: string) => request<VerificationRequest[]>("/me/verification-requests", token),
  consentVerification: (token: string, id: string, credentialIds: string[]) =>
    request<VerificationRequest>(`/verification-requests/${encodeURIComponent(id)}/consent`, token, { method: "POST", body: JSON.stringify({ credentialIds }) }),
  rejectVerification: (token: string, id: string) =>
    request<VerificationRequest>(`/verification-requests/${encodeURIComponent(id)}/reject`, token, { method: "POST", body: JSON.stringify({}) }),
  verifyVerification: (token: string, id: string) => request<VerificationResult>(`/verification-requests/${encodeURIComponent(id)}/verify`, token),
  // `includeSandbox` is REQUIRED to see a sandbox use case's register at all:
  // without it the server returns an EMPTY LIST rather than a refusal (the
  // register is the customer's record of real invoices), so a caller that omits
  // it for a sandbox key sees "no invoices" and not "wrong environment". Callers
  // pass the use case's own `sandbox` flag — see InvoiceRegister.tsx.
  invoices: (token: string, key: string, status?: "staged" | "tokenized", includeSandbox = false) => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (includeSandbox) q.set("includeSandbox", "true");
    const qs = q.toString();
    return request<StagedInvoice[]>(`/use-cases/${encodeURIComponent(key)}/invoices${qs ? `?${qs}` : ""}`, token);
  },
  importInvoices: (token: string, key: string, rows: Record<string, unknown>[]) =>
    request<{ staged: number; results: InvoiceRowResult[] }>(`/use-cases/${encodeURIComponent(key)}/invoices/import`, token, { method: "POST", body: JSON.stringify({ rows }) }),
  pullErpInvoices: (token: string, key: string) =>
    request<{ staged: number; results: InvoiceRowResult[] }>(`/use-cases/${encodeURIComponent(key)}/invoices/pull-erp`, token, { method: "POST", body: JSON.stringify({}) }),
  addInvoice: (token: string, key: string, metadata: Record<string, unknown>, documentId?: string) =>
    request<StagedInvoice>(`/use-cases/${encodeURIComponent(key)}/invoices`, token, { method: "POST", body: JSON.stringify({ metadata, documentId }) }),
  deleteInvoice: (token: string, key: string, id: string) =>
    request<{ id: string; deleted: boolean }>(`/use-cases/${encodeURIComponent(key)}/invoices/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
  tokenizeInvoices: (token: string, key: string, body: { ids: string[]; chainId: string; treasuryAccount: string; parValue?: number; sale?: { unitPrice: string; currency: string } }) =>
    request<{ results: TokenizeResult[] }>(`/use-cases/${encodeURIComponent(key)}/invoices/tokenize`, token, { method: "POST", body: JSON.stringify(body) }),
  credentialTemplates: (token: string) => request<Record<string, CredentialTypeSpec>>("/credential-templates", token),
  credentialUseCases: (token: string) => request<CredentialUseCase[]>("/credential-use-cases", token),
  credentialUseCase: (token: string, key: string) => request<CredentialUseCase>(`/credential-use-cases/${encodeURIComponent(key)}`, token),
  createCredentialUseCase: (token: string, def: CredentialUseCase) => request<CredentialUseCase>("/credential-use-cases", token, { method: "POST", body: JSON.stringify(def) }),
  updateCredentialUseCase: (token: string, key: string, def: CredentialUseCase) => request<CredentialUseCase>(`/credential-use-cases/${encodeURIComponent(key)}`, token, { method: "PATCH", body: JSON.stringify(def) }),
  eligibleHolders: (token: string, key: string) =>
    request<EligibleHolder[]>(`/credential-use-cases/${encodeURIComponent(key)}/eligible-holders`, token),
  issueUsecaseCredential: (token: string, key: string, body: { credentialType: string; subjectUserId?: string; subjectOrgId?: string; claims: Record<string, unknown> }) =>
    request<{ proposal: Proposal }>(`/credential-use-cases/${encodeURIComponent(key)}/credentials`, token, { method: "POST", body: JSON.stringify(body) }),
  // 202 → { proposal } (one proposal covering the whole batch); 400 BATCH_INVALID → { error, message, problems }.
  issueCredentialsBatch: (token: string, key: string, credentialType: string, rows: unknown[]) =>
    request<{ proposal: Proposal }>(`/credential-use-cases/${encodeURIComponent(key)}/credentials/batch`, token, { method: "POST", body: JSON.stringify({ credentialType, rows }) }),
  enrollLoginKey: (token: string, body: { did: string; label: string }) =>
    request<LoginKeyInfo>("/me/login-keys", token, { method: "POST", body: JSON.stringify(body) }),
  loginKeys: (token: string) => request<LoginKeyInfo[]>("/me/login-keys", token),
  removeLoginKey: (token: string, id: string) => request<null>(`/me/login-keys/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
  qrStart: () => request<QrLoginStart>("/auth/qr/start", null, { method: "POST", body: "{}" }),
  qrPoll: (id: string) => request<QrLoginPoll>(`/auth/qr/${encodeURIComponent(id)}`, null),
  qrAuthenticate: (id: string, body: { did: string; signature: string }) =>
    request<{ ok: boolean }>(`/auth/qr/${encodeURIComponent(id)}/authenticate`, null, { method: "POST", body: JSON.stringify(body) }),
  config: (token: string) => request<{ domains: string[] }>("/config", token),
  credentialUseCaseTemplates: (token: string) => request<{ templates: UseCaseTemplateMeta[] }>("/credential-use-case-templates", token),
  credentialUseCaseTemplate: (token: string, key: string) => request<UseCaseTemplate>(`/credential-use-case-templates/${encodeURIComponent(key)}`, token),
  saveUseCaseTemplate: (token: string, body: UseCaseTemplate) => request<UseCaseTemplate>("/credential-use-case-templates", token, { method: "POST", body: JSON.stringify(body) }),
  previewUseCaseTemplate: (token: string, key: string, params: Record<string, unknown>) =>
    request<{ definition: unknown }>(`/credential-use-case-templates/${encodeURIComponent(key)}/preview`, token, { method: "POST", body: JSON.stringify({ params }) }),
  // EN-D2: `sandbox` sits at the TOP LEVEL, beside `templateKey` — NOT inside
  // `provisioning`, which the server refuses (400 SANDBOX_MISPLACED) rather
  // than ignoring. The type says so too: `provisioning` has no `sandbox`, so
  // the wrong spelling does not compile.
  provisionUseCase: (token: string, body: { templateKey: string; params: Record<string, unknown>; sandbox?: boolean; provisioning: { issuerOrgName: string; issuerOrgType?: string; createDeskUsers: boolean; deskEmailDomain?: string; failIfExists?: boolean } }) =>
    request<ProvisionResult>("/credential-use-cases/provision", token, { method: "POST", body: JSON.stringify(body) }),
};
