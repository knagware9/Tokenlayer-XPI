import type { AccountState, Asset, AuditEntry, ChainInfo, SessionUser, TokenInfo, UseCase } from "./types.js";

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
  accounts: (token: string) => request<{ address: string; label: string }[]>("/accounts", token),
  createUseCase: (token: string, def: UseCase) =>
    request<UseCase>("/use-cases", token, { method: "POST", body: JSON.stringify(def) }),
  assets: (token: string) => request<Listed<Asset>>("/assets?limit=200", token).then((r) => r.data),
  asset: (token: string, id: string) => request<Asset>(`/assets/${id}`, token),
  assetAccounts: (token: string, id: string) => request<AccountState[]>(`/assets/${id}/accounts`, token),
  assetTokens: (token: string, id: string) => request<TokenInfo[]>(`/assets/${id}/tokens`, token),
  audit: (token: string, id: string) => request<Listed<AuditEntry>>(`/assets/${id}/audit?limit=200`, token).then((r) => r.data),
  issue: (
    token: string,
    input: { useCaseKey: string; name: string; symbol: string; chainId: string; metadata: Record<string, unknown> },
  ) => request<{ asset: Asset; txHash: string }>("/assets", token, { method: "POST", body: JSON.stringify(input) }),
  action: (token: string, id: string, action: string, body: Record<string, string>) =>
    request<{ receipt: { txHash: string } }>(`/assets/${id}/actions/${action}`, token, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
