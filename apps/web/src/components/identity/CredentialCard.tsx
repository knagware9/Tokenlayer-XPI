import { useState } from "react";
import { ApiError, api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { explorerTxUrl } from "../../lib/shared/explorers.js";
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
      <span className="text-muted">{label}</span>
      {url
        ? <a className="font-mono text-brand-600 hover:text-brand-700" href={url} target="_blank" rel="noreferrer">{short} ↗</a>
        : <span className="font-mono text-fg">{short}</span>}
      <button className="text-muted hover:text-fg" title="Copy transaction hash"
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
  const [showQr, setShowQr] = useState(false);
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
    <div className="bg-surface rounded-2xl border border-border/80 shadow-sm p-4 space-y-2">
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
            : <Pill tone="muted">unanchored</Pill>)}
        </div>
      </div>
      <div className="text-xs text-muted"><span className="font-medium text-fg">{issuerLabel(c)}</span></div>
      {c.credentialUseCaseKey && <div className="text-[11px] text-muted">use case · {c.credentialUseCaseKey}</div>}
      <div className="text-xs text-muted">Issued {fmtDate(c.issuedAt)} · Expires {fmtDate(c.expiresAt)}</div>
      {c.revokedReason && <div className="text-xs text-danger mt-0.5">Revoked: {c.revokedReason}</div>}
      {needsReview && (
        <div className="bg-warning/10 border border-warning/25 rounded-lg p-2.5 space-y-2">
          <p className="text-xs text-warning">This credential needs your review.</p>
          {c.acceptance === "changes_requested" && c.acceptanceNote && (
            <p className="text-xs text-warning">Note: {c.acceptanceNote}</p>
          )}
          {actionError && <p className="text-xs text-danger">{actionError}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-lg bg-success px-2.5 py-1 text-[11px] font-medium text-white hover:bg-success/90 disabled:opacity-50"
              disabled={busy}
              onClick={() => void runAction(() => api.acceptCredential(token!, c.id))}
            >
              Accept
            </button>
            {c.acceptance === "pending" && (
              <button
                className="rounded-lg border border-warning/40 px-2.5 py-1 text-[11px] font-medium text-warning hover:border-warning disabled:opacity-50"
                disabled={busy}
                onClick={() => setShowChangesBox((s) => !s)}
              >
                Request changes
              </button>
            )}
            <button
              className="rounded-lg border border-danger/40 px-2.5 py-1 text-[11px] font-medium text-danger hover:border-danger disabled:opacity-50"
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
                className="w-full rounded-lg border border-border bg-elevated/80 px-2 py-1.5 text-xs focus:outline-none focus:border-primary focus:bg-surface focus:ring-4 focus:ring-primary/15"
                rows={2}
                placeholder="What needs to change?"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="rounded-lg bg-warning px-2.5 py-1 text-[11px] font-medium text-white hover:bg-warning/90 disabled:opacity-50"
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
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          <div>
            <div className="text-[11px] text-muted mb-1">Claims</div>
            <dl className="text-xs">
              {Object.entries(c.claims).filter(([k]) => k !== "id").map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 py-0.5">
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-fg font-mono text-[11px] truncate max-w-[60%] text-right">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="text-[11px] text-muted font-mono break-all">
            issuer ·{" "}
            <a className="text-brand-600 hover:text-brand-700 underline decoration-dotted"
              href={api.didResolveUrl(c.issuerDid)} target="_blank" rel="noopener noreferrer">{c.issuerDid}</a>
          </div>
          <div className="text-[11px] text-muted font-mono break-all">holder · {c.holderDid}</div>
          {c.anchorTxHash && <TxHashRow label="Anchored" hash={c.anchorTxHash} chainId={c.anchorChainId} chains={chains} />}
          {c.revokeTxHash && <TxHashRow label="Revoked" hash={c.revokeTxHash} chainId={c.anchorChainId} chains={chains} />}
          <div className="flex gap-2">
            <button className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
              onClick={() => void navigator.clipboard.writeText(c.vcJwt)}>Copy VC-JWT</button>
            <a className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
              href={`data:application/jwt;charset=utf-8,${encodeURIComponent(c.vcJwt)}`} download={`${c.type[0] ?? "credential"}-${c.id}.jwt`}>Download</a>
            {c.certificateAvailable && (
              <a className="rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700 hover:border-brand-400"
                href={api.certificateUrl(c.id)} target="_blank" rel="noopener noreferrer">Download certificate</a>
            )}
            {/* What the holder gives a counterparty. Deliberately NOT the
                VC-JWT: this link proves the credential is live without handing
                over its claims, which is the whole point of the public status
                route it lands on. */}
            <button className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
              onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/verify?id=${encodeURIComponent(c.id)}`)}>
              Copy verification link
            </button>
            <button className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium hover:border-brand-400"
              onClick={() => setShowQr((v) => !v)}>
              {showQr ? "Hide QR" : "Show QR"}
            </button>
          </div>
          {showQr && (
            <div className="flex flex-col items-center gap-1 pt-1">
              {/* Same public link "Copy verification link" copies, as a QR a
                  verifier's phone camera can scan in person — no account, no
                  claims disclosed, just the live validity check. */}
              <img src={api.credentialQrUrl(c.id)} alt="Scan to verify this credential" className="h-32 w-32 rounded border border-border bg-surface p-1" />
              <div className="text-[10px] text-muted">Scan with a phone camera to verify</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
