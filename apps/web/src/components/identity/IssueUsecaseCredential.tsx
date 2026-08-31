import { useEffect, useState } from "react";
import { useAuth } from "../../auth.js";
import { api, ApiError } from "../../api.js";
import type { CredentialUseCase, CredentialTypeSpec, EligibleHolder } from "../../types.js";
import { BatchCsv } from "../shared/BatchCsv.js";
import { SchemaFieldEditor, fieldsToSchema, type FieldRow } from "../shared/SchemaFieldEditor.js";

export function IssueUsecaseCredential({ useCase, onIssued }: { useCase: CredentialUseCase; onIssued: () => void }): JSX.Element {
  const { user } = useAuth();
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [typeName, setTypeName] = useState(useCase.credentialTypes[0]?.name ?? "");
  const spec: CredentialTypeSpec | undefined = useCase.credentialTypes.find((t) => t.name === typeName);
  // The dropdown's selection can point at a type that has since been removed
  // from a reloaded `useCase` (stale after a full-replace PATCH elsewhere) —
  // fall back to the first available type rather than issuing nothing.
  useEffect(() => {
    if (!useCase.credentialTypes.some((t) => t.name === typeName)) setTypeName(useCase.credentialTypes[0]?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCase.credentialTypes]);

  return (
    <div className="rounded-lg border border-slate-200 p-4 mt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium">Issue a credential</div>
        <button
          onClick={() => setMode((m) => (m === "single" ? "batch" : "single"))}
          className="text-xs text-brand-600 hover:text-brand-700 font-medium"
        >
          {mode === "single" ? "Batch issue (CSV)" : "Single issue"}
        </button>
      </div>
      <label className="block text-xs text-slate-500 mb-1">Credential type</label>
      <select className="input w-full mb-2" value={typeName} onChange={(e) => setTypeName(e.target.value)}>
        {useCase.credentialTypes.map((t) => <option key={t.name} value={t.name}>{t.title} ({t.name})</option>)}
      </select>
      {mode === "single" ? (
        <SingleIssue useCase={useCase} spec={spec} typeName={typeName} onIssued={onIssued} />
      ) : spec ? (
        <BatchIssueCredential useCase={useCase} spec={spec} onIssued={onIssued} />
      ) : null}
      {user?.role === "UseCaseAdmin" && <AddCredentialType useCase={useCase} onAdded={onIssued} />}
    </div>
  );
}

const emptyTypeDraft = (): { name: string; title: string; validityDays: string; requiredApprovals: string; fields: FieldRow[] } =>
  ({ name: "", title: "", validityDays: "365", requiredApprovals: "1", fields: [] });

/** UseCaseAdmin-only: append a new credential type to THIS use case, without the
 * risk of PlatformAdmin's full-definition PATCH. Collapsed by default so the
 * common "issue a credential" path stays uncluttered. */
function AddCredentialType({ useCase, onAdded }: { useCase: CredentialUseCase; onAdded: () => void }): JSX.Element {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(emptyTypeDraft());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setErr(null);
    const name = draft.name.trim();
    if (!name || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) { setErr("name must start with a letter and contain only letters/digits"); return; }
    if (useCase.credentialTypes.some((t) => t.name === name)) { setErr(`'${name}' already exists on this use case`); return; }
    const validityDays = Number(draft.validityDays);
    if (!(validityDays > 0)) { setErr("validity days must be a positive number"); return; }
    const requiredApprovals = Number(draft.requiredApprovals);
    if (!(Number.isInteger(requiredApprovals) && requiredApprovals >= 1)) { setErr("required approvals must be a whole number, 1 or more"); return; }
    const claimSchema = fieldsToSchema(draft.fields);
    if (Object.keys(claimSchema.properties).length === 0) { setErr("add at least one claim field"); return; }
    if (!token) return;
    setBusy(true);
    try {
      await api.addCredentialType(token, useCase.key, {
        name, title: draft.title.trim() || name, validityDays, requiredApprovals, claimSchema,
      });
      setDraft(emptyTypeDraft());
      setOpen(false);
      onAdded();
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 text-xs text-brand-600 hover:text-brand-700 font-medium"
      >
        + Add a credential schema to this use case
      </button>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium">Add a credential schema</div>
        <button onClick={() => { setOpen(false); setErr(null); }} className="text-xs text-slate-500 hover:text-slate-700">Cancel</button>
      </div>
      {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Name (machine id, e.g. AddressProof)</label>
          <input className="input w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Title (display name)</label>
          <input className="input w-full" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Validity (days)</label>
          <input className="input w-full" type="number" value={draft.validityDays} onChange={(e) => setDraft({ ...draft, validityDays: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Required approvals</label>
          <input className="input w-full" type="number" value={draft.requiredApprovals} onChange={(e) => setDraft({ ...draft, requiredApprovals: e.target.value })} />
        </div>
      </div>
      <SchemaFieldEditor fields={draft.fields} onChange={(fields) => setDraft({ ...draft, fields })} />
      <button
        onClick={() => void submit()}
        disabled={busy}
        className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Adding…" : "Add credential schema"}
      </button>
    </div>
  );
}

/** The original single-holder issuance form, unchanged apart from taking `spec`/`typeName` as props
 * (lifted so the type selector is shared with batch mode). */
function SingleIssue({ useCase, spec, typeName, onIssued }: { useCase: CredentialUseCase; spec: CredentialTypeSpec | undefined; typeName: string; onIssued: () => void }): JSX.Element {
  const { token } = useAuth();
  const [holders, setHolders] = useState<EligibleHolder[]>([]);
  const [subjectId, setSubjectId] = useState("");
  const [claims, setClaims] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api.eligibleHolders(token, useCase.key).then(setHolders).catch(() => setHolders([]));
  }, [token, useCase.key]);

  async function submit(): Promise<void> {
    setErr(null); setMsg(null);
    if (!token || !subjectId) { setErr("pick a holder"); return; }
    const picked = holders.find((h) => h.id === subjectId);
    if (!picked) { setErr("pick a holder"); return; }
    // Coerce each claim to its declared type — a number field must be sent as a
    // JSON number, not the raw string the text input holds, or metadata
    // validation rejects it. Empty optional fields are omitted entirely.
    const typedClaims: Record<string, unknown> = {};
    for (const [field, p] of Object.entries(spec?.claimSchema.properties ?? {})) {
      const raw = claims[field];
      if (raw === undefined || raw === "") continue;
      typedClaims[field] = p.type === "number" ? Number(raw) : p.type === "boolean" ? raw === "true" : raw;
    }
    try {
      await api.issueUsecaseCredential(token, useCase.key, picked.kind === "org"
        ? { credentialType: typeName, subjectOrgId: picked.id, claims: typedClaims }
        : { credentialType: typeName, subjectUserId: picked.id, claims: typedClaims });
      setMsg("Issuance submitted — pending approval."); setClaims({}); onIssued();
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  }

  return (
    <div>
      {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
      {msg && <div className="text-sm text-emerald-600 mb-2">{msg}</div>}
      <label className="block text-xs text-slate-500 mb-1">Holder</label>
      <select className="input w-full mb-2" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
        <option value="">— select an eligible holder —</option>
        {holders.map((h) => <option key={`${h.kind}:${h.id}`} value={h.id}>{h.kind === "org" ? "🏢 " : ""}{h.label}{h.subLabel ? ` · ${h.subLabel}` : ""}</option>)}
      </select>
      {spec && Object.entries(spec.claimSchema.properties).map(([field, p]) => (
        <div key={field} className="mb-2">
          <label className="block text-xs text-slate-500 mb-1">{field}{spec.claimSchema.required?.includes(field) ? " *" : ""}</label>
          {Array.isArray(p.enum) ? (
            <select className="input w-full" value={claims[field] ?? ""} onChange={(e) => setClaims({ ...claims, [field]: e.target.value })}>
              <option value="">—</option>
              {p.enum.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : p.type === "number" ? (
            <input className="input w-full" type="number" value={claims[field] ?? ""} onChange={(e) => setClaims({ ...claims, [field]: e.target.value })} />
          ) : (
            <input className="input w-full" value={claims[field] ?? ""} onChange={(e) => setClaims({ ...claims, [field]: e.target.value })} />
          )}
        </div>
      ))}
      <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white mt-1" onClick={() => void submit()}>Submit for approval</button>
    </div>
  );
}

/** Batch issuance for the selected credential type: subjects are identified by email
 * (resolved server-side at execution), with one CSV column per claim. */
function BatchIssueCredential({ useCase, spec, onIssued }: { useCase: CredentialUseCase; spec: CredentialTypeSpec; onIssued: () => void }): JSX.Element {
  const { token } = useAuth();
  const properties = spec.claimSchema.properties;
  const requiredClaims = spec.claimSchema.required ?? [];
  const claimKeys = Object.keys(properties);
  const requiredClaimKeys = claimKeys.filter((k) => requiredClaims.includes(k));
  const optionalClaimKeys = claimKeys.filter((k) => !requiredClaims.includes(k));

  return (
    <BatchCsv
      title={`Batch issue ${spec.title} (CSV)`}
      requiredHeaders={["subjectEmail", ...requiredClaimKeys]}
      optionalHeaders={optionalClaimKeys}
      templateName={`${spec.name}-batch-template.csv`}
      coerceRow={(row) => {
        const claims: Record<string, unknown> = {};
        for (const key of claimKeys) {
          const raw = row[key];
          if (raw === undefined || raw === "") continue; // drop empty optional cells
          const p = properties[key];
          claims[key] = p?.type === "number" ? Number(raw) : p?.type === "boolean" ? raw === "true" : raw;
        }
        return { subjectEmail: row.subjectEmail ?? "", claims };
      }}
      validateRow={(row) => {
        const subjectEmail = String(row.subjectEmail ?? "");
        if (!subjectEmail.includes("@")) return "invalid subjectEmail";
        const claims = (row.claims ?? {}) as Record<string, unknown>;
        for (const key of requiredClaimKeys) {
          const v = claims[key];
          if (v === undefined || v === "") return `missing required claim '${key}'`;
        }
        for (const key of claimKeys) {
          const v = claims[key];
          if (properties[key]?.type === "number" && v !== undefined && Number.isNaN(v as number)) {
            return `claim '${key}' must be a number`;
          }
        }
        return null;
      }}
      onSubmit={(rows) => api.issueCredentialsBatch(token!, useCase.key, spec.name, rows).then((r) => { onIssued(); return { proposalId: r.proposal.id }; })}
    />
  );
}
