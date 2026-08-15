import { useEffect, useState } from "react";
import { api, ApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import { SANDBOX_IMMUTABLE_NOTE, chainChoicesFor, checkUseCaseDraft, modeBlurb, modeLabel, modeTone } from "../../lib/shared/modes.js";
import type { ChainInfo, ContractCode, Role, TokenStandard, UseCase } from "../../types.js";
import { ContractCodeView } from "./ContractCodeView.js";
import { familyIcon } from "./NetworksPanel.js";
import { SchemaFieldEditor, fieldsToSchema, type FieldRow } from "../shared/SchemaFieldEditor.js";
import { Icon, Pill, Skeleton } from "../shared/ui.js";

interface Props {
  chains: ChainInfo[];
  existing: UseCase[];
  onCreated: () => void;
}

const ALL_ROLES: Role[] = ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"];

const STANDARD_CARDS: { id: TokenStandard; title: string; blurb: string }[] = [
  { id: "ERC-20", title: "ERC-20 · fungible", blurb: "Interchangeable units — receivables, credits, grams of gold." },
  { id: "ERC-721", title: "ERC-721 · non-fungible", blurb: "One-of-a-kind tokens — certificates, deeds, unique assets." },
  { id: "ERC-3643", title: "ERC-3643 · permissioned", blurb: "Identity-gated security token (T-REX) for regulated instruments." },
];

/** Ops the maker-checker workflow can gate behind n approvals. */
const GATED_OPS = ["issue", "mint", "transfer", "burn", "freeze", "cashflow-execute"] as const;

interface Preset {
  id: string;
  label: string;
  fields: FieldRow[];
  rules: {
    lifecycle: { mint: boolean; transfer: boolean; burn: boolean; freeze: boolean };
    allowlist: boolean;
    jurisdictions: string;
    marketplaceBps?: string;
    approvals?: Partial<Record<(typeof GATED_OPS)[number], string>>;
  };
}

/** Compact versions of config/use-cases/{invoice-tokenization,corporate-bond,carbon-credit,gold-egr}.json. */
const PRESETS: Preset[] = [
  {
    id: "invoice",
    label: "Invoice",
    fields: [
      { name: "invoiceNumber", kind: "string", required: true, description: "Invoice No as raised by the seller" },
      { name: "invoiceDate", kind: "string", required: true, description: "Invoice Date (YYYY-MM-DD)", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      { name: "buyerName", kind: "string", required: true, description: "Buyer Name (the corporate obligor who pays at maturity)" },
      { name: "currency", kind: "string", required: true, description: "Invoice currency, e.g. INR" },
      { name: "amount", kind: "number", required: true, description: "Invoice face value (Amount)", min: "1" },
      { name: "dueDate", kind: "string", required: true, description: "Payment Due Date (YYYY-MM-DD)", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      { name: "discountRatePct", kind: "number", required: false, description: "Winning bid discount rate (% p.a.)", min: "0", max: "100" },
      { name: "invoiceDocUrl", kind: "document", required: false, description: "Invoice PDF — only the hash lives on-ledger" },
    ],
    rules: {
      lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
      allowlist: true,
      jurisdictions: "IN",
      approvals: { "cashflow-execute": "1" },
    },
  },
  {
    id: "bond",
    label: "Bond",
    fields: [
      { name: "issuer", kind: "string", required: true, description: "Issuing entity" },
      { name: "isin", kind: "string", required: true, description: "Securities identifier" },
      { name: "faceValue", kind: "number", required: true, description: "Face value per bond" },
      { name: "couponRate", kind: "number", required: false, description: "Annual coupon %" },
      { name: "maturityDate", kind: "string", required: false, description: "ISO date" },
      { name: "currency", kind: "string", required: false, description: "e.g. INR" },
      { name: "rating", kind: "string", required: false, description: "e.g. AA+" },
    ],
    rules: {
      lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
      allowlist: true,
      jurisdictions: "",
      approvals: { issue: "1", "cashflow-execute": "1" },
    },
  },
  {
    id: "carbon",
    label: "Carbon credit",
    fields: [
      { name: "projectName", kind: "string", required: true, description: "Name of the carbon project" },
      { name: "registry", kind: "string", required: true, description: "Issuing registry, e.g. Verra / Gold Standard" },
      { name: "projectId", kind: "string", required: false, description: "Registry project identifier" },
      { name: "vintage", kind: "number", required: true, description: "Vintage year the credits were generated" },
      { name: "methodology", kind: "string", required: false, description: "e.g. VM0042, AR-ACM0003" },
      { name: "country", kind: "string", required: false, description: "Host country (ISO name)" },
      { name: "creditType", kind: "string", required: false, description: "e.g. avoidance / removal" },
    ],
    rules: {
      lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
      allowlist: true,
      jurisdictions: "",
    },
  },
  {
    id: "gold",
    label: "Gold",
    fields: [
      { name: "receiptId", kind: "string", required: true, description: "Electronic Gold Receipt number — one physical deposit, one tokenization" },
      { name: "custodian", kind: "string", required: true, description: "Accredited vault manager holding the physical gold" },
      { name: "vaultLocation", kind: "string", required: true, description: "Physical vault location (city)" },
      { name: "refiner", kind: "string", required: false, description: "LBMA / BIS-accredited refiner of the underlying bars" },
      { name: "purity", kind: "enum", required: true, description: "Fineness of the gold", enumValues: "995, 999, 999.9" },
      { name: "fineWeightGrams", kind: "number", required: true, description: "Total fine-gold grams backing this issuance (1 token = 1 gram)", min: "1" },
      { name: "barSerial", kind: "string", required: false, description: "Serial number(s) of the physical bar(s) in the vault" },
      { name: "depositDate", kind: "string", required: false, description: "Date the gold was deposited (YYYY-MM-DD)", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      { name: "assayCertificateUrl", kind: "document", required: false, description: "Refiner assay / quality certificate (only its hash lives on-ledger)" },
    ],
    rules: {
      lifecycle: { mint: true, transfer: true, burn: true, freeze: true },
      allowlist: true,
      jurisdictions: "IN",
      marketplaceBps: "25",
      approvals: { burn: "1" },
    },
  },
];

const STEPS = ["Basics", "Ledgers", "Asset fields", "Rules", "Review"] as const;

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const suggestSymbol = (name: string): string =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);

/** Guided 5-step wizard that ends in the same POST /use-cases payload the old form built. */
export function UseCaseBuilder({ chains, existing, onCreated }: Props): JSX.Element {
  const { token, user } = useAuth();
  const [step, setStep] = useState(0);

  // Step 1 — Basics
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [showKeyEditor, setShowKeyEditor] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [symbolTouched, setSymbolTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [standard, setStandard] = useState<TokenStandard>("ERC-20");

  // Step 2 — Environment + ledgers.
  //
  // THE ENVIRONMENT IS A CREATE-TIME CHOICE AND APPEARS NOWHERE ELSE. The
  // server refuses to change `sandbox` on an existing use case (409
  // SANDBOX_IMMUTABLE) because flipping it would reclassify everything already
  // issued under it wholesale, so an edit control here would be an affordance
  // the server refuses — the exact defect EN-B's review found twice. Where a use
  // case already exists the console shows its environment as STATE and offers
  // Clone to live instead (PlatformHome's use-case cards).
  const [sandbox, setSandbox] = useState(false);
  // Default to a live chain so there is a deployable target. Chosen from the
  // LIVE choices, not the whole catalog: the sandbox chain is in `/chains` now,
  // and seeding the allowlist with it would build a live use case the server
  // refuses with 400 INVALID_SANDBOX_CHAINS.
  const liveChoices = chainChoicesFor(false, chains);
  const firstChain = (liveChoices.find((c) => c.available !== false) ?? liveChoices[0])?.id ?? "besu";
  const [allowedChainIds, setAllowedChainIds] = useState<string[]>([firstChain]);
  const [defaultChainId, setDefaultChainId] = useState(firstChain);

  // Step 3 — Asset fields
  const [fields, setFields] = useState<FieldRow[]>([{ name: "issuer", kind: "string", required: true }]);
  const [presetApplied, setPresetApplied] = useState<string | null>(null);

  // Step 4 — Rules
  const [lifecycle, setLifecycle] = useState({ mint: true, transfer: true, burn: true, freeze: true });
  const [allowlist, setAllowlist] = useState(true);
  const [transferRestrictions, setTransferRestrictions] = useState(true);
  const [requireVerifiedIdentity, setRequireVerifiedIdentity] = useState(false);
  const [allowedJurisdictions, setAllowedJurisdictions] = useState("");
  const [maxHolders, setMaxHolders] = useState("");
  const [lockupDays, setLockupDays] = useState("");
  const [marketplaceBps, setMarketplaceBps] = useState("");
  const [issuanceFlat, setIssuanceFlat] = useState("");
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [approvals, setApprovals] = useState<Record<string, string>>({});

  // Step 5 — Review / create
  const [previews, setPreviews] = useState<Record<string, { loading: boolean; code?: ContractCode; error?: string }>>({});
  const [previewTab, setPreviewTab] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tokenType = standard === "ERC-721" ? "nonfungible" : "fungible";
  // A PlatformAdmin creates+deploys directly; an OrgAdmin submits a gated proposal
  // (POST /use-cases returns 202). Both may drive the wizard.
  const canConfigure = user?.role === "PlatformAdmin" || user?.role === "OrgAdmin";
  const chainOf = (id: string): ChainInfo | undefined => chains.find((c) => c.id === id);

  // ---------- derived per-step validation ----------
  const keyValid = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key);
  const keyTaken = existing.some((u) => u.key === key);
  const symbolValid = /^[A-Z0-9]{1,6}$/.test(symbol);
  const step1Valid = name.trim().length > 0 && keyValid && !keyTaken && symbolValid;

  // The ledgers this environment may be offered at all. Everything downstream —
  // the picker, the review tiles, the code-preview tabs — reads this, so the two
  // halves of the draft cannot drift into a combination the server refuses.
  const chainChoices = chainChoicesFor(sandbox, chains);
  const hasLiveChain = allowedChainIds.some((id) => chainOf(id)?.available !== false);
  // THE ONE CHECK, shared with `create()` below — the step gate and the submit
  // gate must not be able to disagree about what a valid draft is.
  const draftCheck = checkUseCaseDraft({ sandbox, allowedChainIds, defaultChainId });
  const step2Valid = draftCheck.ok && hasLiveChain;

  const namedFields = fields.filter((f) => f.name.trim());
  const hasEmptyEnum = namedFields.some(
    (f) => f.kind === "enum" && !(f.enumValues ?? "").split(",").map((v) => v.trim()).filter(Boolean).length,
  );
  const hasDuplicateField = new Set(namedFields.map((f) => f.name.trim())).size !== namedFields.length;
  const step3Valid = !hasEmptyEnum && !hasDuplicateField;

  const step4Valid = true;
  const stepValid = [step1Valid, step2Valid, step3Valid, step4Valid, step1Valid && step2Valid && step3Valid];
  const canCreate = step1Valid && step2Valid && step3Valid && step4Valid;

  // ---------- step 1 auto-derivation ----------
  function onNameChange(v: string): void {
    setName(v);
    if (!keyTouched) setKey(slugify(v));
    if (!symbolTouched) setSymbol(suggestSymbol(v));
  }

  // ---------- step 2 selection ----------
  /**
   * Switching environment REPLACES the ledger selection rather than filtering
   * it. Keeping the previous picks would leave a live chain selected under a
   * sandbox use case (or the reverse) — invisible in a picker that no longer
   * renders it, and refused by the server at submit with an error about a chain
   * the operator can no longer see.
   */
  function chooseEnvironment(next: boolean): void {
    if (next === sandbox) return;
    setSandbox(next);
    const choices = chainChoicesFor(next, chains);
    const seed = (choices.find((c) => c.available !== false) ?? choices[0])?.id;
    setAllowedChainIds(seed ? [seed] : []);
    setDefaultChainId(seed ?? "");
    // Contract previews are per chain and the chains just changed underneath.
    setPreviews({});
    setPreviewTab(seed ?? "");
  }

  function toggleChain(id: string): void {
    const next = allowedChainIds.includes(id) ? allowedChainIds.filter((x) => x !== id) : [...allowedChainIds, id];
    const kept = next.length ? next : [id];
    setAllowedChainIds(kept);
    // Keep the default on a live selected chain so there's a deployable target.
    if (!kept.includes(defaultChainId)) {
      const live = chainChoices.find((x) => kept.includes(x.id) && x.available !== false);
      setDefaultChainId(live?.id ?? kept[0] ?? id);
    }
  }
  function starChain(id: string): void {
    if (!allowedChainIds.includes(id)) setAllowedChainIds((s) => [...s, id]);
    setDefaultChainId(id);
  }

  // ---------- step 3 presets ----------
  function applyPreset(p: Preset): void {
    setFields(p.fields.map((f) => ({ ...f })));
    setLifecycle({ ...p.rules.lifecycle });
    setAllowlist(p.rules.allowlist);
    setAllowedJurisdictions(p.rules.jurisdictions);
    setMarketplaceBps(p.rules.marketplaceBps ?? "");
    setApprovals(p.rules.approvals ? Object.fromEntries(Object.entries(p.rules.approvals)) : {});
    if (p.rules.approvals && Object.keys(p.rules.approvals).length) setApprovalsOpen(true);
    setPresetApplied(p.id);
  }

  // ---------- step 5 code preview ----------
  useEffect(() => {
    if (step !== 4) return;
    // Fresh previews on every visit — the inputs may have changed on the way back.
    setPreviews({});
    setPreviewTab((t) => (allowedChainIds.includes(t) ? t : allowedChainIds[0] ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    if (step !== 4 || !token || !previewTab) return;
    if (previews[previewTab]) return;
    setPreviews((p) => ({ ...p, [previewTab]: { loading: true } }));
    api
      .previewCode(token, { tokenStandard: standard, symbol, name, allowlist, chainId: previewTab })
      .then((code) => setPreviews((p) => ({ ...p, [previewTab]: { loading: false, code } })))
      .catch((err) =>
        setPreviews((p) => ({
          ...p,
          [previewTab]: { loading: false, error: err instanceof ApiError ? err.message : "Could not load the contract code" },
        })),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, token, previewTab, previews]);

  // ---------- create (same payload construction as the previous builder) ----------
  async function create(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setError(null);
    setOk(null);
    setNotice(null);
    // THE ENVIRONMENT GATE, at the last moment before the wire. The step gate
    // above reads the same check, but a draft can be reached by clicking back to
    // step 2 and away again — and a mismatched pair is not a validation nicety:
    // a live use case on the sandbox chain would give a real programme an
    // in-memory register, and a sandbox one on Besu would mint real tokens.
    const modeCheck = checkUseCaseDraft({ sandbox, allowedChainIds, defaultChainId });
    if (!modeCheck.ok) { setError(modeCheck.message); setBusy(false); return; }
    try {
      const complianceOut: UseCase["compliance"] = { allowlist, transferRestrictions };
      if (requireVerifiedIdentity) complianceOut.requireVerifiedIdentity = true;
      if (maxHolders.trim()) complianceOut.maxHolders = Number(maxHolders);
      if (lockupDays.trim()) complianceOut.lockupDays = Number(lockupDays);
      const jurisdictions = allowedJurisdictions.split(",").map((v) => v.trim()).filter(Boolean);
      if (jurisdictions.length) complianceOut.allowedJurisdictions = jurisdictions;

      const fees: NonNullable<UseCase["fees"]> = {};
      if (marketplaceBps.trim()) fees.marketplaceBps = Number(marketplaceBps);
      if (issuanceFlat.trim()) fees.issuanceFlat = issuanceFlat.trim();

      const approvalsOut: Record<string, number> = {};
      for (const [op, n] of Object.entries(approvals)) {
        if (n.trim() && Number(n) > 0) approvalsOut[op] = Number(n);
      }

      const def: UseCase = {
        key: key.trim(),
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        description: description.trim() || undefined,
        tokenStandard: standard,
        tokenType,
        // From the CHECK, not from state: the validated pair exists only on the
        // ok arm, so a chain/mode mismatch has nothing to hand this call.
        allowedChainIds: modeCheck.allowedChainIds,
        defaultChainId: modeCheck.defaultChainId,
        sandbox: modeCheck.sandbox,
        metadataSchema: fieldsToSchema(fields),
        lifecycle,
        compliance: complianceOut,
        fees: Object.keys(fees).length ? fees : undefined,
        workflow: Object.keys(approvalsOut).length ? { approvals: approvalsOut } : undefined,
        roles: [...ALL_ROLES],
      };
      const res = await api.createUseCase(token, def);
      if ("proposal" in res) {
        // 202: an OrgAdmin's request is gated — nothing is created until a PlatformAdmin approves.
        setNotice(
          `${modeLabel(modeCheck.mode)} use case submitted (${res.proposal.id.slice(0, 8)}…) — pending platform approval in Approvals.` +
            (modeCheck.sandbox ? " Its environment is fixed once it is approved and cannot be changed afterwards." : ""),
        );
        reset();
      } else {
        const deployed = Object.keys(res.contracts ?? {});
        setOk(
          `Created "${res.name}" (${res.symbol}, ${res.tokenStandard}) in the ${modeLabel(modeCheck.mode)} environment. ` +
            (deployed.length ? `Contract deployed on: ${deployed.join(", ")}.` : "No contract deployed yet.") +
            (modeCheck.sandbox ? " Nothing issued under it is real, and its environment cannot be changed — clone it to live when you are ready." : ""),
        );
        reset();
        onCreated();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create use case");
    } finally {
      setBusy(false);
    }
  }

  function reset(): void {
    setStep(0);
    setName("");
    setKey("");
    setKeyTouched(false);
    setShowKeyEditor(false);
    setSymbol("");
    setSymbolTouched(false);
    setDescription("");
    setStandard("ERC-20");
    // Back to LIVE, deliberately: the next use case an operator builds must not
    // inherit "sandbox" from the last one without their choosing it again.
    setSandbox(false);
    setAllowedChainIds([firstChain]);
    setDefaultChainId(firstChain);
    setFields([{ name: "issuer", kind: "string", required: true }]);
    setPresetApplied(null);
    setLifecycle({ mint: true, transfer: true, burn: true, freeze: true });
    setAllowlist(true);
    setTransferRestrictions(true);
    setAllowedJurisdictions("");
    setMaxHolders("");
    setLockupDays("");
    setMarketplaceBps("");
    setIssuanceFlat("");
    setApprovals({});
    setApprovalsOpen(false);
    setPreviews({});
    setPreviewTab("");
  }

  if (!canConfigure) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 text-sm text-slate-500">
        Only a <span className="font-medium text-slate-700">Platform Admin</span> or an <span className="font-medium text-slate-700">Org Admin</span> can configure use cases.
      </div>
    );
  }

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
          {ok && <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-2">{ok}</div>}
          {notice && <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-2">{notice}</div>}

          {step === 0 && (
            <StepBasics
              name={name}
              onName={onNameChange}
              keyValue={key}
              keyValid={keyValid}
              keyTaken={keyTaken}
              showKeyEditor={showKeyEditor}
              onToggleKeyEditor={() => setShowKeyEditor((s) => !s)}
              onKey={(v) => {
                setKeyTouched(true);
                setKey(slugify(v));
              }}
              symbol={symbol}
              symbolValid={symbolValid}
              onSymbol={(v) => {
                setSymbolTouched(true);
                setSymbol(v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6));
              }}
              description={description}
              onDescription={setDescription}
              standard={standard}
              onStandard={setStandard}
            />
          )}

          {step === 1 && (
            <div className="space-y-4">
              <StepIntro title="Environment & ledgers" hint="Choose the environment first — it decides which ledgers this use case may ever deploy to. The starred chain is the default target for new assets." />

              {/*
                THE ENVIRONMENT CHOICE. Offered here and only here: the server
                fixes `sandbox` at creation (409 SANDBOX_IMMUTABLE), so this
                control has no edit counterpart anywhere in the console.
              */}
              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="sr-only">Environment</legend>
                {([false, true] as const).map((isSandbox) => {
                  const mode = isSandbox ? "test" : "live";
                  const selected = sandbox === isSandbox;
                  return (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => chooseEnvironment(isSandbox)}
                      className={`text-left rounded-xl border p-4 transition ${
                        selected
                          ? isSandbox
                            ? "border-amber-500 bg-amber-50/60 shadow-sm"
                            : "border-brand-500 bg-brand-50/40 shadow-sm"
                          : "border-slate-200 hover:border-brand-300"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-800">{modeLabel(mode)}</span>
                        <Pill tone={modeTone(mode)}>{modeLabel(mode)}</Pill>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">{modeBlurb(mode)}</p>
                    </button>
                  );
                })}
              </fieldset>
              <p className="text-[11px] text-slate-400">{SANDBOX_IMMUTABLE_NOTE}</p>

              <div className="grid gap-3 sm:grid-cols-2">
                {chainChoices.map((c) => {
                  const selected = allowedChainIds.includes(c.id);
                  const isDefault = defaultChainId === c.id;
                  const offline = c.available === false;
                  return (
                    <div
                      key={c.id}
                      role="checkbox"
                      aria-checked={selected}
                      tabIndex={0}
                      onClick={() => toggleChain(c.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleChain(c.id);
                        }
                      }}
                      className={`relative cursor-pointer rounded-xl border p-4 transition ${
                        selected ? "border-brand-500 bg-brand-50/40 shadow-sm" : "border-slate-200 hover:border-brand-300"
                      }`}
                    >
                      {selected && (
                        <span className="absolute top-2 right-2 w-5 h-5 rounded-full bg-brand-600 text-white flex items-center justify-center">
                          <Icon name="check" className="w-3.5 h-3.5" />
                        </span>
                      )}
                      <div className="flex items-center gap-2 pr-6">
                        <span className="text-slate-400">
                          <Icon name={familyIcon(c.family)} className="w-4 h-4" />
                        </span>
                        <span className="text-sm font-semibold text-slate-800">{c.label}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {c.configured === false ? <Pill tone="muted">not configured</Pill> : c.mode === "real" ? <Pill tone="ok">REAL</Pill> : <Pill tone="info">SIMULATED</Pill>}
                        {offline && <span className="text-[11px] text-slate-400">deploys when connected</span>}
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          starChain(c.id);
                        }}
                        title={isDefault ? "Default chain" : "Make this the default chain"}
                        className={`absolute bottom-2.5 right-2.5 text-base leading-none ${isDefault ? "text-amber-500" : "text-slate-300 hover:text-amber-400"}`}
                      >
                        {isDefault ? "★" : "☆"}
                      </button>
                    </div>
                  );
                })}
              </div>
              {chainChoices.length === 0 && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  This deployment&rsquo;s chain catalog has no <span className="font-mono">sandbox</span> ledger, so a sandbox
                  use case cannot be created here. Nothing else is offered on purpose — a sandbox use case that named a real
                  chain would not be a sandbox at all.
                </p>
              )}
              {chainChoices.length > 0 && !hasLiveChain && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Select at least one connected chain — assets cannot be issued until a ledger that is online is in the mix.
                </p>
              )}
              {/* The check's own message, so the reason a step is blocked is the
                  same sentence the submit would have produced. */}
              {!draftCheck.ok && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{draftCheck.message}</p>
              )}
              {sandbox && (
                <p className="text-xs text-slate-500">
                  The sandbox ledger is simulated and always will be: no environment variable promotes it to a real backend.
                  Assets minted here have contract addresses and supply figures that are not on any chain.
                </p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <StepIntro title="Asset fields" hint="The metadata captured for every asset issued under this use case." />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-slate-500">Start from preset:</span>
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${
                      presetApplied === p.id ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-600 hover:border-brand-400"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                {presetApplied && <span className="text-[11px] text-slate-400">preset prefills fields and rules — everything stays editable</span>}
              </div>

              <div className="grid gap-5 lg:grid-cols-2">
                <SchemaFieldEditor fields={fields} onChange={setFields} />

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Issue form preview</div>
                  <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-4 space-y-3">
                    {namedFields.length === 0 && <p className="text-xs text-slate-400">Add fields to see how the issue form will look.</p>}
                    {namedFields.map((f) => (
                      <div key={f.name}>
                        <div className="text-xs font-medium text-slate-600 mb-1">
                          {f.name}
                          {f.required && <span className="text-red-500"> *</span>}
                          <span className="ml-1.5 text-[10px] text-slate-400">{f.kind}</span>
                        </div>
                        {f.kind === "enum" ? (
                          <select className="select text-xs" disabled>
                            <option>{(f.enumValues ?? "").split(",").map((v) => v.trim()).filter(Boolean).join(" / ") || "…"}</option>
                          </select>
                        ) : f.kind === "boolean" ? (
                          <input type="checkbox" disabled />
                        ) : f.kind === "document" ? (
                          <div className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-400">Upload PDF / paste URL</div>
                        ) : (
                          <input className="input text-xs" type={f.kind === "number" ? "number" : "text"} placeholder={f.description || f.name} disabled />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <StepIntro title="Rules" hint="Lifecycle, compliance, fees and approvals — all enforced by the platform on every operation." />

              <section>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Lifecycle</div>
                <div className="flex flex-wrap gap-2">
                  {(["mint", "transfer", "burn", "freeze"] as const).map((k) => (
                    <Toggle key={k} active={lifecycle[k]} onClick={() => setLifecycle((l) => ({ ...l, [k]: !l[k] }))}>
                      {k}
                    </Toggle>
                  ))}
                </div>
              </section>

              <section className="rounded-lg border border-slate-200 p-4 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Compliance</div>
                <div className="flex flex-wrap gap-2">
                  <Toggle active={allowlist} onClick={() => setAllowlist((v) => !v)}>
                    allowlist
                  </Toggle>
                  <Toggle active={transferRestrictions} onClick={() => setTransferRestrictions((v) => !v)}>
                    transferRestrictions
                  </Toggle>
                  <Toggle active={requireVerifiedIdentity} onClick={() => setRequireVerifiedIdentity((v) => !v)}>
                    Require verified identity (DID/VC)
                  </Toggle>
                </div>
                <p className="text-[11px] text-slate-400">
                  Only holders with a valid, unrevoked KYC credential may receive this asset.
                </p>
                <div className="grid sm:grid-cols-3 gap-4">
                  <L label="Allowed jurisdictions" hint="Comma-separated, e.g. US, GB, SG">
                    <input className="input" value={allowedJurisdictions} onChange={(e) => setAllowedJurisdictions(e.target.value)} placeholder="US, GB, SG" />
                  </L>
                  <L label="Max holders" hint="Optional cap on distinct holders">
                    <input className="input" type="number" min="0" value={maxHolders} onChange={(e) => setMaxHolders(e.target.value)} placeholder="e.g. 100" />
                  </L>
                  <L label="Lockup (days)" hint="Optional post-issuance lockup">
                    <input className="input" type="number" min="0" value={lockupDays} onChange={(e) => setLockupDays(e.target.value)} placeholder="e.g. 30" />
                  </L>
                </div>
              </section>

              <section className="rounded-lg border border-slate-200 p-4 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Fees</div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <L label="Marketplace fee" hint="Basis points, e.g. 250 = 2.5%">
                    <input className="input" type="number" min="0" max="10000" value={marketplaceBps} onChange={(e) => setMarketplaceBps(e.target.value)} placeholder="e.g. 250" />
                  </L>
                  <L label="Issuance flat fee" hint="Optional flat fee (integer)">
                    <input className="input" type="number" min="0" step="1" value={issuanceFlat} onChange={(e) => setIssuanceFlat(e.target.value)} placeholder="e.g. 5" />
                  </L>
                </div>
              </section>

              <section className="rounded-lg border border-slate-200 p-4">
                <button type="button" onClick={() => setApprovalsOpen((v) => !v)} className="w-full flex items-center justify-between text-left">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Maker-checker approvals</span>
                  <span className="text-slate-400 text-xs">{approvalsOpen ? "▴ hide" : "▾ show"}</span>
                </button>
                {approvalsOpen && (
                  <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {GATED_OPS.map((op) => (
                      <L key={op} label={op} hint="Approvals required (0 = not gated)">
                        <input
                          className="input"
                          type="number"
                          min="0"
                          max="5"
                          value={approvals[op] ?? ""}
                          onChange={(e) => setApprovals((a) => ({ ...a, [op]: e.target.value }))}
                          placeholder="0"
                        />
                      </L>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-5">
              <StepIntro title="Review & create" hint="Everything the platform will provision — including the contract that deploys per ledger." />

              {sandbox && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs px-4 py-2">
                  <strong className="font-semibold">This will be a sandbox use case.</strong> {modeBlurb("test")} Its
                  environment is fixed at creation — the only way to a real copy is Clone to live, which carries the
                  configuration and none of the data.
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryTile label="Basics">
                  <div className="text-sm font-semibold text-slate-800">{name || "—"}</div>
                  <div className="text-xs text-slate-500">
                    {key} · {symbol} · {standard}
                  </div>
                </SummaryTile>
                <SummaryTile label="Environment">
                  <Pill tone={modeTone(sandbox ? "test" : "live")}>{modeLabel(sandbox ? "test" : "live")}</Pill>
                  <div className="text-xs text-slate-500 mt-1">{modeBlurb(sandbox ? "test" : "live")}</div>
                </SummaryTile>
                <SummaryTile label="Ledgers">
                  <div className="flex flex-wrap gap-1">
                    {allowedChainIds.map((id) => (
                      <Pill key={id} tone={id === defaultChainId ? "info" : "muted"}>
                        {id === defaultChainId ? "★ " : ""}
                        {chainOf(id)?.label ?? id}
                      </Pill>
                    ))}
                  </div>
                </SummaryTile>
                <SummaryTile label="Fields">
                  <div className="text-sm font-semibold text-slate-800">{namedFields.length}</div>
                  <div className="text-xs text-slate-500">{namedFields.filter((f) => f.required).length} required</div>
                </SummaryTile>
                <SummaryTile label="Rules">
                  <div className="flex flex-wrap gap-1">
                    {(["mint", "transfer", "burn", "freeze"] as const).filter((k) => lifecycle[k]).map((k) => (
                      <Pill key={k} tone="muted">
                        {k}
                      </Pill>
                    ))}
                    {allowlist && <Pill tone="ok">allowlist</Pill>}
                    {requireVerifiedIdentity && <Pill tone="ok">verified identity required</Pill>}
                    {allowedJurisdictions.trim() && <Pill tone="info">{allowedJurisdictions}</Pill>}
                    {marketplaceBps.trim() && <Pill tone="warn">{marketplaceBps} bps</Pill>}
                    {Object.entries(approvals).filter(([, n]) => n.trim() && Number(n) > 0).map(([op, n]) => (
                      <Pill key={op} tone="warn">
                        {op}: {n} ✓
                      </Pill>
                    ))}
                  </div>
                </SummaryTile>
              </div>

              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Contract code per ledger</div>
                <div className="flex gap-1 mb-3 flex-wrap">
                  {allowedChainIds.map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setPreviewTab(id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                        previewTab === id ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {chainOf(id)?.label ?? id}
                    </button>
                  ))}
                </div>
                {previewTab && previews[previewTab]?.loading && <Skeleton lines={6} />}
                {previewTab && previews[previewTab]?.error && (
                  <p className="text-sm text-red-600 rounded-lg bg-red-50 border border-red-200 px-4 py-2">{previews[previewTab].error}</p>
                )}
                {previewTab && previews[previewTab]?.code && <ContractCodeView code={previews[previewTab].code} />}
              </div>

              {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">{error}</div>}
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
            {step < 4 ? (
              <button
                type="button"
                onClick={() => setStep((s) => Math.min(4, s + 1))}
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
                {busy ? "Creating…" : `Create ${modeLabel(sandbox ? "test" : "live").toLowerCase()} use case`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepBasics(props: {
  name: string;
  onName: (v: string) => void;
  keyValue: string;
  keyValid: boolean;
  keyTaken: boolean;
  showKeyEditor: boolean;
  onToggleKeyEditor: () => void;
  onKey: (v: string) => void;
  symbol: string;
  symbolValid: boolean;
  onSymbol: (v: string) => void;
  description: string;
  onDescription: (v: string) => void;
  standard: TokenStandard;
  onStandard: (s: TokenStandard) => void;
}): JSX.Element {
  const { name, onName, keyValue, keyValid, keyTaken, showKeyEditor, onToggleKeyEditor, onKey, symbol, symbolValid, onSymbol, description, onDescription, standard, onStandard } = props;
  return (
    <div className="space-y-5">
      <StepIntro title="Basics" hint="Name the asset class — the key, symbol and standard drive everything downstream." />

      <div className="grid sm:grid-cols-2 gap-4">
        <L label="Name">
          <input className="input" value={name} onChange={(e) => onName(e.target.value)} placeholder="e.g. Carbon Credit" />
        </L>
        <L label="Token symbol" hint="Uppercase, up to 6 characters — auto-suggested from the name">
          <input className="input" value={symbol} onChange={(e) => onSymbol(e.target.value)} placeholder="e.g. VCU" />
          {symbol && !symbolValid && <span className="block text-[11px] text-red-600 mt-1">1–6 uppercase letters or digits.</span>}
        </L>
      </div>

      <div className="text-xs text-slate-500">
        Key:{" "}
        <code className="font-mono rounded bg-slate-100 text-slate-700 px-1.5 py-0.5">{keyValue || "—"}</code>
        <button type="button" onClick={onToggleKeyEditor} className="ml-2 text-brand-600 hover:text-brand-700 font-medium">
          {showKeyEditor ? "done" : "advanced"}
        </button>
        {keyTaken && <span className="ml-2 text-red-600">A use case with this key already exists.</span>}
        {keyValue && !keyValid && <span className="ml-2 text-red-600">Lowercase letters, digits and hyphens only.</span>}
      </div>
      {showKeyEditor && (
        <L label="Key (unique id)" hint="Lowercase, hyphen-separated — used in URLs and the API">
          <input className="input" value={keyValue} onChange={(e) => onKey(e.target.value)} placeholder="e.g. carbon-credit" />
        </L>
      )}

      <L label="Description">
        <textarea
          className="input resize-y min-h-[72px]"
          value={description}
          onChange={(e) => onDescription(e.target.value)}
          placeholder="What this asset type represents"
        />
      </L>

      <div>
        <span className="block text-xs font-medium text-slate-600 mb-2">Token standard</span>
        <div className="grid gap-3 sm:grid-cols-3">
          {STANDARD_CARDS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onStandard(s.id)}
              className={`text-left rounded-xl border p-4 transition ${
                standard === s.id ? "border-brand-500 bg-brand-50/40 shadow-sm" : "border-slate-200 hover:border-brand-300"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800">{s.title}</span>
                {standard === s.id && (
                  <span className="w-5 h-5 rounded-full bg-brand-600 text-white flex items-center justify-center shrink-0">
                    <Icon name="check" className="w-3.5 h-3.5" />
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-1">{s.blurb}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Per-chain deployment status for a use case: a contract link when deployed, or a Deploy button when pending. */
export function ChainDeployBadge({
  useCaseKey,
  chainId,
  chain,
  deployed,
  onDeployed,
}: {
  useCaseKey: string;
  chainId: string;
  chain?: ChainInfo;
  deployed?: { contractRef: string };
  onDeployed: () => void;
}): JSX.Element {
  const { token } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const label = chain?.label ?? chainId;

  if (deployed) {
    const href = chain?.explorerUrl && /^0x[0-9a-fA-F]+$/.test(deployed.contractRef)
      ? `${chain.explorerUrl.replace(/\/$/, "")}/address/${deployed.contractRef}`
      : undefined;
    const body = <span title={deployed.contractRef}>⛓ {label}</span>;
    return (
      <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-medium">
        {href ? <a href={href} target="_blank" rel="noreferrer" className="hover:underline">{body}</a> : body}
      </span>
    );
  }

  async function deploy(): Promise<void> {
    if (!token) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deployUseCase(token, useCaseKey, chainId);
      onDeployed();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "deploy failed");
      setBusy(false);
    }
  }

  return (
    <button
      onClick={deploy}
      disabled={busy}
      title={err ?? `Deploy the contract on ${label}`}
      className={`px-1.5 py-0.5 rounded text-[10px] font-medium disabled:opacity-50 ${err ? "bg-red-100 text-red-700" : "bg-slate-200 text-slate-600 hover:bg-slate-300"}`}
    >
      {busy ? "deploying…" : err ? `⚠ ${label}` : `Deploy ${label}`}
    </button>
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

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
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
