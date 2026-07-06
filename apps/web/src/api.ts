import type { AccountState, AnalyticsSummary, Asset, AuditEntry, ChainInfo, Role, SessionUser, TokenInfo, UseCase } from "./types.js";

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
  chains: (token: string) => request<ChainInfo[]>("/chains", token),
  useCases: (token: string) => request<UseCase[]>("/use-cases", token),
  analytics: (token: string, opts: { useCaseKey?: string; days?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.useCaseKey) q.set("useCaseKey", opts.useCaseKey);
    if (opts.days) q.set("days", String(opts.days));
    const qs = q.toString();
    return request<AnalyticsSummary>(`/analytics${qs ? `?${qs}` : ""}`, token);
  },
  accounts: (token: string) => request<{ address: string; label: string }[]>("/accounts", token),
  createUseCase: (token: string, def: UseCase) =>
    request<UseCase>("/use-cases", token, { method: "POST", body: JSON.stringify(def) }),
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
  ) => request<{ asset: Asset; txHash: string }>("/assets", token, { method: "POST", body: JSON.stringify(input) }),
  action: (token: string, id: string, action: string, body: Record<string, string>) =>
    request<{ receipt: { txHash: string } }>(`/assets/${id}/actions/${action}`, token, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  currencies: (token: string) => request<Currency[]>("/currencies", token),
  cashBalances: (token: string, address: string) =>
    request<CashBalance[]>(`/cash/balances?address=${encodeURIComponent(address)}`, token),
  buy: (token: string, id: string, quantity: string) =>
    request<{ receipt: unknown; paid: { amount: string; currency: string }; delivered: { amount: string; to: string } }>(
      `/assets/${id}/buy`, token, { method: "POST", body: JSON.stringify({ quantity }) }),
  setPrice: (token: string, id: string, terms: { unitPrice: string; currency: string; treasuryAccount: string }) =>
    request<{ ok: boolean }>(`/assets/${id}/actions/setPrice`, token, { method: "POST", body: JSON.stringify(terms) }),
  creditCash: (token: string, account: string, currency: string, amount: string) =>
    request<{ ok: boolean; balance: string }>("/cash/credit", token, { method: "POST", body: JSON.stringify({ account, currency, amount }) }),
  users: (token: string) => request<{ id: string; email: string; role: Role; useCaseKey: string | null; accountId: string | null; active: boolean; kycStatus: "pending" | "approved" | "rejected"; kyc: { legalName?: string; country?: string; idType?: string; idNumber?: string; documentRef?: string } | null }[]>("/users", token),
  createUser: (token: string, input: { email: string; password: string; role: Role; useCaseKey?: string; walletAddress?: string; kyc?: { legalName?: string; country?: string; idType?: string; idNumber?: string; documentRef?: string } }) =>
    request<{ id: string; email: string; role: Role }>("/users", token, { method: "POST", body: JSON.stringify(input) }),
  updateUser: (token: string, id: string, patch: { password?: string; active?: boolean; kycStatus?: "approved" | "rejected" }) =>
    request<{ id: string }>(`/users/${id}`, token, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteUser: (token: string, id: string) => request<void>(`/users/${id}`, token, { method: "DELETE" }),
};
