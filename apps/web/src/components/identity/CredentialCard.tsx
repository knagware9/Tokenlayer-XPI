import { useState } from "react";
import { ApiError, api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { explorerTxUrl } from "../../lib/explorers.js";
import type { ChainInfo, CredentialStatusInfo, HeldCredential } from "../../types.js";
import { Pill } from "../shared/ui.js";

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

/** A transaction-hash row: explorer link when the chain has one, copyable hash otherwise. */
export function TxHashRow({ label, hash, chainId, chains }: {
  label: string; hash: string; chainId?: string | null; chains?: ChainInfo[];
}): JSX.Element {
  const url = explorerTxUrl(chains, chainId, hash);
  const short = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-500">{label}</span>
      {url
        ? <a className="font-mono text-brand-600 hover:text-brand-700" href={url} target="_blank" rel="noreferrer">{short} ↗</a>
        : <span className="font-mono text-slate-700">{short}</span>}
      <button className="text-slate-400 hover:text-slate-600" title="Copy transaction hash"
        onClick={() => void navigator.clipboard.writeText(hash)}>Copy</button>
    </div>
  );
}

export function CredentialCard({ credential: c, status, onAcceptanceAction, chains }: { credential: HeldCredential; status?: CredentialStatusInfo; onAcceptanceAction?: () => void; chains?: ChainInfo[] }): JSX.Element {
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showChangesBox, setShowChangesBox] = useState(false);
  const [note, setNote] = useState("");

  const needsReview = c.acceptance === "pending" || c.acceptance === "changes_requested";

  async function runAction(fn: () => Promise<unknown>): Promise<void> {
    if (!token || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      onAcceptanceAction?.();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {c.type.map((t) => <Pill key={t} tone="info">{t}</Pill>)}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
          <Pill tone={c.revoked ? "danger" : "ok"}>{c.revoked ? "revoked" : "valid"}</Pill>
          {c.acceptance && c.acceptance !== "accepted" && (
            <Pill tone="warn">{c.acceptance.replace("_", " ")}</Pill>
          )}
          {status && (status.anchored
            ? <Pill tone="info">anchored · {status.chainId}</Pill>
            // EN-D2: a sandbox credential is unanchored BY DESIGN, so it must not
            // wear the same pill as one whose anchor was meant to land and did not.
            : status.source === "sandbox" ? <Pill tone="warn">sandbox · not anchored</Pill> : <Pill tone="muted">unanchored</Pill>)}
        </div>
      </div>
      <div className="text-xs text-slate-600"><span className="font-medium text-slate-800">{issuerLabel(c)}</span></div>
      {c.credentialUseCaseKey && <div className="text-[11px] text-slate-400">use case · {c.credentialUseCaseKey}</div>}
      <div className="text-xs text-slate-500">Issued {fmtDate(c.issuedAt)} · Expires {fmtDate(c.expiresAt)}</div>
      {c.revokedReason && <div className="text-xs text-rose-600 mt-0.5">Revoked: {c.revokedReason}</div>}
      {needsReview && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 space-y-2">
          <p className="text-xs text-amber-800">This credential needs your review.</p>
          {c.acceptance === "changes_requested" && c.acceptanceNote && (
            <p className="text-xs text-amber-700">Note: {c.acceptanceNote}</p>
          )}
          {actionError && <p className="text-xs text-red-600">{actionError}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              disabled={busy}
              onClick={() => void runAction(() => api.acceptCredential(token!, c.id))}
            >
              Accept
            </button>
            {c.acceptance === "pending" && (
              <button
                className="rounded-lg border border-amber-300 px-2.5 py-1 text-[11px] font-medium text-amber-800 hover:border-amber-400 disabled:opacity-50"
                disabled={busy}
                onClick={() => setShowChangesBox((s) => !s)}
              >
                Request changes
              </button>
            )}
            <button
              className="rounded-lg border border-red-300 px-2.5 py-1 text-[11px] font-medium text-red-700 hover:border-red-400 disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                if (!window.confirm("Rejecting permanently revokes this credential.")) return;
                void runAction(() => api.rejectHeldCredential(token!, c.id, note.trim() || undefined));
              }}
            >
              Reject
            </button>
          </div>
          {showChangesBox && (
            <div className="space-y-1.5">
              <textarea
                className="w-full rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-xs"
                rows={2}
                placeholder="What needs to change?"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="rounded-lg bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                disabled={busy || !note.trim()}
                onClick={() => void runAction(() => api.requestCredentialChanges(token!, c.id, note.trim()))}
              >
                Send
              </button>
            </div>
          )}
        </div>
      )}
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
          <div className="text-[11px] text-slate-500 font-mono break-all">
            issuer ·{" "}
            <a className="text-brand-600 hover:text-brand-700 underline decoration-dotted"
              href={api.didResolveUrl(c.issuerDid)} target="_blank" rel="noopener noreferrer">{c.issuerDid}</a>
          </div>
          <div className="text-[11px] text-slate-500 font-mono break-all">holder · {c.holderDid}</div>
          {c.anchorTxHash && <TxHashRow label="Anchored" hash={c.anchorTxHash} chainId={c.anchorChainId} chains={chains} />}
          {c.revokeTxHash && <TxHashRow label="Revoked" hash={c.revokeTxHash} chainId={c.anchorChainId} chains={chains} />}
          <div className="flex gap-2">
            <button className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
              onClick={() => void navigator.clipboard.writeText(c.vcJwt)}>Copy VC-JWT</button>
            <a className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
              href={`data:application/jwt;charset=utf-8,${encodeURIComponent(c.vcJwt)}`} download={`${c.type[0] ?? "credential"}-${c.id}.jwt`}>Download</a>
            {c.certificateAvailable && (
              <a className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700 hover:border-brand-400"
                href={api.certificateUrl(c.id)} target="_blank" rel="noopener noreferrer">Download certificate</a>
            )}
            {/* What the holder gives a counterparty. Deliberately NOT the
                VC-JWT: this link proves the credential is live without handing
                over its claims, which is the whole point of the public status
                route it lands on. */}
            <button className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
              onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/verify?id=${encodeURIComponent(c.id)}`)}>
              Copy verification link
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
