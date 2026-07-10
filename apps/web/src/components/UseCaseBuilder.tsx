import { useMemo, useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import type { ChainInfo, PropertySchema, Role, TokenStandard, UseCase } from "../types.js";

interface Props {
  chains: ChainInfo[];
  existing: UseCase[];
  onCreated: () => void;
}

const STANDARDS: TokenStandard[] = ["ERC-20", "ERC-721", "ERC-3643"];
const ALL_ROLES: Role[] = ["UseCaseAdmin", "Issuer", "Buyer", "Auditor"];
type FieldKind = "string" | "number" | "boolean" | "enum" | "document";
interface FieldRow {
  name: string;
  kind: FieldKind;
  required: boolean;
  enumValues?: string;
  min?: string;
  max?: string;
  pattern?: string;
}

export function UseCaseBuilder({ chains, existing, onCreated }: Props): JSX.Element {
  const { token, user } = useAuth();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [standard, setStandard] = useState<TokenStandard>("ERC-20");
  // Default to a live chain so the use case has at least one deployable target.
  const firstChain = (chains.find((c) => c.available !== false) ?? chains[0])?.id ?? "besu";
  const [allowedChainIds, setAllowedChainIds] = useState<string[]>([firstChain]);
  const [defaultChainId, setDefaultChainId] = useState(firstChain);
  const [fields, setFields] = useState<FieldRow[]>([{ name: "issuer", kind: "string", required: true }]);
  const [lifecycle, setLifecycle] = useState({ mint: true, transfer: true, burn: true, freeze: true });
  const [compliance, setCompliance] = useState({ allowlist: true, transferRestrictions: true });
  const [maxHolders, setMaxHolders] = useState("");
  const [lockupDays, setLockupDays] = useState("");
  const [allowedJurisdictions, setAllowedJurisdictions] = useState("");
  const [marketplaceBps, setMarketplaceBps] = useState("");
  const [issuanceFlat, setIssuanceFlat] = useState("");
  const [defaultUnitPrice, setDefaultUnitPrice] = useState("");
  const [defaultCurrency, setDefaultCurrency] = useState("");
  const [roles, setRoles] = useState<Role[]>([...ALL_ROLES]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tokenType = standard === "ERC-721" ? "nonfungible" : "fungible";
  const isAdmin = user?.role === "PlatformAdmin";
  // Light guard: a named enum field must have at least one value before we post.
  const hasEmptyEnum = fields.some(
    (f) => f.name.trim() && f.kind === "enum" && !(f.enumValues ?? "").split(",").map((v) => v.trim()).filter(Boolean).length,
  );

  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const defaultOptions = useMemo(
    () => chains.filter((c) => allowedChainIds.includes(c.id)),
    [chains, allowedChainIds],
  );

  if (!isAdmin) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500">
        Only an <span className="font-medium text-slate-700">Platform Admin</span> can create use cases.
      </div>
    );
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const properties: Record<string, PropertySchema> = {};
      for (const f of fields) {
        const nm = f.name.trim();
        if (!nm) continue;
        let prop: PropertySchema;
        if (f.kind === "enum") {
          const values = (f.enumValues ?? "").split(",").map((v) => v.trim()).filter(Boolean);
          prop = { type: "string", enum: values };
        } else if (f.kind === "document") {
          prop = { type: "document" };
        } else if (f.kind === "number") {
          prop = { type: "number" };
          if (f.min?.trim()) prop.min = Number(f.min);
          if (f.max?.trim()) prop.max = Number(f.max);
        } else if (f.kind === "string") {
          prop = { type: "string" };
          if (f.pattern?.trim()) prop.pattern = f.pattern.trim();
        } else {
          prop = { type: "boolean" };
        }
        properties[nm] = prop;
      }

      const complianceOut: UseCase["compliance"] = { ...compliance };
      if (maxHolders.trim()) complianceOut.maxHolders = Number(maxHolders);
      if (lockupDays.trim()) complianceOut.lockupDays = Number(lockupDays);
      const jurisdictions = allowedJurisdictions.split(",").map((v) => v.trim()).filter(Boolean);
      if (jurisdictions.length) complianceOut.allowedJurisdictions = jurisdictions;

      const fees: NonNullable<UseCase["fees"]> = {};
      if (marketplaceBps.trim()) fees.marketplaceBps = Number(marketplaceBps);
      if (issuanceFlat.trim()) fees.issuanceFlat = issuanceFlat.trim();

      const saleTermsDefault: NonNullable<UseCase["saleTermsDefault"]> = {};
      if (defaultUnitPrice.trim()) saleTermsDefault.unitPrice = defaultUnitPrice.trim();
      if (defaultCurrency.trim()) saleTermsDefault.currency = defaultCurrency.trim();

      const def: UseCase = {
        key: key.trim(),
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        description: description.trim() || undefined,
        tokenStandard: standard,
        tokenType,
        allowedChainIds,
        defaultChainId,
        metadataSchema: { type: "object", properties, required: fields.filter((f) => f.required && f.name.trim()).map((f) => f.name.trim()) },
        lifecycle,
        compliance: complianceOut,
        fees: Object.keys(fees).length ? fees : undefined,
        saleTermsDefault: Object.keys(saleTermsDefault).length ? saleTermsDefault : undefined,
        roles,
      };
      const created = await api.createUseCase(token, def);
      const deployed = Object.keys(created.contracts ?? {});
      setOk(
        `Created "${created.name}" (${created.symbol}, ${created.tokenStandard}). ` +
          (deployed.length ? `Contract deployed on: ${deployed.join(", ")}.` : "No contract deployed yet."),
      );
      setKey("");
      setName("");
      setSymbol("");
      setDescription("");
      setFields([{ name: "issuer", kind: "string", required: true }]);
      setMaxHolders("");
      setLockupDays("");
      setAllowedJurisdictions("");
      setMarketplaceBps("");
      setIssuanceFlat("");
      setDefaultUnitPrice("");
      setDefaultCurrency("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create use case");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <form onSubmit={submit} className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-6 space-y-5">
        <h2 className="font-semibold text-slate-900">Create a use case (low-code)</h2>

        <div className="grid grid-cols-2 gap-4">
          <L label="Key (unique id)">
            <input className="input" value={key} onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="e.g. carbon-credit" />
          </L>
          <L label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Carbon Credit" />
          </L>
        </div>

        <L label="Token symbol" hint="The symbol of the use case's contract (deployed on save)">
          <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="e.g. VCU" />
        </L>

        <L label="Description">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this asset type represents" />
        </L>

        <div className="grid grid-cols-2 gap-4">
          <L label="Token standard">
            <select className="select" value={standard} onChange={(e) => setStandard(e.target.value as TokenStandard)}>
              {STANDARDS.map((s) => (
                <option key={s} value={s}>
                  {s} ({s === "ERC-721" ? "non-fungible" : "fungible"})
                </option>
              ))}
            </select>
          </L>
          <L label="Default chain">
            <select className="select" value={defaultChainId} onChange={(e) => setDefaultChainId(e.target.value)}>
              {defaultOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </L>
        </div>

        <L label="Allowed DLTs / chains">
          <div className="flex flex-wrap gap-2">
            {chains.map((c) => {
              const offline = c.available === false;
              return (
                <Chip
                  key={c.id}
                  active={allowedChainIds.includes(c.id)}
                  onClick={() => {
                    const next = toggle(allowedChainIds, c.id);
                    setAllowedChainIds(next.length ? next : [c.id]);
                    // Keep the default on a live chain so there's a deployable target.
                    if (!next.includes(defaultChainId)) {
                      const live = chains.find((x) => next.includes(x.id) && x.available !== false);
                      setDefaultChainId(live?.id ?? next[0] ?? c.id);
                    }
                  }}
                >
                  {c.label}
                  {offline && <span className="ml-1 text-[10px] opacity-70">· not connected</span>}
                </Chip>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-400 mt-1.5">
            Chains marked <span className="italic">not connected</span> (e.g. Besu, MST Blockchain) are supported DLTs you can select now — their
            contract stays pending and deploys once the network is brought online. At least one connected chain must be selected to tokenize.
          </p>
        </L>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-600">Metadata fields</span>
            <button type="button" onClick={() => setFields((f) => [...f, { name: "", kind: "string", required: false }])} className="text-xs text-brand-600 hover:text-brand-700">
              + add field
            </button>
          </div>
          <div className="space-y-2">
            {fields.map((f, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <input className="input flex-1" placeholder="field name" value={f.name} onChange={(e) => setFields((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <select className="select w-32" value={f.kind} onChange={(e) => setFields((arr) => arr.map((x, j) => (j === i ? { ...x, kind: e.target.value as FieldKind } : x)))}>
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                    <option value="enum">enum</option>
                    <option value="document">document (PDF upload / URL)</option>
                  </select>
                  <label className="flex items-center gap-1 text-xs text-slate-500">
                    <input type="checkbox" checked={f.required} onChange={() => setFields((arr) => arr.map((x, j) => (j === i ? { ...x, required: !x.required } : x)))} />
                    req
                  </label>
                  <button type="button" onClick={() => setFields((arr) => arr.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500 text-sm px-1">
                    ×
                  </button>
                </div>
                {f.kind === "enum" && (
                  <input className="input text-xs" placeholder="values (comma-separated)" value={f.enumValues ?? ""} onChange={(e) => setFields((arr) => arr.map((x, j) => (j === i ? { ...x, enumValues: e.target.value } : x)))} />
                )}
                {f.kind === "number" && (
                  <div className="flex gap-2">
                    <input className="input text-xs" type="number" placeholder="min" value={f.min ?? ""} onChange={(e) => setFields((arr) => arr.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))} />
                    <input className="input text-xs" type="number" placeholder="max" value={f.max ?? ""} onChange={(e) => setFields((arr) => arr.map((x, j) => (j === i ? { ...x, max: e.target.value } : x)))} />
                  </div>
                )}
                {f.kind === "string" && (
                  <input className="input text-xs" placeholder="pattern (regex, optional)" value={f.pattern ?? ""} onChange={(e) => setFields((arr) => arr.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <L label="Lifecycle">
            <div className="flex flex-wrap gap-2">
              {(["mint", "transfer", "burn", "freeze"] as const).map((k) => (
                <Chip key={k} active={lifecycle[k]} onClick={() => setLifecycle((l) => ({ ...l, [k]: !l[k] }))}>
                  {k}
                </Chip>
              ))}
            </div>
          </L>
          <L label="Compliance">
            <div className="flex flex-wrap gap-2">
              {(["allowlist", "transferRestrictions"] as const).map((k) => (
                <Chip key={k} active={compliance[k]} onClick={() => setCompliance((c) => ({ ...c, [k]: !c[k] }))}>
                  {k}
                </Chip>
              ))}
            </div>
          </L>
        </div>

        <div className="rounded-lg border border-slate-200 p-4 space-y-3">
          <p className="text-xs font-medium text-slate-600">Compliance rules</p>
          <div className="grid grid-cols-2 gap-4">
            <L label="Max holders" hint="Optional cap on distinct holders">
              <input className="input" type="number" min="0" value={maxHolders} onChange={(e) => setMaxHolders(e.target.value)} placeholder="e.g. 100" />
            </L>
            <L label="Lockup (days)" hint="Optional post-issuance lockup">
              <input className="input" type="number" min="0" value={lockupDays} onChange={(e) => setLockupDays(e.target.value)} placeholder="e.g. 30" />
            </L>
          </div>
          <L label="Allowed jurisdictions" hint="Comma-separated country codes, e.g. US, GB, SG">
            <input className="input" value={allowedJurisdictions} onChange={(e) => setAllowedJurisdictions(e.target.value)} placeholder="US, GB, SG" />
          </L>
        </div>

        <div className="rounded-lg border border-slate-200 p-4 space-y-3">
          <p className="text-xs font-medium text-slate-600">Fees &amp; default sale terms</p>
          <div className="grid grid-cols-2 gap-4">
            <L label="Marketplace fee" hint="basis points, e.g. 250 = 2.5%">
              <input className="input" type="number" min="0" max="10000" value={marketplaceBps} onChange={(e) => setMarketplaceBps(e.target.value)} placeholder="e.g. 250" />
            </L>
            <L label="Issuance flat fee" hint="Optional flat fee (integer)">
              <input className="input" type="number" min="0" step="1" value={issuanceFlat} onChange={(e) => setIssuanceFlat(e.target.value)} placeholder="e.g. 5" />
            </L>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <L label="Default unit price" hint="Pre-fills the issue form's sale price">
              <input className="input" type="number" min="0" value={defaultUnitPrice} onChange={(e) => setDefaultUnitPrice(e.target.value)} placeholder="e.g. 5" />
            </L>
            <L label="Default currency" hint="e.g. USD">
              <input className="input" value={defaultCurrency} onChange={(e) => setDefaultCurrency(e.target.value.toUpperCase())} placeholder="e.g. USD" />
            </L>
          </div>
        </div>

        <L label="Roles">
          <div className="flex flex-wrap gap-2">
            {ALL_ROLES.map((r) => (
              <Chip key={r} active={roles.includes(r)} onClick={() => setRoles((rs) => (toggle(rs, r).length ? toggle(rs, r) : rs))}>
                {r}
              </Chip>
            ))}
          </div>
        </L>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {ok && <p className="text-sm text-emerald-600">{ok}</p>}
        <button type="submit" disabled={busy || !key || !name || !symbol || hasEmptyEnum} className="rounded-lg bg-brand-600 text-white px-5 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50">
          {busy ? "Creating…" : "Create use case"}
        </button>
      </form>

      <div className="bg-white rounded-xl border border-slate-200 p-5 h-fit">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Existing use cases</div>
        <ul className="space-y-2">
          {existing.map((u) => (
            <li key={u.key} className="text-sm">
              <div className="font-medium text-slate-700">{u.name} <span className="text-slate-400 font-normal">· {u.symbol}</span></div>
              <div className="text-[11px] text-slate-400 mb-1">{u.tokenStandard}</div>
              <div className="flex flex-wrap gap-1">
                {u.allowedChainIds.map((cid) => (
                  <ChainDeployBadge key={cid} useCaseKey={u.key} chainId={cid} chain={chains.find((c) => c.id === cid)} deployed={u.contracts?.[cid]} onDeployed={onCreated} />
                ))}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Per-chain deployment status for a use case: a contract link when deployed, or a Deploy button when pending. */
function ChainDeployBadge({
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

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-600 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-medium border ${active ? "bg-brand-600 text-white border-brand-600" : "bg-white text-slate-500 border-slate-200 hover:border-brand-400"}`}
    >
      {children}
    </button>
  );
}
