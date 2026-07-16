import { useEffect, useState } from "react";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import type { OrgMember, OrgType, Organization, Role } from "../types.js";
import { Card, EmptyState, Pill, SectionHeader } from "./ui.js";

const ORG_TYPES: OrgType[] = ["bank", "corporate", "msme", "government", "verifier"];

// Mirrors the server's canCreateOrgMember: only a PlatformAdmin may mint an OrgAdmin.
const MEMBER_ROLES: Role[] = ["OrgAdmin", "UseCaseAdmin", "Issuer", "Trader", "Buyer", "Auditor"];

function truncateDid(v: string): string {
  return v.length > 28 ? `${v.slice(0, 18)}…${v.slice(-6)}` : v;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * The organization area: a PlatformAdmin provisions organizations and their
 * members; an OrgAdmin sees only their own org's roster. Every member minted
 * here gets a DID and a membership credential from the org's issuer DID.
 */
export function Organizations(): JSX.Element {
  const { token, user } = useAuth();
  const isPlatform = user?.role === "PlatformAdmin";
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = (): void => {
    if (!token) return;
    setError(null);
    api.orgs(token).then((rows) => {
      setOrgs(rows);
      setSelected((cur) => cur ?? rows[0]?.id ?? null);
    }).catch((err) => setError(errMessage(err, "Failed to load organizations")));
  };
  useEffect(reload, [token]);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Organizations"
        description={isPlatform ? "Provision organizations and their members. Each gets a DID; members receive a membership credential." : "Your organization and its members."}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}

      {isPlatform && <CreateOrg onCreated={reload} />}

      {orgs.length === 0 ? (
        <Card>
          <EmptyState
            icon="globe"
            title="No organizations yet"
            hint={isPlatform ? "Create one above to start onboarding members." : "Your account is not linked to an organization."}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {orgs.map((o) => (
            <OrgCard key={o.id} org={o} selected={o.id === selected} onSelect={() => setSelected(o.id)} />
          ))}
        </div>
      )}

      {selected && <Members orgId={selected} />}
    </div>
  );
}

function OrgCard({ org, selected, onSelect }: { org: Organization; selected: boolean; onSelect: () => void }): JSX.Element {
  return (
    <button
      onClick={onSelect}
      className={`text-left bg-white rounded-2xl border shadow-sm p-4 space-y-2 hover:border-brand-400 ${selected ? "border-brand-500 ring-1 ring-brand-200" : "border-slate-200/80"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold text-slate-900 truncate">{org.name}</div>
        <Pill tone={org.verified ? "ok" : "warn"}>{org.verified ? "verified" : "unverified"}</Pill>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="info">{org.orgType}</Pill>
        {org.jurisdiction && <Pill tone="muted">{org.jurisdiction}</Pill>}
      </div>
      <div className="text-[11px] font-mono text-slate-500 truncate" title={org.did}>
        {truncateDid(org.did)}
      </div>
    </button>
  );
}

function CreateOrg({ onCreated }: { onCreated: () => void }): JSX.Element {
  const { token } = useAuth();
  const [name, setName] = useState("");
  const [orgType, setOrgType] = useState<OrgType>("bank");
  const [registrationId, setRegistrationId] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true);
    try {
      await api.createOrg(token!, {
        name: name.trim(),
        orgType,
        registrationId: registrationId.trim() || undefined,
        jurisdiction: jurisdiction.trim() || undefined,
      });
      setName(""); setRegistrationId(""); setJurisdiction("");
      onCreated();
    } catch (err) {
      setError(errMessage(err, "Create failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4 max-w-2xl">
      <h2 className="font-semibold text-slate-900">Create an organization</h2>
      <div className="grid grid-cols-2 gap-4">
        <input className="input" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="select" value={orgType} onChange={(e) => setOrgType(e.target.value as OrgType)}>
          {ORG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className="input" placeholder="registration id (optional)" value={registrationId} onChange={(e) => setRegistrationId(e.target.value)} />
        <input className="input" placeholder="jurisdiction (optional, e.g. IN)" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40">
        Create organization
      </button>
    </form>
  );
}

function Members({ orgId }: { orgId: string }): JSX.Element {
  const { token } = useAuth();
  const [rows, setRows] = useState<OrgMember[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = (): void => {
    if (!token) return;
    setError(null);
    api.orgMembers(token, orgId)
      .then(setRows)
      .catch((err) => setError(errMessage(err, "Failed to load members")));
  };
  useEffect(reload, [token, orgId]);

  return (
    <div className="space-y-3">
      <SectionHeader
        title="Members"
        description="Every member holds a DID and a membership credential issued by the organization."
        actions={
          <button
            onClick={() => setAdding((v) => !v)}
            className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
          >
            {adding ? "Close" : "Add member"}
          </button>
        }
      />
      {adding && <AddMember orgId={orgId} onAdded={reload} />}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {rows.length === 0 ? (
        <Card>
          <EmptyState icon="users" title="No members yet" hint="Add a member to mint their DID and membership credential." />
        </Card>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-500 bg-slate-50 uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Email</th>
                <th className="text-left font-medium px-4 py-2.5">Role</th>
                <th className="text-left font-medium px-4 py-2.5">Use case</th>
                <th className="text-left font-medium px-4 py-2.5">DID</th>
                <th className="text-left font-medium px-4 py-2.5">KYC</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="border-t border-slate-100">
                  <td className="px-4 py-2">{m.email}</td>
                  <td className="px-4 py-2">{m.role}</td>
                  <td className="px-4 py-2 text-slate-500">{m.useCaseKey ?? "—"}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-500" title={m.did ?? ""}>
                    {m.did ? truncateDid(m.did) : "—"}
                  </td>
                  <td className="px-4 py-2">
                    <Pill tone={m.kycStatus === "approved" ? "ok" : m.kycStatus === "rejected" ? "danger" : "warn"}>{m.kycStatus}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddMember({ orgId, onAdded }: { orgId: string; onAdded: () => void }): JSX.Element {
  const { token, user } = useAuth();
  // An OrgAdmin may not mint another OrgAdmin — the API 403s.
  const roleOptions = user?.role === "PlatformAdmin" ? MEMBER_ROLES : MEMBER_ROLES.filter((r) => r !== "OrgAdmin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>(roleOptions[0] ?? "Issuer");
  const [useCaseKey, setUseCaseKey] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<{ did: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    setBusy(true);
    try {
      const res = await api.createMember(token!, orgId, {
        email,
        password,
        role,
        useCaseKey: useCaseKey.trim() || undefined,
        walletAddress: walletAddress.trim() || undefined,
      });
      setOk({ did: res.did });
      setEmail(""); setPassword(""); setUseCaseKey(""); setWalletAddress("");
      onAdded();
    } catch (err) {
      setError(errMessage(err, "Create failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4 max-w-2xl">
      <h2 className="font-semibold text-slate-900">Add a member</h2>
      <div className="grid grid-cols-2 gap-4">
        <input className="input" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" placeholder="password (min 6)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <input className="input" placeholder="use-case key (optional)" value={useCaseKey} onChange={(e) => setUseCaseKey(e.target.value)} />
        <input className="input col-span-2" placeholder="wallet address 0x… (optional)" value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} />
      </div>
      {ok && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3">
          <p className="text-xs font-medium text-emerald-700">Member created · membership credential issued</p>
          <p className="text-[11px] font-mono text-emerald-800 break-all mt-1">{ok.did}</p>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 text-white py-1.5 px-4 text-sm font-medium hover:bg-brand-700 disabled:opacity-40">
        Create member
      </button>
    </form>
  );
}
