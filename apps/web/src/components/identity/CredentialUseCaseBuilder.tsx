import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import { withoutStalePlacements } from "../../lib/identity/certificate-layout.js";
import type { CertificateFieldPlacement, CredentialTypeSpec, CredentialUseCase, HolderPolicy, IssuerBinding, Organization, OrgType, UseCaseTemplate, VerifierBinding } from "../../types.js";
import { CertificateDesigner } from "./CertificateDesigner.js";
import { SchemaFieldEditor, fieldsToSchema, type FieldKind, type FieldRow } from "../shared/SchemaFieldEditor.js";
import { Icon } from "../shared/ui.js";

interface Props {
  onCreated: () => void;
}

/** A credential type being authored — its machine name, label, validity and the
 * editable claim fields (seeded from a starter template or built by hand). */
interface CredTypeDraft {
  name: string;
  title: string;
  validityDays: number;
  requiredApprovals: number;
  fields: FieldRow[];
  templateKey: string;
  certEnabled: boolean;
  certHeading: string;
  certSubheading: string;
  certClaimKeys: string[];
  certLogoDocumentId: string;
  /** EN-F. Full-page artwork; its presence replaces the built-in layout, so the
   *  placements below are inert without it. */
  certBackgroundDocumentId: string;
  certBackgroundSha256: string;
  certPlacements: CertificateFieldPlacement[];
}

const ORG_TYPES: OrgType[] = ["bank", "corporate", "msme", "government", "verifier"];
const STEPS = ["Basics", "Credential types", "Roles", "Review"] as const;

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The claim keys a draft actually declares — unnamed rows contribute nothing to
 *  the emitted schema (see fieldsToSchema), so they are not placeable either. */
const claimKeysOf = (c: CredTypeDraft): string[] => c.fields.map((f) => f.name.trim()).filter(Boolean);

/** Turn a starter template's claim schema into editable field rows. */
function templateToFields(spec: CredentialTypeSpec): FieldRow[] {
  const required = new Set(spec.claimSchema.required ?? []);
  return Object.entries(spec.claimSchema.properties).map(([name, p]) => {
    const kind: FieldKind = p.enum
      ? "enum"
      : p.type === "number"
        ? "number"
        : p.type === "boolean"
          ? "boolean"
          : p.type === "document"
            ? "document"
            : "string";
    return {
      name,
      kind,
      required: required.has(name),
      enumValues: p.enum ? p.enum.join(", ") : undefined,
      pattern: p.pattern,
    };
  });
}

const emptyCredType = (): CredTypeDraft => ({
  name: "", title: "", validityDays: 365, requiredApprovals: 1, fields: [], templateKey: "",
  certEnabled: false, certHeading: "", certSubheading: "", certClaimKeys: [], certLogoDocumentId: "",
  certBackgroundDocumentId: "", certBackgroundSha256: "", certPlacements: [],
});

/** Guided 4-step wizard that authors a CredentialUseCase (POST /credential-use-cases). */
export function CredentialUseCaseBuilder({ onCreated }: Props): JSX.Element {
  const { token } = useAuth();
  const [step, setStep] = useState(0);

  const [templates, setTemplates] = useState<Record<string, CredentialTypeSpec>>({});
  const [orgs, setOrgs] = useState<Organization[]>([]);

  // Step 1 — Basics
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");

  // Step 2 — Credential types
  const [credTypes, setCredTypes] = useState<CredTypeDraft[]>([emptyCredType()]);

  // Step 3 — Roles
  const [issuerKind, setIssuerKind] = useState<IssuerBinding["kind"]>("platform");
  const [issuerOrgId, setIssuerOrgId] = useState("");
  const [holderWho, setHolderWho] = useState<HolderPolicy["who"]>("any-onboarded");
  const [holderOrgTypes, setHolderOrgTypes] = useState<OrgType[]>([]);
  const [holderOrgIds, setHolderOrgIds] = useState<string[]>([]);
  const [verifierKind, setVerifierKind] = useState<VerifierBinding["kind"]>("any");
  const [verifierOrgIds, setVerifierOrgIds] = useState<string[]>([]);
  const [holderAcceptance, setHolderAcceptance] = useState(false);

  // Step 4 — create
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 4 — save as template (a lightweight, unparameterized snapshot of the
  // authored definition — see buildTemplate below).
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateCategory, setTemplateCategory] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateSaved, setTemplateSaved] = useState(false);

  useEffect(() => {
    if (!token) return;
    void api.credentialTemplates(token).then(setTemplates).catch(() => setTemplates({}));
    void api.orgs(token).then(setOrgs).catch(() => setOrgs([]));
  }, [token]);

  // ---------- EN-F: certificate artwork, fetched for the designer canvas ------
  /**
   * Object URLs for uploaded artwork, keyed by document id. `GET /documents/:id`
   * requires a bearer token, so an `<img src="/api/v1/documents/…">` would 401 —
   * the bytes are fetched here and handed to the designer as an object URL.
   */
  const [artworkUrls, setArtworkUrls] = useState<Record<string, string>>({});
  /** Ids already fetched or in flight. A REF, not the state above: two renders
   *  in the same tick both read the pre-update state, so a state guard would
   *  start two downloads for one id and leak the loser's object URL. */
  const artworkFetched = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!token) return;
    for (const id of credTypes.map((c) => c.certBackgroundDocumentId).filter(Boolean)) {
      if (artworkFetched.current.has(id)) continue;
      artworkFetched.current.add(id);
      void api
        .downloadDocument(token, id)
        .then((b) => setArtworkUrls((m) => ({ ...m, [id]: URL.createObjectURL(b) })))
        // Retryable: a dangling id renders the empty canvas, and clearing the
        // mark lets a later render try again rather than never.
        .catch(() => artworkFetched.current.delete(id));
    }
  }, [credTypes, token]);

  /**
   * Each object URL pins its blob in memory until it is revoked, and the wizard
   * can outlive several artwork uploads. The ref mirrors the map so the UNMOUNT
   * cleanup revokes the latest set — an effect depending on `artworkUrls` would
   * instead revoke each URL the moment the next upload replaced the map, while
   * the canvas was still displaying it.
   */
  const artworkUrlsRef = useRef(artworkUrls);
  artworkUrlsRef.current = artworkUrls;
  useEffect(
    () => () => {
      for (const url of Object.values(artworkUrlsRef.current)) URL.revokeObjectURL(url);
    },
    [],
  );

  // ---------- derived validation ----------
  const keyValid = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key);
  const step1Valid = name.trim().length > 0 && keyValid;

  const namedCredTypes = credTypes.filter((c) => c.name.trim());
  const dupCredName = new Set(namedCredTypes.map((c) => c.name.trim())).size !== namedCredTypes.length;
  const step2Valid = namedCredTypes.length > 0 && !dupCredName && credTypes.every((c) => c.validityDays > 0);

  const step3Valid =
    (issuerKind === "platform" || (issuerKind === "org" && !!issuerOrgId)) &&
    (holderWho === "any-onboarded" ||
      (holderWho === "orgType" && holderOrgTypes.length > 0) ||
      (holderWho === "specific" && holderOrgIds.length > 0)) &&
    (verifierKind === "any" || (verifierKind === "orgs" && verifierOrgIds.length > 0));

  const stepValid = [step1Valid, step2Valid, step3Valid, step1Valid && step2Valid && step3Valid];
  const canCreate = step1Valid && step2Valid && step3Valid;

  function onNameChange(v: string): void {
    setName(v);
    if (!keyTouched) setKey(slugify(v));
  }

  // ---------- credential type helpers ----------
  const patchCredType = (i: number, patch: Partial<CredTypeDraft>): void =>
    setCredTypes((arr) => arr.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  function applyTemplate(i: number, templateKey: string): void {
    const spec = templates[templateKey];
    if (!spec) {
      patchCredType(i, { templateKey: "" });
      return;
    }
    // A saved template CARRIES its certificate config (buildTemplate below copies
    // it verbatim), so seeding from one has to load the design back or the
    // artwork and every placement on it are silently dropped the moment the
    // template is chosen — the one path in this create-only wizard where an
    // existing design is re-opened.
    const cert = spec.certificate;
    patchCredType(i, {
      templateKey,
      name: spec.name,
      title: spec.title,
      validityDays: spec.validityDays,
      requiredApprovals: spec.requiredApprovals,
      fields: templateToFields(spec),
      certEnabled: cert?.enabled ?? false,
      certHeading: cert?.heading ?? "",
      certSubheading: cert?.subheading ?? "",
      certClaimKeys: cert?.claimOrder ?? [],
      certLogoDocumentId: cert?.logoDocumentId ?? "",
      certBackgroundDocumentId: cert?.background?.documentId ?? "",
      certBackgroundSha256: cert?.background?.sha256 ?? "",
      certPlacements: cert?.placements ?? [],
    });
  }

  /** Store certificate artwork and hang its document id on the draft. Same
   *  base64 upload the logo input above uses. */
  async function uploadArtwork(i: number, file: File): Promise<void> {
    if (!token) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let n = 0; n < bytes.length; n++) bin += String.fromCharCode(bytes[n] as number);
    try {
      const r = await api.uploadDocument(token, file.type, btoa(bin));
      patchCredType(i, { certBackgroundDocumentId: r.id, certBackgroundSha256: r.sha256 });
    } catch {
      setError("artwork upload failed");
    }
  }

  /** Render the DRAFT design server-side and open the PDF. The canvas is only an
   *  approximation of the PDF renderer's text layout, so this is the only honest
   *  answer to "what will actually print". Always comes back stamped SAMPLE. */
  async function previewCertificate(c: CredTypeDraft): Promise<void> {
    if (!token) return;
    const placements = withoutStalePlacements(c.certPlacements, claimKeysOf(c));
    // Opened SYNCHRONOUSLY, in the same tick as the click — a popup blocker
    // only recognises window.open as a direct response to a user gesture
    // while that gesture is still live, and it is gone by the time an
    // `await` resumes. Opening blank now and pointing it at the blob once
    // the fetch resolves keeps the tab inside the gesture instead of after it.
    const win = window.open("", "_blank");
    try {
      const blob = await api.previewCertificate(token, {
        credentialType: {
          name: c.name.trim() || "Draft",
          title: c.title.trim() || c.name.trim() || "Draft",
          validityDays: c.validityDays,
          requiredApprovals: c.requiredApprovals,
          claimSchema: fieldsToSchema(c.fields),
          certificate: {
            enabled: true,
            heading: c.certHeading.trim() || undefined,
            subheading: c.certSubheading.trim() || undefined,
            claimOrder: c.certClaimKeys.length ? c.certClaimKeys : undefined,
            logoDocumentId: c.certLogoDocumentId || undefined,
            ...(c.certBackgroundDocumentId
              ? { background: { documentId: c.certBackgroundDocumentId, ...(c.certBackgroundSha256 ? { sha256: c.certBackgroundSha256 } : {}) } }
              : {}),
            ...(placements.length ? { placements } : {}),
          },
        },
      });
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url; else window.open(url, "_blank");
      // Revoking immediately would race the new tab's own load of the blob, so
      // hold it briefly; without any revoke every preview leaks a whole PDF.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      win?.close();
      setError(e instanceof Error ? e.message : "preview failed");
    }
  }

  // ---------- multi-select toggles ----------
  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  function buildDefinition(): CredentialUseCase {
    const issuer: IssuerBinding = issuerKind === "org" ? { kind: "org", orgId: issuerOrgId } : { kind: "platform" };
    const holderPolicy: HolderPolicy =
      holderWho === "orgType"
        ? { who: "orgType", orgTypes: holderOrgTypes }
        : holderWho === "specific"
          ? { who: "specific", orgIds: holderOrgIds }
          : { who: "any-onboarded" };
    const verifier: VerifierBinding = verifierKind === "orgs" ? { kind: "orgs", orgIds: verifierOrgIds } : { kind: "any" };
    return {
      key: key.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      credentialTypes: credTypes
        .filter((c) => c.name.trim())
        .map((c) => {
          // A placement whose claim was renamed or deleted after it was placed
          // would make the server reject the WHOLE use case; it could not print
          // anything either way, so it is dropped here. The designer warns about
          // them, so this is never the first the author hears of it.
          const placements = withoutStalePlacements(c.certPlacements, claimKeysOf(c));
          return {
            name: c.name.trim(), title: c.title.trim() || c.name.trim(),
            validityDays: c.validityDays, requiredApprovals: c.requiredApprovals,
            claimSchema: fieldsToSchema(c.fields),
            ...(c.certEnabled ? { certificate: {
              enabled: true,
              heading: c.certHeading.trim() || undefined,
              subheading: c.certSubheading.trim() || undefined,
              claimOrder: c.certClaimKeys.length ? c.certClaimKeys : undefined,
              logoDocumentId: c.certLogoDocumentId || undefined,
              ...(c.certBackgroundDocumentId
                ? { background: { documentId: c.certBackgroundDocumentId, ...(c.certBackgroundSha256 ? { sha256: c.certBackgroundSha256 } : {}) } }
                : {}),
              ...(placements.length ? { placements } : {}),
            } } : {}),
          };
        }),
      issuer,
      holderPolicy,
      verifier,
      ...(holderAcceptance ? { holderAcceptance: true } : {}),
    };
  }

  /** Turn the currently-authored definition into a saveable, unparameterized
   * `UseCaseTemplate` — `parameters: []` and a `body` whose keyTemplate/nameTemplate
   * are the literal current key/name (no `${param}` interpolation). This mirrors
   * the definition exactly, so instantiating the saved template always reproduces
   * this same use case.
   * TODO(ID-G follow-up): offer turning specific fields (issuer org name, validity
   * days, etc.) into real `${param}` placeholders so a saved template can be
   * reused across issuers instead of only replaying this one configuration. */
  function buildTemplate(tName: string, category: string): UseCaseTemplate {
    const def = buildDefinition();
    return {
      key: slugify(tName) || def.key,
      name: tName.trim(),
      category: category.trim() || "custom",
      parameters: [],
      body: {
        keyTemplate: def.key,
        nameTemplate: def.name,
        descriptionTemplate: def.description,
        credentialTypes: def.credentialTypes.map((ct) => ({
          name: ct.name,
          title: ct.title,
          validityDays: ct.validityDays,
          requiredApprovals: ct.requiredApprovals,
          required: ct.claimSchema.required ?? [],
          properties: ct.claimSchema.properties,
          ...(ct.certificate ? { certificate: ct.certificate } : {}),
        })),
        holderPolicy: def.holderPolicy,
        verifier: def.verifier,
        ...(def.holderAcceptance ? { holderAcceptance: true } : {}),
      },
      builtIn: false,
    };
  }

  async function saveAsTemplate(): Promise<void> {
    if (!token) return;
    setTemplateBusy(true);
    setTemplateError(null);
    try {
      await api.saveUseCaseTemplate(token, buildTemplate(templateName, templateCategory));
      setTemplateSaved(true);
      setShowSaveTemplate(false);
    } catch (err) {
      setTemplateError(err instanceof ApiError ? err.message : "Could not save template");
    } finally {
      setTemplateBusy(false);
    }
  }

  async function create(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.createCredentialUseCase(token, buildDefinition());
      if ("proposal" in res) {
        // 202: an OrgAdmin's request is gated — nothing is created until a
        // PlatformAdmin approves it (mirrors the tokenization use-case builder).
        setNotice(`Use case submitted (${res.proposal.id.slice(0, 8)}…) — pending platform approval in Approvals.`);
      } else {
        onCreated();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create credential use case");
    } finally {
      setBusy(false);
    }
  }

  const orgLabel = (id: string): string => orgs.find((o) => o.id === id)?.name ?? id;

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm">
      <div className="flex flex-col md:flex-row">
        {/* progress rail */}
        <nav className="md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-slate-100 p-4 md:p-5">
          <ol className="flex md:flex-col gap-1 md:gap-0.5 overflow-x-auto">
            {STEPS.map((label, i) => {
              const reachable = i <= step || STEPS.slice(0, i).every((_, j) => stepValid[j]);
              const current = i === step;
              const done = stepValid[i] && i < step;
              return (
                <li key={label}>
                  <button
                    type="button"
                    disabled={!reachable}
                    onClick={() => reachable && setStep(i)}
                    className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap ${
                      current ? "bg-brand-50 text-brand-700 font-semibold" : "text-slate-600 hover:bg-slate-50"
                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${
                        done ? "bg-emerald-100 text-emerald-700" : current ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {done ? <Icon name="check" className="w-3.5 h-3.5" /> : i + 1}
                    </span>
                    {label}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* step pane */}
        <div className="flex-1 p-5 md:p-6 min-w-0">
          {step === 0 && (
            <div className="space-y-5">
              <StepIntro title="Basics" hint="Name the credential use case — the key identifies it in the API." />
              <div className="grid sm:grid-cols-2 gap-4">
                <L label="Name">
                  <input className="input" value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="e.g. Corporate Trade Credentials" />
                </L>
                <L label="Key (unique id)" hint="Lowercase, hyphen-separated — used in the API">
                  <input
                    className="input"
                    value={key}
                    onChange={(e) => {
                      setKeyTouched(true);
                      setKey(slugify(e.target.value));
                    }}
                    placeholder="e.g. corp-trade-credentials"
                  />
                  {key && !keyValid && <span className="block text-[11px] text-red-600 mt-1">Lowercase letters, digits and hyphens only.</span>}
                </L>
              </div>
              <L label="Description">
                <textarea
                  className="input resize-y min-h-[72px]"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What these credentials represent and who they are for"
                />
              </L>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <StepIntro title="Credential types" hint="Each type is a claim schema. Start from a template or build fields by hand." />
              <div className="space-y-5">
                {credTypes.map((ct, i) => (
                  <section key={i} className="rounded-xl border border-slate-200 p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Credential type {i + 1}</span>
                      {credTypes.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setCredTypes((arr) => arr.filter((_, j) => j !== i))}
                          className="text-slate-400 hover:text-red-500 text-xs font-medium"
                        >
                          remove
                        </button>
                      )}
                    </div>
                    <L label="Start from template" hint="Prefills name, title, validity and fields — everything stays editable">
                      <select className="select" value={ct.templateKey} onChange={(e) => applyTemplate(i, e.target.value)}>
                        <option value="">— none —</option>
                        {Object.entries(templates).map(([tk, spec]) => (
                          <option key={tk} value={tk}>
                            {spec.title} ({spec.name})
                          </option>
                        ))}
                      </select>
                    </L>
                    <div className="grid sm:grid-cols-4 gap-4">
                      <L label="Name" hint="Machine name, e.g. MCACredential">
                        <input className="input" value={ct.name} onChange={(e) => patchCredType(i, { name: e.target.value })} placeholder="KycCredential" />
                      </L>
                      <L label="Title">
                        <input className="input" value={ct.title} onChange={(e) => patchCredType(i, { title: e.target.value })} placeholder="KYC Verification" />
                      </L>
                      <L label="Validity (days)">
                        <input
                          className="input"
                          type="number"
                          min="1"
                          value={ct.validityDays}
                          onChange={(e) => patchCredType(i, { validityDays: Number(e.target.value) })}
                        />
                      </L>
                      <L label="Approvals" hint="Maker-checker approvals to issue">
                        <input
                          className="input"
                          type="number"
                          min="1"
                          value={ct.requiredApprovals}
                          onChange={(e) => patchCredType(i, { requiredApprovals: Number(e.target.value) })}
                        />
                      </L>
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Claim fields</div>
                      <SchemaFieldEditor fields={ct.fields} onChange={(f) => patchCredType(i, { fields: f })} />
                    </div>
                    <div className="mt-3 rounded-lg border border-slate-200 p-3 space-y-2">
                      <label className="flex items-center gap-2 text-xs font-medium">
                        <input type="checkbox" checked={ct.certEnabled} onChange={(e) => patchCredType(i, { certEnabled: e.target.checked })} />
                        Issue PDF certificate for this credential type
                      </label>
                      {ct.certEnabled && (
                        <div className="space-y-2 pl-1">
                          <input className="w-full rounded border-slate-300 text-xs" placeholder="Certificate heading (e.g. Certificate of Domicile)"
                            value={ct.certHeading} onChange={(e) => patchCredType(i, { certHeading: e.target.value })} />
                          <input className="w-full rounded border-slate-300 text-xs" placeholder="Subheading (e.g. issuing authority)"
                            value={ct.certSubheading} onChange={(e) => patchCredType(i, { certSubheading: e.target.value })} />
                          <div className="text-[11px] text-slate-500">Claims to show (none selected ⇒ all):</div>
                          <div className="flex flex-wrap gap-1.5">
                            {ct.fields.map((f) => f.name).filter(Boolean).map((k) => (
                              <button type="button" key={k}
                                className={`rounded-full border px-2 py-0.5 text-[11px] ${ct.certClaimKeys.includes(k) ? "border-brand-400 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-500"}`}
                                onClick={() => patchCredType(i, { certClaimKeys: toggle(ct.certClaimKeys, k) })}>{k}</button>
                            ))}
                          </div>
                          <label className="block text-[11px] text-slate-500">
                            Logo / seal (optional):
                            <input type="file" accept="image/png,image/jpeg" className="mt-1 block text-[11px]"
                              onChange={async (e) => {
                                const file = e.target.files?.[0]; if (!file || !token) return;
                                const bytes = new Uint8Array(await file.arrayBuffer());
                                let bin = ""; for (let n = 0; n < bytes.length; n++) bin += String.fromCharCode(bytes[n] as number);
                                try { const r = await api.uploadDocument(token, file.type, btoa(bin)); patchCredType(i, { certLogoDocumentId: r.id }); }
                                catch { setError("logo upload failed"); }
                              }} />
                            {ct.certLogoDocumentId && <span className="ml-2 text-emerald-600">✓ uploaded</span>}
                          </label>
                          <details className="rounded border border-slate-200 p-2">
                            <summary className="cursor-pointer text-[11px] font-medium text-brand-700">Design certificate →</summary>
                            <div className="mt-2">
                              <CertificateDesigner
                                backgroundDocumentId={ct.certBackgroundDocumentId || null}
                                artworkObjectUrl={artworkUrls[ct.certBackgroundDocumentId] ?? null}
                                placements={ct.certPlacements}
                                claimKeys={claimKeysOf(ct)}
                                onChange={(next) => patchCredType(i, { certPlacements: next })}
                                onUploadArtwork={(file) => { void uploadArtwork(i, file); }}
                                onPreview={() => { void previewCertificate(ct); }}
                              />
                            </div>
                          </details>
                        </div>
                      )}
                    </div>
                  </section>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setCredTypes((arr) => [...arr, emptyCredType()])}
                className="text-xs text-brand-600 hover:text-brand-700 font-medium"
              >
                + add credential type
              </button>
              {dupCredName && <p className="text-xs text-red-600">Two credential types share the same name — names must be unique.</p>}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <StepIntro title="Roles" hint="Who issues these credentials, who may hold them, and who may verify them." />

              <section className="rounded-lg border border-slate-200 p-4 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Issuer</div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <Radio checked={issuerKind === "platform"} onChange={() => setIssuerKind("platform")}>The platform</Radio>
                  <Radio checked={issuerKind === "org"} onChange={() => setIssuerKind("org")}>A specific organization</Radio>
                </div>
                {issuerKind === "org" && (
                  <L label="Issuer organization">
                    <select className="select" value={issuerOrgId} onChange={(e) => setIssuerOrgId(e.target.value)}>
                      <option value="">— select —</option>
                      {orgs.map((o) => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                      ))}
                    </select>
                  </L>
                )}
              </section>

              <section className="rounded-lg border border-slate-200 p-4 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Holders</div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <Radio checked={holderWho === "any-onboarded"} onChange={() => setHolderWho("any-onboarded")}>Any onboarded org</Radio>
                  <Radio checked={holderWho === "orgType"} onChange={() => setHolderWho("orgType")}>By org type</Radio>
                  <Radio checked={holderWho === "specific"} onChange={() => setHolderWho("specific")}>Specific orgs</Radio>
                </div>
                {holderWho === "orgType" && (
                  <div className="flex flex-wrap gap-2">
                    {ORG_TYPES.map((t) => (
                      <Chip key={t} active={holderOrgTypes.includes(t)} onClick={() => setHolderOrgTypes((s) => toggle(s, t))}>{t}</Chip>
                    ))}
                  </div>
                )}
                {holderWho === "specific" && (
                  <div className="flex flex-wrap gap-2">
                    {orgs.length === 0 && <span className="text-xs text-slate-400">No organizations available.</span>}
                    {orgs.map((o) => (
                      <Chip key={o.id} active={holderOrgIds.includes(o.id)} onClick={() => setHolderOrgIds((s) => toggle(s, o.id))}>{o.name}</Chip>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-lg border border-slate-200 p-4 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Verifiers</div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <Radio checked={verifierKind === "any"} onChange={() => setVerifierKind("any")}>Anyone</Radio>
                  <Radio checked={verifierKind === "orgs"} onChange={() => setVerifierKind("orgs")}>Specific orgs</Radio>
                </div>
                {verifierKind === "orgs" && (
                  <div className="flex flex-wrap gap-2">
                    {orgs.length === 0 && <span className="text-xs text-slate-400">No organizations available.</span>}
                    {orgs.map((o) => (
                      <Chip key={o.id} active={verifierOrgIds.includes(o.id)} onClick={() => setVerifierOrgIds((s) => toggle(s, o.id))}>{o.name}</Chip>
                    ))}
                  </div>
                )}
                <label className="flex items-center gap-2 text-xs font-medium mt-3">
                  <input type="checkbox" checked={holderAcceptance} onChange={(e) => setHolderAcceptance(e.target.checked)} />
                  Require holder acceptance
                </label>
                <p className="text-[11px] text-slate-500 mt-1">Issued credentials stay pending until the holder accepts, rejects, or requests changes.</p>
              </section>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <StepIntro title="Review & create" hint="Confirm the credential use case before it is authored." />
              <div className="grid gap-3 sm:grid-cols-2">
                <SummaryTile label="Basics">
                  <div className="text-sm font-semibold text-slate-800">{name || "—"}</div>
                  <div className="text-xs text-slate-500">{key}</div>
                  {description && <div className="text-xs text-slate-500 mt-1">{description}</div>}
                </SummaryTile>
                <SummaryTile label="Credential types">
                  <div className="text-sm font-semibold text-slate-800">{namedCredTypes.length}</div>
                  <div className="text-xs text-slate-500">{namedCredTypes.map((c) => c.name.trim()).join(", ") || "—"}</div>
                </SummaryTile>
                <SummaryTile label="Issuer">
                  <div className="text-sm text-slate-700">{issuerKind === "platform" ? "The platform" : `Org: ${orgLabel(issuerOrgId)}`}</div>
                </SummaryTile>
                <SummaryTile label="Holders">
                  <div className="text-sm text-slate-700">
                    {holderWho === "any-onboarded"
                      ? "Any onboarded org"
                      : holderWho === "orgType"
                        ? `Org types: ${holderOrgTypes.join(", ") || "—"}`
                        : `Orgs: ${holderOrgIds.map(orgLabel).join(", ") || "—"}`}
                  </div>
                </SummaryTile>
                <SummaryTile label="Verifiers">
                  <div className="text-sm text-slate-700">{verifierKind === "any" ? "Anyone" : `Orgs: ${verifierOrgIds.map(orgLabel).join(", ") || "—"}`}</div>
                </SummaryTile>
              </div>
              {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}
              {notice && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-2">{notice}</div>}

              <div className="rounded-xl border border-slate-200 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Save as template</div>
                    <p className="text-[11px] text-slate-400 mt-0.5">Publish this configuration to the template catalog so it can be provisioned again later.</p>
                  </div>
                  {!showSaveTemplate && (
                    <button
                      type="button"
                      onClick={() => {
                        setTemplateName(name);
                        setShowSaveTemplate(true);
                        setTemplateSaved(false);
                      }}
                      disabled={!canCreate}
                      className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700 disabled:opacity-40 shrink-0"
                    >
                      Save as template
                    </button>
                  )}
                </div>
                {showSaveTemplate && (
                  <div className="grid sm:grid-cols-2 gap-3 mt-3">
                    <L label="Template name">
                      <input className="input" value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="e.g. Corporate KYC" />
                    </L>
                    <L label="Category">
                      <input className="input" value={templateCategory} onChange={(e) => setTemplateCategory(e.target.value)} placeholder="e.g. Corporate" />
                    </L>
                    <div className="sm:col-span-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void saveAsTemplate()}
                        disabled={templateBusy || !templateName.trim() || !templateCategory.trim()}
                        className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-semibold hover:bg-brand-700 disabled:opacity-50"
                      >
                        {templateBusy ? "Saving…" : "Save template"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowSaveTemplate(false)}
                        disabled={templateBusy}
                        className="rounded-lg border border-slate-200 text-slate-600 px-3.5 py-1.5 text-sm font-medium hover:border-brand-400 hover:text-brand-700"
                      >
                        Cancel
                      </button>
                    </div>
                    {templateError && <div className="sm:col-span-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-1.5">{templateError}</div>}
                  </div>
                )}
                {templateSaved && !showSaveTemplate && <p className="text-xs text-emerald-600 mt-2">Template saved — it now appears in the provisioning catalog.</p>}
              </div>
            </div>
          )}

          {/* footer nav */}
          <div className="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              ← Back
            </button>
            {step < 3 ? (
              <button
                type="button"
                onClick={() => setStep((s) => Math.min(3, s + 1))}
                disabled={!stepValid[step]}
                className="rounded-lg bg-brand-600 text-white px-5 py-2 text-sm font-semibold hover:bg-brand-700 disabled:opacity-50"
              >
                Next →
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void create()}
                disabled={busy || !canCreate}
                className="rounded-lg bg-brand-600 text-white px-5 py-2 text-sm font-semibold hover:bg-brand-700 disabled:opacity-50"
              >
                {busy ? "Creating…" : "Create credential use case"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepIntro({ title, hint }: { title: string; hint: string }): JSX.Element {
  return (
    <div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="text-xs text-slate-500 mt-0.5">{hint}</p>
    </div>
  );
}

function SummaryTile({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400 mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-600 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

function Radio({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="radio" checked={checked} onChange={onChange} />
      <span className="text-slate-700">{children}</span>
    </label>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
        active ? "bg-brand-600 text-white border-brand-600" : "bg-white text-slate-500 border-slate-200 hover:border-brand-400"
      }`}
    >
      {children}
    </button>
  );
}
