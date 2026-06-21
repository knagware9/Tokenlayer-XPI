import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import { can } from "../rbac.js";
import type { ChainInfo, UseCase } from "../types.js";

interface Props {
  useCases: UseCase[];
  chains: ChainInfo[];
  onIssued: (assetId: string) => void;
}

export function IssuePanel({ useCases, chains, onIssued }: Props): JSX.Element {
  const { token, user } = useAuth();
  const [useCaseKey, setUseCaseKey] = useState(useCases[0]?.key ?? "");
  const [chainId, setChainId] = useState("");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const useCase = useMemo(() => useCases.find((u) => u.key === useCaseKey), [useCases, useCaseKey]);
  // The chain picker is scoped to the use case's allowed DLTs that are actually available.
  const availableChains = useMemo(
    () => chains.filter((c) => useCase?.allowedChainIds.includes(c.id)),
    [chains, useCase],
  );

  useEffect(() => {
    if (!useCase) return;
    const preferred = availableChains.find((c) => c.id === useCase.defaultChainId) ?? availableChains[0];
    setChainId(preferred?.id ?? "");
  }, [useCaseKey, useCase, availableChains]);

  const allowed = user ? can(user.role, "issue") : false;

  if (!allowed) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500">
        Your role (<span className="font-medium text-slate-700">{user?.role}</span>) cannot issue assets. Sign in as an
        Issuer or Admin.
      </div>
    );
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!useCase || !token) return;
    setBusy(true);
    setError(null);
    try {
      const metadata: Record<string, unknown> = {};
      for (const [field, prop] of Object.entries(useCase.metadataSchema.properties)) {
        const raw = meta[field];
        if (raw === undefined || raw === "") continue;
        metadata[field] = prop.type === "number" ? Number(raw) : prop.type === "boolean" ? raw === "true" : raw;
      }
      const res = await api.issue(token, { useCaseKey, name, symbol, chainId, metadata });
      setName("");
      setSymbol("");
      setMeta({});
      onIssued(res.asset.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Issuance failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-xl border border-slate-200 p-6 space-y-4 max-w-2xl">
      <h2 className="font-semibold text-slate-900">Issue a new asset</h2>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Use case">
          <select className="select" value={useCaseKey} onChange={(e) => setUseCaseKey(e.target.value)}>
            {useCases.map((u) => (
              <option key={u.key} value={u.key}>
                {u.name} ({u.tokenType})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Chain / DLT">
          <select className="select" value={chainId} onChange={(e) => setChainId(e.target.value)}>
            {availableChains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {useCase && (
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs text-slate-600 space-y-1.5">
          {useCase.description && <p>{useCase.description}</p>}
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded bg-brand-600 text-white text-[10px] font-semibold">{useCase.tokenStandard}</span>
            <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 text-[10px] font-medium">{useCase.tokenType}</span>
            <Badge on={useCase.lifecycle.transfer}>transfer</Badge>
            <Badge on={useCase.lifecycle.burn}>burn</Badge>
            <Badge on={useCase.lifecycle.freeze}>freeze</Badge>
            <Badge on={useCase.compliance.allowlist}>allowlist</Badge>
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Series A Note" />
        </Field>
        <Field label="Symbol">
          <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="e.g. SAN" />
        </Field>
      </div>

      {useCase && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Metadata</p>
          <div className="grid grid-cols-2 gap-4">
            {Object.entries(useCase.metadataSchema.properties).map(([field, prop]) => {
              const required = useCase.metadataSchema.required?.includes(field);
              return (
                <Field key={field} label={`${field}${required ? " *" : ""}`} hint={prop.description}>
                  <input
                    className="input"
                    type={prop.type === "number" ? "number" : "text"}
                    value={meta[field] ?? ""}
                    onChange={(e) => setMeta((m) => ({ ...m, [field]: e.target.value }))}
                  />
                </Field>
              );
            })}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy || !name || !symbol}
        className="rounded-lg bg-brand-600 text-white px-5 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
      >
        {busy ? "Issuing…" : "Issue asset"}
      </button>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-600 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

function Badge({ on, children }: { on: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <span
      className={`inline-block mr-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${
        on ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-400 line-through"
      }`}
    >
      {children}
    </span>
  );
}
