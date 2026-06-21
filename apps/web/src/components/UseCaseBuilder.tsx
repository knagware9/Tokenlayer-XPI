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
const ALL_ROLES: Role[] = ["Admin", "Issuer", "Operator", "Viewer"];
interface FieldRow {
  name: string;
  type: PropertySchema["type"];
  required: boolean;
}

export function UseCaseBuilder({ chains, existing, onCreated }: Props): JSX.Element {
  const { token, user } = useAuth();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [standard, setStandard] = useState<TokenStandard>("ERC-20");
  const [allowedChainIds, setAllowedChainIds] = useState<string[]>(["mock"]);
  const [defaultChainId, setDefaultChainId] = useState("mock");
  const [fields, setFields] = useState<FieldRow[]>([{ name: "issuer", type: "string", required: true }]);
  const [lifecycle, setLifecycle] = useState({ mint: true, transfer: true, burn: true, freeze: true });
  const [compliance, setCompliance] = useState({ allowlist: true, transferRestrictions: true });
  const [roles, setRoles] = useState<Role[]>([...ALL_ROLES]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tokenType = standard === "ERC-721" ? "nonfungible" : "fungible";
  const isAdmin = user?.role === "Admin";

  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const defaultOptions = useMemo(
    () => chains.filter((c) => allowedChainIds.includes(c.id)),
    [chains, allowedChainIds],
  );

  if (!isAdmin) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-500">
        Only an <span className="font-medium text-slate-700">Admin</span> can create use cases.
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
      for (const f of fields) if (f.name.trim()) properties[f.name.trim()] = { type: f.type };
      const def: UseCase = {
        key: key.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        tokenStandard: standard,
        tokenType,
        allowedChainIds,
        defaultChainId,
        metadataSchema: { type: "object", properties, required: fields.filter((f) => f.required && f.name.trim()).map((f) => f.name.trim()) },
        lifecycle,
        compliance,
        roles,
      };
      const created = await api.createUseCase(token, def);
      setOk(`Created "${created.name}" (${created.tokenStandard}).`);
      setKey("");
      setName("");
      setDescription("");
      setFields([{ name: "issuer", type: "string", required: true }]);
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
            {chains.map((c) => (
              <Chip
                key={c.id}
                active={allowedChainIds.includes(c.id)}
                onClick={() => {
                  const next = toggle(allowedChainIds, c.id);
                  setAllowedChainIds(next.length ? next : [c.id]);
                  if (!next.includes(defaultChainId)) setDefaultChainId(next[0] ?? c.id);
                }}
              >
                {c.label}
              </Chip>
            ))}
          </div>
        </L>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-600">Metadata fields</span>
            <button type="button" onClick={() => setFields((f) => [...f, { name: "", type: "string", required: false }])} className="text-xs text-brand-600 hover:text-brand-700">
              + add field
            </button>
          </div>
          <div className="space-y-2">
            {fields.map((f, i) => (
              <div key={i} className="flex items-center gap-2">
                <input className="input flex-1" placeholder="field name" value={f.name} onChange={(e) => setFields((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <select className="select w-32" value={f.type} onChange={(e) => setFields((arr) => arr.map((x, j) => (j === i ? { ...x, type: e.target.value as PropertySchema["type"] } : x)))}>
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                </select>
                <label className="flex items-center gap-1 text-xs text-slate-500">
                  <input type="checkbox" checked={f.required} onChange={() => setFields((arr) => arr.map((x, j) => (j === i ? { ...x, required: !x.required } : x)))} />
                  req
                </label>
                <button type="button" onClick={() => setFields((arr) => arr.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500 text-sm px-1">
                  ×
                </button>
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
        <button type="submit" disabled={busy || !key || !name} className="rounded-lg bg-brand-600 text-white px-5 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50">
          {busy ? "Creating…" : "Create use case"}
        </button>
      </form>

      <div className="bg-white rounded-xl border border-slate-200 p-5 h-fit">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Existing use cases</div>
        <ul className="space-y-2">
          {existing.map((u) => (
            <li key={u.key} className="text-sm">
              <div className="font-medium text-slate-700">{u.name}</div>
              <div className="text-[11px] text-slate-400">
                {u.tokenStandard} · {u.allowedChainIds.length} chain(s)
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-600 mb-1">{label}</span>
      {children}
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
