import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { OrgType, ProvisionResult, TemplateParam, UseCaseTemplateMeta } from "../../types.js";
import { Card, EmptyState, Pill, SectionHeader, Skeleton, TableShell } from "../shared/ui.js";

/** The provisioning issuer-org types the server accepts, in menu order. */
const ORG_TYPES: OrgType[] = ["bank", "corporate", "msme", "government", "verifier"];

type Step = 1 | 2 | 3 | 4;

/** Coerce a raw form value to the JSON type its parameter declares. Text inputs
 * always hold strings; number fields must be sent as JSON numbers and checkboxes
 * as booleans, or the server's template validation rejects them. */
function coerce(param: TemplateParam, raw: unknown): unknown {
  if (param.type === "number") {
    if (raw === "" || raw === undefined || raw === null) return undefined;
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (param.type === "boolean") return Boolean(raw);
  return raw;
}

/** Build the initial param map from each parameter's declared default. */
function defaultsFor(params: TemplateParam[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    if (p.default !== undefined) out[p.name] = p.default;
    else if (p.type === "boolean") out[p.name] = false;
  }
  return out;
}

function StepDots({ step }: { step: Step }): JSX.Element {
  const labels: Record<Step, string> = { 1: "Template", 2: "Parameters", 3: "Provisioning", 4: "Review" };
  return (
    <div className="flex items-center gap-2 mb-5">
      {([1, 2, 3, 4] as Step[]).map((s) => (
        <div key={s} className="flex items-center gap-2">
          <div
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
              s === step
                ? "bg-brand-600 text-white"
                : s < step
                  ? "bg-brand-50 text-brand-700"
                  : "bg-elevated text-muted"
            }`}
          >
            <span className="tabular-nums">{s}</span>
            <span className="hidden sm:inline">{labels[s]}</span>
          </div>
          {s < 4 && <div className="w-4 h-px bg-border" />}
        </div>
      ))}
    </div>
  );
}

export function ProvisionFromTemplate({ onDone }: { onDone?: () => void }): JSX.Element {
  const { token } = useAuth();

  const [step, setStep] = useState<Step>(1);

  // Step 1 — template catalog.
  const [templates, setTemplates] = useState<UseCaseTemplateMeta[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<UseCaseTemplateMeta | null>(null);

  // Step 2 — parameter values (raw, coerced only when leaving the step / previewing).
  const [params, setParams] = useState<Record<string, unknown>>({});

  // Step 3 — provisioning options.
  const [issuerOrgName, setIssuerOrgName] = useState("");
  const [issuerOrgType, setIssuerOrgType] = useState<OrgType>("verifier");
  const [createDeskUsers, setCreateDeskUsers] = useState(true);
  const [deskEmailDomain, setDeskEmailDomain] = useState("");

  // Step 4 — preview + provision.
  const [preview, setPreview] = useState<unknown>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<{ message: string; problems?: string[] } | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<{ message: string; problems?: string[] } | null>(null);

  // Result — replaces the wizard on success.
  const [result, setResult] = useState<ProvisionResult | null>(null);

  useEffect(() => {
    if (!token) return;
    setListError(null);
    api
      .credentialUseCaseTemplates(token)
      .then((r) => setTemplates(r.templates))
      .catch((e) => {
        setTemplates([]);
        setListError(e instanceof ApiError ? e.message : "Failed to load templates");
      });
  }, [token]);

  // Group templates by category for the picker.
  const grouped = useMemo(() => {
    const g = new Map<string, UseCaseTemplateMeta[]>();
    for (const t of templates ?? []) {
      const list = g.get(t.category) ?? [];
      list.push(t);
      g.set(t.category, list);
    }
    return [...g.entries()];
  }, [templates]);

  // The coerced params actually sent to the server.
  const typedParams = useMemo<Record<string, unknown>>(() => {
    if (!selected) return {};
    const out: Record<string, unknown> = {};
    for (const p of selected.parameters) {
      const v = coerce(p, params[p.name]);
      if (v !== undefined) out[p.name] = v;
    }
    return out;
  }, [selected, params]);

  function pickTemplate(t: UseCaseTemplateMeta): void {
    setSelected(t);
    setParams(defaultsFor(t.parameters));
    // Prefill the issuer org name from a same-named param if the template has one.
    const nameParam = t.parameters.find((p) => p.name === "issuerOrgName");
    if (nameParam?.default !== undefined) setIssuerOrgName(String(nameParam.default));
    setStep(2);
  }

  function goReview(): void {
    // A param named issuerOrgName (if present) seeds the org name unless already set.
    const fromParam = params["issuerOrgName"];
    if (!issuerOrgName && typeof fromParam === "string" && fromParam.trim()) setIssuerOrgName(fromParam);
    setStep(4);
    void loadPreview();
  }

  async function loadPreview(): Promise<void> {
    if (!token || !selected) return;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const r = await api.previewUseCaseTemplate(token, selected.key, typedParams);
      setPreview(r.definition);
    } catch (e) {
      if (e instanceof ApiError) setPreviewError({ message: e.message, problems: e.problems });
      else setPreviewError({ message: String(e) });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function doProvision(): Promise<void> {
    if (!token || !selected) return;
    setProvisionError(null);
    setProvisioning(true);
    try {
      const r = await api.provisionUseCase(token, {
        templateKey: selected.key,
        params: typedParams,
        provisioning: {
          issuerOrgName: issuerOrgName.trim(),
          issuerOrgType,
          createDeskUsers,
          deskEmailDomain: createDeskUsers && deskEmailDomain.trim() ? deskEmailDomain.trim() : undefined,
        },
      });
      setResult(r);
    } catch (e) {
      if (e instanceof ApiError) setProvisionError({ message: e.message, problems: e.problems });
      else setProvisionError({ message: String(e) });
    } finally {
      setProvisioning(false);
    }
  }

  // ---- Result panel ---------------------------------------------------------
  if (result) return <ResultPanel result={result} onDone={onDone} />;

  return (
    <div>
      <SectionHeader
        title="Provision from template"
        description="Stand up a credential use case, its issuer organization, and desk logins in one step."
      />
      <Card>
        <StepDots step={step} />

        {/* Step 1 — choose template */}
        {step === 1 && (
          <div>
            {templates === null ? (
              <Skeleton lines={6} />
            ) : listError ? (
              <div className="text-sm text-danger">{listError}</div>
            ) : templates.length === 0 ? (
              <EmptyState icon="spark" title="No templates available" hint="A platform admin has not published any credential use-case templates yet." />
            ) : (
              <div className="space-y-6">
                {grouped.map(([category, items]) => (
                  <div key={category}>
                    <div className="text-[11px] font-semibold text-muted mb-2">{category}</div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {items.map((t) => (
                        <button
                          key={t.key}
                          onClick={() => pickTemplate(t)}
                          className="text-left rounded-xl border border-border p-4 hover:border-brand-400 hover:shadow-sm transition flex flex-col"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="text-sm font-semibold text-fg">{t.name}</div>
                            {t.builtIn && <Pill tone="info">Built-in</Pill>}
                          </div>
                          {t.description && <p className="text-xs text-muted mt-1 line-clamp-3">{t.description}</p>}
                          <div className="mt-3 text-[11px] text-muted">
                            {t.parameters.length} parameter{t.parameters.length === 1 ? "" : "s"}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 2 — parameters */}
        {step === 2 && selected && (
          <div className="max-w-2xl">
            <div className="text-sm font-semibold text-fg mb-1">{selected.name}</div>
            <p className="text-xs text-muted mb-4">Fill in the template parameters.</p>
            {selected.parameters.length === 0 ? (
              <p className="text-sm text-muted">This template takes no parameters.</p>
            ) : (
              <div className="space-y-4">
                {selected.parameters.map((p) => (
                  <ParamField key={p.name} param={p} value={params[p.name]} onChange={(v) => setParams((cur) => ({ ...cur, [p.name]: v }))} />
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 mt-6">
              <button onClick={() => setStep(1)} className="rounded-lg border border-border text-muted px-3.5 py-1.5 text-sm font-medium hover:border-brand-400 hover:text-brand-700">← Back</button>
              <button onClick={() => setStep(3)} className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-semibold hover:bg-brand-700">Next</button>
            </div>
          </div>
        )}

        {/* Step 3 — provisioning options */}
        {step === 3 && selected && (
          <div className="max-w-2xl space-y-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Issuer organization name *</label>
              <input className="input w-full" placeholder="e.g. Acme University" value={issuerOrgName} onChange={(e) => setIssuerOrgName(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Issuer organization type</label>
              <select className="select w-full" value={issuerOrgType} onChange={(e) => setIssuerOrgType(e.target.value as OrgType)}>
                {ORG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={createDeskUsers} onChange={(e) => setCreateDeskUsers(e.target.checked)} />
              Create Issuer / Holder / Verifier desk logins
            </label>
            {createDeskUsers && (
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Desk email domain</label>
                <input className="input w-full" placeholder="e.g. acme.edu" value={deskEmailDomain} onChange={(e) => setDeskEmailDomain(e.target.value)} />
                <p className="text-[11px] text-muted mt-1 prose-measure">Desk logins are minted at this domain (e.g. issuer@acme.edu). Leave blank for a server default.</p>
              </div>
            )}
            <div className="flex items-center gap-2 pt-2">
              <button onClick={() => setStep(2)} className="rounded-lg border border-border text-muted px-3.5 py-1.5 text-sm font-medium hover:border-brand-400 hover:text-brand-700">← Back</button>
              <button
                onClick={goReview}
                disabled={!issuerOrgName.trim()}
                className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-semibold hover:bg-brand-700 disabled:opacity-40"
              >
                Review
              </button>
            </div>
          </div>
        )}

        {/* Step 4 — review + provision */}
        {step === 4 && selected && (
          <div className="max-w-2xl space-y-4">
            <div className="rounded-xl border border-border p-4 text-sm">
              <div className="text-xs font-semibold text-muted mb-2">Will be created</div>
              <ul className="space-y-1 text-fg">
                <li>• Organization <span className="font-medium">{issuerOrgName.trim() || "—"}</span> <span className="text-muted">({issuerOrgType})</span></li>
                <li>• Credential use case from template <span className="font-medium">{selected.name}</span></li>
                {createDeskUsers && (
                  <li>• Issuer / Holder / Verifier logins{deskEmailDomain.trim() ? <> @{deskEmailDomain.trim()}</> : null}</li>
                )}
              </ul>
            </div>

            <div>
              <div className="text-xs font-semibold text-muted mb-2">Preview definition</div>
              {previewLoading ? (
                <Skeleton lines={6} />
              ) : previewError ? (
                <ProblemBox title={previewError.message} problems={previewError.problems} />
              ) : preview !== null ? (
                <>
                  {(() => {
                    const types = (preview as { credentialTypes?: { name: string; certificate?: { enabled?: boolean } }[] })?.credentialTypes ?? [];
                    const certTypes = types.filter((t) => t.certificate?.enabled).map((t) => t.name);
                    return certTypes.length ? (
                      <div className="mb-2 flex items-center gap-1.5 flex-wrap">
                        <Pill tone="info">PDF certificate</Pill>
                        <span className="text-[11px] text-muted">{certTypes.join(", ")}</span>
                      </div>
                    ) : null;
                  })()}
                  <pre className="rounded-xl border border-border bg-elevated p-3 text-[11px] font-mono text-fg overflow-auto max-h-80 whitespace-pre-wrap break-words">
                    {JSON.stringify(preview, null, 2)}
                  </pre>
                </>
              ) : (
                <p className="text-sm text-muted">No preview.</p>
              )}
            </div>

            {provisionError && <ProblemBox title={provisionError.message} problems={provisionError.problems} />}

            <div className="flex items-center gap-2 pt-1">
              <button onClick={() => setStep(3)} disabled={provisioning} className="rounded-lg border border-border text-muted px-3.5 py-1.5 text-sm font-medium hover:border-brand-400 hover:text-brand-700 disabled:opacity-40">← Back</button>
              <button
                onClick={() => void doProvision()}
                disabled={provisioning || previewLoading || !issuerOrgName.trim()}
                className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-semibold hover:bg-brand-700 disabled:opacity-40 inline-flex items-center gap-2"
              >
                {provisioning && <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden="true" />}
                {provisioning ? "Provisioning…" : "Provision"}
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/** One generated parameter input, typed from its declared kind. */
function ParamField({ param, value, onChange }: { param: TemplateParam; value: unknown; onChange: (v: unknown) => void }): JSX.Element {
  const label = (
    <label className="block text-xs font-medium text-muted mb-1">
      {param.label}
      {param.required ? " *" : ""}
    </label>
  );
  const help = param.help ? <p className="text-[11px] text-muted mt-1">{param.help}</p> : null;

  if (param.type === "boolean") {
    return (
      <div>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {param.label}
          {param.required ? " *" : ""}
        </label>
        {help}
      </div>
    );
  }

  if (param.type === "enum") {
    return (
      <div>
        {label}
        <select className="select w-full" value={value === undefined || value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value)}>
          {!param.required && <option value="">—</option>}
          {(param.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        {help}
      </div>
    );
  }

  if (param.type === "number") {
    return (
      <div>
        {label}
        <input
          className="input w-full"
          type="number"
          min={param.min}
          max={param.max}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
        {help}
      </div>
    );
  }

  // text
  return (
    <div>
      {label}
      <input className="input w-full" value={value === undefined || value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />
      {help}
    </div>
  );
}

/** An error box that lists a 400's `problems` array when present. */
function ProblemBox({ title, problems }: { title: string; problems?: string[] }): JSX.Element {
  return (
    <div className="rounded-xl border border-danger/25 bg-danger/10 p-3 text-sm text-danger">
      <div className="font-medium">{title}</div>
      {problems && problems.length > 0 && (
        <ul className="mt-1.5 list-disc pl-5 space-y-0.5 text-xs">
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Success view — the created org, its use case, and (once-only) desk credentials. */
function ResultPanel({ result, onDone }: { result: ProvisionResult; onDone?: () => void }): JSX.Element {
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedRow, setCopiedRow] = useState<string | null>(null);

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — ignore */
    }
  };

  const copyRow = (u: ProvisionResult["deskUsers"][number]): void => {
    void copy(`${u.email}\t${u.password}`).then(() => {
      setCopiedRow(u.email);
      window.setTimeout(() => setCopiedRow((c) => (c === u.email ? null : c)), 1500);
    });
  };

  const copyAll = (): void => {
    const block = result.deskUsers.map((u) => `${u.role}\t${u.email}\t${u.password}`).join("\n");
    void copy(block).then(() => {
      setCopiedAll(true);
      window.setTimeout(() => setCopiedAll(false), 1500);
    });
  };

  return (
    <div>
      <SectionHeader title="Provisioned" description="The organization, credential use case, and desk logins are ready." />
      <div className="space-y-4">
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <Pill tone="ok">Created</Pill>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-xs font-medium text-muted">Organization</dt>
              <dd className="text-fg font-medium">{result.org.name}</dd>
              <dd className="text-[11px] font-mono text-muted break-all">{result.org.did}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted">Credential use case</dt>
              <dd className="text-fg font-medium">{result.useCase.name}</dd>
              <dd className="text-[11px] font-mono text-muted">{result.useCase.key}</dd>
            </div>
          </dl>
        </Card>

        {result.deskUsers.length > 0 && (
          <Card
            title="Desk logins"
            description="Shown once — copy them now. Passwords cannot be retrieved later."
            actions={
              <button onClick={copyAll} className="rounded-lg border border-border text-muted px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700">
                {copiedAll ? "Copied ✓" : "Copy all"}
              </button>
            }
          >
            <TableShell>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Email</th>
                  <th>Password</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.deskUsers.map((u) => (
                  <tr key={u.email}>
                    <td><Pill tone="muted">{u.role}</Pill></td>
                    <td className="font-mono text-xs text-fg break-all">{u.email}</td>
                    <td className="font-mono text-xs text-fg break-all">{u.password}</td>
                    <td className="text-right">
                      <button onClick={() => copyRow(u)} className="text-xs text-brand-600 hover:text-brand-700 font-medium">
                        {copiedRow === u.email ? "Copied ✓" : "Copy"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </Card>
        )}

        <div>
          <button onClick={() => onDone?.()} className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-semibold hover:bg-brand-700">Done</button>
        </div>
      </div>
    </div>
  );
}
