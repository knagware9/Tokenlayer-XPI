import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api.js";
import type { Currency } from "../api.js";
import { useAuth } from "../auth.js";
import { can } from "../rbac.js";
import type { ChainInfo, UseCase } from "../types.js";
import { computeFingerprint } from "./InvoiceImport.js";

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
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [derived, setDerived] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [treasury, setTreasury] = useState("");
  const [initialSupply, setInitialSupply] = useState("");
  const [listForSale, setListForSale] = useState(false);
  const [salePrice, setSalePrice] = useState("");
  const [saleCurrency, setSaleCurrency] = useState("");
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [allAccounts, setAllAccounts] = useState<{ address: string; label: string }[]>([]);

  // Sync useCaseKey when useCases loads after mount (avoids empty chain dropdown on first render)
  useEffect(() => {
    if (!useCaseKey && useCases[0]?.key) setUseCaseKey(useCases[0].key);
  }, [useCases, useCaseKey]);

  const useCase = useMemo(() => useCases.find((u) => u.key === useCaseKey), [useCases, useCaseKey]);
  const isFungible = useCase?.tokenType === "fungible";
  // Issuance mints into the use case's contract, so the chain picker is scoped to the
  // chains this use case has actually DEPLOYED a contract on (allowed ∩ deployed ∩ available).
  const availableChains = useMemo(
    () => chains.filter((c) => useCase?.allowedChainIds.includes(c.id) && useCase?.contracts?.[c.id]),
    [chains, useCase],
  );

  useEffect(() => {
    if (!useCase) return;
    const preferred = availableChains.find((c) => c.id === useCase.defaultChainId) ?? availableChains[0];
    setChainId(preferred?.id ?? "");
  }, [useCaseKey, useCase, availableChains]);

  // Default the sale price/currency from the use case's saleTermsDefault when it changes.
  useEffect(() => {
    setSalePrice(useCase?.saleTermsDefault?.unitPrice ?? "");
    setSaleCurrency(useCase?.saleTermsDefault?.currency ?? "");
  }, [useCase]);

  useEffect(() => {
    if (!token) return;
    void api.currencies(token).then(setCurrencies).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void api.accounts(token).then(setAllAccounts);
  }, [token]);

  // Live-preview any server-derived metadata field (e.g. invoiceHash from the
  // canonical invoice fields). The server ultimately derives + persists it.
  useEffect(() => {
    const gen = useCase?.derivedFields?.invoiceHash;
    if (gen !== "invoiceFingerprint") { setDerived({}); return; }
    const f = { invoiceNumber: meta.invoiceNumber, sellerGstin: meta.sellerGstin, buyerGstin: meta.buyerGstin, amountInr: meta.amountInr, dueDate: meta.dueDate };
    if (Object.values(f).every((v) => (v ?? "").trim() !== "")) {
      void computeFingerprint(f as Parameters<typeof computeFingerprint>[0]).then((h) => setDerived({ invoiceHash: h }));
    } else setDerived({});
  }, [useCase, meta.invoiceNumber, meta.sellerGstin, meta.buyerGstin, meta.amountInr, meta.dueDate]);

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
        // Server-derived fields (e.g. invoiceHash) are computed by the platform — never submit them.
        if (useCase.derivedFields && field in useCase.derivedFields) continue;
        const raw = meta[field];
        if (raw === undefined || raw === "") continue;
        metadata[field] = prop.type === "number" ? Number(raw) : prop.type === "boolean" ? raw === "true" : raw;
      }
      const sale = listForSale && salePrice && saleCurrency && treasury
        ? { unitPrice: salePrice, currency: saleCurrency, treasuryAccount: treasury }
        : undefined;
      const supply = isFungible && /^\d+$/.test(initialSupply) && Number(initialSupply) > 0 ? initialSupply : undefined;
      const res = await api.issue(token, {
        useCaseKey, name, chainId, metadata,
        treasuryAccount: treasury || undefined,
        initialSupply: supply,
        sale,
      });
      setName("");
      setMeta({});
      setDerived({});
      setTreasury("");
      setInitialSupply("");
      setListForSale(false);
      setSalePrice("");
      setSaleCurrency("");
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
                {c.label}{c.mode === "simulated" && !/simulat/i.test(c.label) ? " — simulated" : ""}
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
        <Field label="Symbol" hint="Inherited from the use case's contract">
          <input className="input bg-slate-50 text-slate-500" value={useCase?.symbol ?? ""} disabled />
        </Field>
      </div>

      {useCase && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Metadata</p>
          <div className="grid grid-cols-2 gap-4">
            {Object.entries(useCase.metadataSchema.properties).map(([field, prop]) => {
              const required = useCase.metadataSchema.required?.includes(field);
              const value = meta[field] ?? "";
              const onChange = (v: string) => setMeta((m) => ({ ...m, [field]: v }));
              const isDerived = !!useCase.derivedFields && field in useCase.derivedFields;
              return (
                <Field key={field} label={`${field}${required ? " *" : ""}`} hint={isDerived ? "Derived by the platform from the invoice fields" : prop.description}>
                  {isDerived ? (
                    <input
                      className="input bg-slate-50 text-slate-500 font-mono text-xs"
                      readOnly
                      value={derived[field] ?? "(fill invoice fields to compute)"}
                    />
                  ) : prop.type === "document" ? (
                    <div className="space-y-1">
                      <input className="input" type="url" placeholder="https://… or upload →" value={value} onChange={(e) => onChange(e.target.value)} />
                      <input
                        type="file"
                        disabled={busy}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file || !token) return;
                          const b64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
                          try {
                            const r = await api.uploadDocument(token, file.type || "application/octet-stream", b64);
                            onChange(r.url);
                            setMeta((m) => ({ ...m, invoiceDocHash: r.sha256 }));
                          } catch {
                            setError("Document upload failed");
                          } finally {
                            e.target.value = "";
                          }
                        }}
                        className="block w-full text-xs file:mr-2 file:rounded file:border-0 file:bg-brand-600 file:text-white file:px-2 file:py-1 file:text-xs"
                      />
                    </div>
                  ) : prop.enum ? (
                    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
                      <option value="">select…</option>
                      {prop.enum.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : prop.type === "number" ? (
                    <input
                      className="input"
                      type="number"
                      min={prop.min}
                      max={prop.max}
                      value={value}
                      onChange={(e) => onChange(e.target.value)}
                    />
                  ) : prop.type === "boolean" ? (
                    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
                      <option value="">select…</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className="input"
                      type="text"
                      pattern={prop.pattern}
                      value={value}
                      onChange={(e) => onChange(e.target.value)}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        </div>
      )}

      {isFungible && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Number of tokens" hint="Minted to the treasury at issuance (sets total supply)">
            <input className="input" type="number" min="0" step="1" value={initialSupply} onChange={(e) => setInitialSupply(e.target.value)} placeholder="e.g. 100" />
          </Field>
          <Field label="Treasury account" hint="Holds the supply and sells it on the marketplace">
            <select className="select" value={treasury} onChange={(e) => setTreasury(e.target.value)}>
              <option value="">Select account…</option>
              {allAccounts.map((a) => (
                <option key={a.address} value={a.address}>{a.label}</option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {isFungible && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input type="checkbox" checked={listForSale} onChange={(e) => setListForSale(e.target.checked)} />
            List for sale
          </label>
          {listForSale && (
            <div className="rounded-lg border border-slate-200 p-4 space-y-3 bg-slate-50">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Unit price">
                  <input className="input" type="number" min="1" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} placeholder="e.g. 5" />
                </Field>
                <Field label="Currency">
                  <select className="select" value={saleCurrency} onChange={(e) => setSaleCurrency(e.target.value)}>
                    <option value="">Select currency…</option>
                    {currencies.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                  </select>
                </Field>
              </div>
              {!treasury && <p className="text-[11px] text-amber-600">Select a treasury account above to list this asset for sale.</p>}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy || !name || !chainId}
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
