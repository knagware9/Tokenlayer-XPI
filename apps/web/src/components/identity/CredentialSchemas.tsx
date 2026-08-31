import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth.js";
import { api, ApiError } from "../../api.js";
import type { CertificateFieldPlacement, CredentialUseCase } from "../../types.js";
import { SchemaFieldEditor, fieldsToSchema, type FieldRow } from "../shared/SchemaFieldEditor.js";
import { CertificateDesigner } from "./CertificateDesigner.js";
import { fieldLabel, withoutStalePlacements } from "../../lib/identity/certificate-layout.js";
import { Card, EmptyState, SectionHeader } from "../shared/ui.js";

function BackButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="text-sm text-slate-500 hover:text-slate-800 inline-flex items-center gap-1.5">
      ← Back to Credential Schemas
    </button>
  );
}

/** Read-only view of one already-saved credential type: its claim fields and
 * its certificate design, if any — the "data fields, pdf design etc." a click
 * on the list is for. Separate page, matching the pattern the other identity
 * dashboards already use for a row's View action. */
function SchemaDetail({ useCase, name, onBack }: { useCase: CredentialUseCase; name: string; onBack: () => void }): JSX.Element {
  const { token } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useCase.credentialTypes.find((x) => x.name === name);

  async function previewStored(): Promise<void> {
    if (!token || !t) return;
    setErr(null); setBusy(true);
    try {
      const blob = await api.previewStoredCertificate(token, useCase.key, t.name);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { setErr(e instanceof ApiError ? e.message : "preview failed"); }
    finally { setBusy(false); }
  }

  if (!t) { onBack(); return <></>; }

  const cert = t.certificate;
  const claimOrder = cert?.claimOrder?.length ? cert.claimOrder : Object.keys(t.claimSchema.properties);

  return (
    <div className="space-y-5">
      <BackButton onClick={onBack} />
      <SectionHeader title={t.title} description={`${t.name} · ${t.validityDays}d validity · ${t.requiredApprovals} approval(s)`} />

      <Card title="Data fields">
        {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] text-slate-400 uppercase tracking-widest">
              <tr>
                <th className="text-left font-semibold px-2 py-1.5">Field</th>
                <th className="text-left font-semibold px-2 py-1.5">Type</th>
                <th className="text-left font-semibold px-2 py-1.5">Required</th>
                <th className="text-left font-semibold px-2 py-1.5">Details</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(t.claimSchema.properties).map(([field, p]) => (
                <tr key={field} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 font-medium text-slate-800">{field}</td>
                  <td className="px-2 py-1.5 text-slate-600">{p.type}</td>
                  <td className="px-2 py-1.5">{t.claimSchema.required?.includes(field) ? "Yes" : "—"}</td>
                  <td className="px-2 py-1.5 text-slate-500">
                    {Array.isArray(p.enum) ? `one of: ${p.enum.join(", ")}` : p.pattern ? `pattern: ${p.pattern}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="PDF certificate design">
        {!cert?.enabled ? (
          <EmptyState icon="doc" title="No PDF certificate configured" hint="This schema issues credentials with no printable certificate." />
        ) : (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div><div className="text-[11px] uppercase tracking-wide text-slate-400">Heading</div><div className="text-slate-800">{cert.heading || "—"}</div></div>
              <div><div className="text-[11px] uppercase tracking-wide text-slate-400">Subheading</div><div className="text-slate-800">{cert.subheading || "—"}</div></div>
              <div><div className="text-[11px] uppercase tracking-wide text-slate-400">Logo / seal</div><div className="text-slate-800">{cert.logoDocumentId ? "Set" : "Organization's default"}</div></div>
              <div><div className="text-[11px] uppercase tracking-wide text-slate-400">Background artwork</div><div className="text-slate-800">{cert.background ? "Custom artwork" : "Built-in layout"}</div></div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Claims printed</div>
              <div className="flex flex-wrap gap-1.5">
                {claimOrder.map((k) => <span key={k} className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600">{k}</span>)}
              </div>
            </div>
            {cert.background && (cert.placements?.length ?? 0) > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Placements</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-[10px] text-slate-400 uppercase tracking-widest">
                      <tr><th className="text-left font-semibold px-2 py-1">Field</th><th className="text-left font-semibold px-2 py-1">Position</th><th className="text-left font-semibold px-2 py-1">Font</th></tr>
                    </thead>
                    <tbody>
                      {cert.placements!.map((p) => (
                        <tr key={p.field} className="border-t border-slate-100">
                          <td className="px-2 py-1 text-slate-700">{fieldLabel(p.field)}</td>
                          <td className="px-2 py-1 text-slate-500">{(p.x * 100).toFixed(0)}%, {(p.y * 100).toFixed(0)}%</td>
                          <td className="px-2 py-1 text-slate-500">{p.font ?? "sans"} {p.fontSize ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <button
              onClick={() => void previewStored()}
              disabled={busy}
              className="rounded-lg border border-brand-200 bg-brand-50 px-3.5 py-1.5 text-xs font-semibold text-brand-700 hover:border-brand-400 disabled:opacity-50"
            >
              {busy ? "Rendering…" : "Preview sample PDF"}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

interface NewTypeDraft {
  name: string; title: string; validityDays: string; requiredApprovals: string; fields: FieldRow[];
  certEnabled: boolean; certHeading: string; certSubheading: string; certClaimKeys: string[];
  certLogoDocumentId: string; certBackgroundDocumentId: string; certBackgroundSha256: string;
  certPlacements: CertificateFieldPlacement[];
}
const emptyTypeDraft = (): NewTypeDraft => ({
  name: "", title: "", validityDays: "365", requiredApprovals: "1", fields: [],
  certEnabled: false, certHeading: "", certSubheading: "", certClaimKeys: [],
  certLogoDocumentId: "", certBackgroundDocumentId: "", certBackgroundSha256: "", certPlacements: [],
});
const claimKeysOf = (d: NewTypeDraft): string[] => d.fields.map((f) => f.name.trim()).filter(Boolean);

/**
 * UseCaseAdmin's dedicated desk page for this use case's credential schemas —
 * its own left-nav item rather than tucked inside "Issue Credentials", since
 * authoring a schema is a configuration act, not an issuance one. Appends a
 * new credential type via `POST /credential-use-cases/:key/credential-types`
 * (additive, UseCaseAdmin-scoped — never PlatformAdmin's full-definition
 * PATCH). Certificate design mirrors CredentialUseCaseBuilder's wizard step —
 * same fields, same CertificateDesigner — so a schema added here is printable
 * exactly like one authored at use-case creation.
 */
export function CredentialSchemas({ useCase, onChanged }: { useCase: CredentialUseCase; onChanged: () => void }): JSX.Element {
  const { token } = useAuth();
  const [detail, setDetail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(emptyTypeDraft());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Same object-URL-per-artwork-id fetch/cleanup pattern as the wizard — the
  // background route needs a bearer token, so the canvas gets a fetched blob
  // URL rather than a bare <img src>.
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const artworkUrlRef = useRef<string | null>(null);
  artworkUrlRef.current = artworkUrl;
  useEffect(() => {
    if (!token || !draft.certBackgroundDocumentId) { setArtworkUrl(null); return; }
    let cancelled = false;
    void api.downloadDocument(token, draft.certBackgroundDocumentId)
      .then((b) => { if (!cancelled) setArtworkUrl(URL.createObjectURL(b)); })
      .catch(() => { if (!cancelled) setArtworkUrl(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, draft.certBackgroundDocumentId]);
  useEffect(() => () => { if (artworkUrlRef.current) URL.revokeObjectURL(artworkUrlRef.current); }, []);

  async function uploadArtwork(file: File): Promise<void> {
    if (!token) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = ""; for (let n = 0; n < bytes.length; n++) bin += String.fromCharCode(bytes[n] as number);
    try {
      const r = await api.uploadDocument(token, file.type, btoa(bin));
      setDraft((d) => ({ ...d, certBackgroundDocumentId: r.id, certBackgroundSha256: r.sha256 }));
    } catch { setErr("artwork upload failed"); }
  }

  async function previewCertificate(): Promise<void> {
    if (!token) return;
    const placements = withoutStalePlacements(draft.certPlacements, claimKeysOf(draft));
    try {
      const blob = await api.previewCertificate(token, {
        credentialType: {
          name: draft.name.trim() || "Draft", title: draft.title.trim() || draft.name.trim() || "Draft",
          validityDays: Number(draft.validityDays) || 1, requiredApprovals: Number(draft.requiredApprovals) || 1,
          claimSchema: fieldsToSchema(draft.fields),
          certificate: {
            enabled: true,
            heading: draft.certHeading.trim() || undefined,
            subheading: draft.certSubheading.trim() || undefined,
            claimOrder: draft.certClaimKeys.length ? draft.certClaimKeys : undefined,
            logoDocumentId: draft.certLogoDocumentId || undefined,
            ...(draft.certBackgroundDocumentId
              ? { background: { documentId: draft.certBackgroundDocumentId, ...(draft.certBackgroundSha256 ? { sha256: draft.certBackgroundSha256 } : {}) } }
              : {}),
            ...(placements.length ? { placements } : {}),
          },
        },
      });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { setErr(e instanceof Error ? e.message : "preview failed"); }
  }

  const toggle = (list: string[], v: string): string[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

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
    const placements = withoutStalePlacements(draft.certPlacements, claimKeysOf(draft));
    setBusy(true);
    try {
      await api.addCredentialType(token, useCase.key, {
        name, title: draft.title.trim() || name, validityDays, requiredApprovals, claimSchema,
        ...(draft.certEnabled ? { certificate: {
          enabled: true,
          heading: draft.certHeading.trim() || undefined,
          subheading: draft.certSubheading.trim() || undefined,
          claimOrder: draft.certClaimKeys.length ? draft.certClaimKeys : undefined,
          logoDocumentId: draft.certLogoDocumentId || undefined,
          ...(draft.certBackgroundDocumentId
            ? { background: { documentId: draft.certBackgroundDocumentId, ...(draft.certBackgroundSha256 ? { sha256: draft.certBackgroundSha256 } : {}) } }
            : {}),
          ...(placements.length ? { placements } : {}),
        } } : {}),
      });
      setDraft(emptyTypeDraft());
      setOpen(false);
      onChanged();
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (detail) return <SchemaDetail useCase={useCase} name={detail} onBack={() => setDetail(null)} />;

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Credential Schemas"
        description={`The credential types "${useCase.name}" can issue. Add another schema without touching the ones already in use.`}
        actions={!open ? (
          <button
            onClick={() => setOpen(true)}
            className="rounded-lg bg-brand-600 text-white px-3.5 py-1.5 text-xs font-semibold hover:bg-brand-700"
          >
            + Add a credential schema
          </button>
        ) : undefined}
      />

      <Card title="Existing schemas">
        {useCase.credentialTypes.length === 0 ? (
          <EmptyState icon="doc" title="No credential schemas yet" hint="Add one below to start issuing this type of credential." />
        ) : (
          <div className="divide-y divide-slate-100">
            {useCase.credentialTypes.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => setDetail(t.name)}
                className="w-full py-2.5 flex items-center justify-between gap-3 text-left hover:bg-slate-50/70 -mx-1 px-1 rounded-lg transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900 truncate">{t.title} <span className="text-slate-400 font-normal">({t.name})</span></div>
                  <div className="text-xs text-slate-500">{Object.keys(t.claimSchema.properties).length} claim field(s) · {t.validityDays}d validity · {t.requiredApprovals} approval(s)</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {t.certificate?.enabled && (
                    <span className="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">PDF certificate</span>
                  )}
                  <span className="text-slate-300">→</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {open && (
        <Card title="Add a credential schema">
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

          <div className="mt-3 rounded-lg border border-slate-200 p-3 space-y-2">
            <label className="flex items-center gap-2 text-xs font-medium">
              <input type="checkbox" checked={draft.certEnabled} onChange={(e) => setDraft({ ...draft, certEnabled: e.target.checked })} />
              Issue PDF certificate for this credential type
            </label>
            {draft.certEnabled && (
              <div className="space-y-2 pl-1">
                <input className="w-full rounded border-slate-300 text-xs" placeholder="Certificate heading (e.g. Certificate of Domicile)"
                  value={draft.certHeading} onChange={(e) => setDraft({ ...draft, certHeading: e.target.value })} />
                <input className="w-full rounded border-slate-300 text-xs" placeholder="Subheading (e.g. issuing authority)"
                  value={draft.certSubheading} onChange={(e) => setDraft({ ...draft, certSubheading: e.target.value })} />
                <div className="text-[11px] text-slate-500">Claims to show (none selected ⇒ all):</div>
                <div className="flex flex-wrap gap-1.5">
                  {claimKeysOf(draft).map((k) => (
                    <button type="button" key={k}
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${draft.certClaimKeys.includes(k) ? "border-brand-400 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-500"}`}
                      onClick={() => setDraft({ ...draft, certClaimKeys: toggle(draft.certClaimKeys, k) })}>{k}</button>
                  ))}
                </div>
                <label className="block text-[11px] text-slate-500">
                  Logo / seal (optional):
                  <input type="file" accept="image/png,image/jpeg" className="mt-1 block text-[11px]"
                    onChange={async (e) => {
                      const file = e.target.files?.[0]; if (!file || !token) return;
                      const bytes = new Uint8Array(await file.arrayBuffer());
                      let bin = ""; for (let n = 0; n < bytes.length; n++) bin += String.fromCharCode(bytes[n] as number);
                      try { const r = await api.uploadDocument(token, file.type, btoa(bin)); setDraft((d) => ({ ...d, certLogoDocumentId: r.id })); }
                      catch { setErr("logo upload failed"); }
                    }} />
                  {draft.certLogoDocumentId && <span className="ml-2 text-emerald-600">✓ uploaded</span>}
                </label>
                <details className="rounded border border-slate-200 p-2">
                  <summary className="cursor-pointer text-[11px] font-medium text-brand-700">Design certificate →</summary>
                  <div className="mt-2">
                    <CertificateDesigner
                      backgroundDocumentId={draft.certBackgroundDocumentId || null}
                      artworkObjectUrl={artworkUrl}
                      placements={draft.certPlacements}
                      claimKeys={claimKeysOf(draft)}
                      onChange={(next) => setDraft((d) => ({ ...d, certPlacements: next }))}
                      onUploadArtwork={(file) => { void uploadArtwork(file); }}
                      onPreview={() => { void previewCertificate(); }}
                    />
                  </div>
                </details>
              </div>
            )}
          </div>

          <div className="flex gap-2 mt-3">
            <button
              onClick={() => void submit()}
              disabled={busy}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Adding…" : "Add credential schema"}
            </button>
            <button
              onClick={() => { setOpen(false); setErr(null); }}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:border-brand-400"
            >
              Cancel
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
