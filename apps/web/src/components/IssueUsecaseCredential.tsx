import { useEffect, useState } from "react";
import { useAuth } from "../auth.js";
import { api, ApiError } from "../api.js";
import type { CredentialUseCase, CredentialTypeSpec, EligibleHolder } from "../types.js";

export function IssueUsecaseCredential({ useCase, onIssued }: { useCase: CredentialUseCase; onIssued: () => void }): JSX.Element {
  const { token } = useAuth();
  const [typeName, setTypeName] = useState(useCase.credentialTypes[0]?.name ?? "");
  const [holders, setHolders] = useState<EligibleHolder[]>([]);
  const [subjectUserId, setSubjectUserId] = useState("");
  const [claims, setClaims] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api.eligibleHolders(token, useCase.key).then(setHolders).catch(() => setHolders([]));
  }, [token, useCase.key]);

  const spec: CredentialTypeSpec | undefined = useCase.credentialTypes.find((t) => t.name === typeName);

  async function submit(): Promise<void> {
    setErr(null); setMsg(null);
    if (!token || !subjectUserId) { setErr("pick a holder"); return; }
    try {
      await api.issueUsecaseCredential(token, useCase.key, { credentialType: typeName, subjectUserId, claims });
      setMsg("Issuance submitted — pending approval."); setClaims({}); onIssued();
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-4 mt-3">
      <div className="text-sm font-medium mb-2">Issue a credential</div>
      {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
      {msg && <div className="text-sm text-emerald-600 mb-2">{msg}</div>}
      <label className="block text-xs text-slate-500 mb-1">Credential type</label>
      <select className="input w-full mb-2" value={typeName} onChange={(e) => setTypeName(e.target.value)}>
        {useCase.credentialTypes.map((t) => <option key={t.name} value={t.name}>{t.title} ({t.name})</option>)}
      </select>
      <label className="block text-xs text-slate-500 mb-1">Holder</label>
      <select className="input w-full mb-2" value={subjectUserId} onChange={(e) => setSubjectUserId(e.target.value)}>
        <option value="">— select an eligible holder —</option>
        {holders.map((h) => <option key={h.id} value={h.id}>{h.email}{h.orgName ? ` · ${h.orgName}` : ""}</option>)}
      </select>
      {spec && Object.entries(spec.claimSchema.properties).map(([field, p]) => (
        <div key={field} className="mb-2">
          <label className="block text-xs text-slate-500 mb-1">{field}{spec.claimSchema.required?.includes(field) ? " *" : ""}</label>
          {Array.isArray(p.enum) ? (
            <select className="input w-full" value={claims[field] ?? ""} onChange={(e) => setClaims({ ...claims, [field]: e.target.value })}>
              <option value="">—</option>
              {p.enum.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input className="input w-full" value={claims[field] ?? ""} onChange={(e) => setClaims({ ...claims, [field]: e.target.value })} />
          )}
        </div>
      ))}
      <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white mt-1" onClick={() => void submit()}>Submit for approval</button>
    </div>
  );
}
