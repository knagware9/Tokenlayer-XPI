import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { api } from "./api.js";
import type { SessionUser } from "./types.js";

interface AuthState {
  token: string | null;
  user: SessionUser | null;
  login: (email: string, password: string) => Promise<void>;
  setSession: (token: string, user: SessionUser) => void;
  /** Re-read the live principal from /me and merge it into the session. Call
   * after something server-side changes the principal (e.g. a capability
   * grant), so nav driven by the session stops disagreeing with the screen. */
  refreshSession: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const STORAGE_KEY = "tokenlayer.session";

function loadSession(): { token: string; user: SessionUser } | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as { token: string; user: SessionUser }) : null;
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const initial = loadSession();
  const [token, setToken] = useState<string | null>(initial?.token ?? null);
  const [user, setUser] = useState<SessionUser | null>(initial?.user ?? null);

  const value = useMemo<AuthState>(
    () => ({
      token,
      user,
      async login(email, password) {
        const res = await api.login(email, password);
        setToken(res.token);
        setUser(res.user);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(res));
      },
      setSession(token, user) {
        setToken(token);
        setUser(user);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, user }));
      },
      async refreshSession() {
        if (!token || !user) return;
        // /me is a STRICT SUBSET of SessionUser (no email/orgId/did/
        // walletAddress) — spread it OVER the stored user so the fields it
        // does not return survive. Replacing wholesale would blank them.
        const principal = await api.me(token);
        const merged: SessionUser = { ...user, ...principal };
        setUser(merged);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, user: merged }));
      },
      logout() {
        setToken(null);
        setUser(null);
        localStorage.removeItem(STORAGE_KEY);
      },
    }),
    [token, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
