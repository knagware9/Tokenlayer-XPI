import { useState } from "react";
import type { CredentialStatusInfo, HeldCredential } from "../types.js";
import { Pill } from "./ui.js";

function truncateDid(v: string): string { return v.length > 28 ? `${v.slice(0, 18)}…${v.slice(-6)}` : v; }
function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}
/** Issuer label: the resolved org name, else a claim-carried org, else the DID. */
function issuerLabel(c: HeldCredential): string {
  if (c.issuerName) return c.issuerName;
  const org = c.claims.organization;
  return typeof org === "string" && org ? org : truncateDid(c.issuerDid);
}

export function CredentialCard({ credential: c, status }: { credential: HeldCredential; status?: CredentialStatusInfo }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {c.type.map((t) => <Pill key={t} tone="info">{t}</Pill>)}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
          <Pill tone={c.revoked ? "danger" : "ok"}>{c.revoked ? "revoked" : "valid"}</Pill>
          {status && (status.anchored ? <Pill tone="info">anchored · {status.chainId}</Pill> : <Pill tone="muted">unanchored</Pill>)}
        </div>
      </div>
      <div className="text-xs text-slate-600"><span className="font-medium text-slate-800">{issuerLabel(c)}</span></div>
      {c.credentialUseCaseKey && <div className="text-[11px] text-slate-400">use case · {c.credentialUseCaseKey}</div>}
      <div className="text-xs text-slate-500">Issued {fmtDate(c.issuedAt)} · Expires {fmtDate(c.expiresAt)}</div>
      {c.revokedReason && <div className="text-xs text-rose-600 mt-0.5">Revoked: {c.revokedReason}</div>}
      <button className="text-[11px] font-medium text-brand-600 hover:text-brand-700" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide details" : "Details"}
      </button>
      {open && (
        <div className="mt-2 space-y-2 border-t border-slate-100 pt-2">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Claims</div>
            <dl className="text-xs">
              {Object.entries(c.claims).filter(([k]) => k !== "id").map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 py-0.5">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="text-slate-900 font-mono text-[11px] truncate max-w-[60%] text-right">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="text-[11px] text-slate-500 font-mono break-all">holder · {c.holderDid}</div>
          <div className="flex gap-2">
            <button className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
              onClick={() => void navigator.clipboard.writeText(c.vcJwt)}>Copy VC-JWT</button>
            <a className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
              href={`data:application/jwt;charset=utf-8,${encodeURIComponent(c.vcJwt)}`} download={`${c.type[0] ?? "credential"}-${c.id}.jwt`}>Download</a>
          </div>
        </div>
      )}
    </div>
  );
}
