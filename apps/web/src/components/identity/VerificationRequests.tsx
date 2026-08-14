import { useEffect, useState } from "react";
import { ApiError, api } from "../../api.js";
import { useAuth } from "../../auth.js";
import type { ChainInfo, CredentialTypeInfo, CredentialUseCase, VerificationRequest, VerificationResult } from "../../types.js";
import { TxHashRow } from "./CredentialCard.js";
import { Card, EmptyState, Pill } from "../shared/ui.js";

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** The verifier's step-by-step detail rows, in check order (ID-O). */
const CHECK_ROWS = [
  { key: "signature", label: "Signature valid" },
  { key: "trusted", label: "Issuer trusted" },
  { key: "notExpired", label: "Not expired" },
  { key: "subjectBound", label: "Subject bound to holder" },
  { key: "notRevoked", label: "Not revoked" },
] as const;

/**
 * Verifier side: request a presentation from a holder, then run verification on
 * the consented presentation. Non-verifier orgs are gated by the API's
 * NOT_A_VERIFIER — the form simply surfaces that error for them.
 */
export function VerificationRequests(): JSX.Element {
  const { token } = useAuth();
  const [types, setTypes] = useState<CredentialTypeInfo[]>([]);
  const [useCases, setUseCases] = useState<CredentialUseCase[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [holderDid, setHolderDid] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [purpose, setPurpose] = useState("");
  const [reqId, setReqId] = useState<string | null>(null);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The outbound list. Before it existed, `reqId` above was the ONLY record of a
  // request the verifier had raised, so a reload orphaned it — the request stayed
  // open and consentable with no way back to it.
  const [outbox, setOutbox] = useState<VerificationRequest[]>([]);

  useEffect(() => { if (token) void api.credentialTypes(token).then(setTypes).catch(() => setTypes([])); }, [token]);
  useEffect(() => { if (token) void api.credentialUseCases(token).then(setUseCases).catch(() => setUseCases([])); }, [token]);

  // Chain catalog for explorer links on tx-hash rows; failure just omits the links.
  const [chains, setChains] = useState<ChainInfo[]>();
  useEffect(() => { if (token) void api.chains(token).then(setChains).catch(() => setChains([])); }, [token]);

  // A caller with no verifier scope gets [] rather than an error, so a failure
  // here is a genuine failure and shows as an empty list either way.
  const refreshOutbox = (t: string): Promise<void> =>
    api.verificationRequests(t).then(setOutbox).catch(() => setOutbox([]));
  useEffect(() => { if (token) void refreshOutbox(token); }, [token]);

  const selectedUseCase = useCases.find((u) => u.key === selectedKey);
  // The requestable types come from the selected use case, or the closed catalog when none.
  const typeNames = selectedUseCase ? selectedUseCase.credentialTypes.map((t) => t.name) : types.map((t) => t.type);

  async function submit(): Promise<void> {
    if (!token) return;
    const requestedTypes = Object.keys(picked).filter((k) => picked[k]);
    if (!holderDid || requestedTypes.length === 0 || !purpose) { setErr("holder DID, at least one type, and a purpose are required"); return; }
    setErr(null); setResult(null);
    try {
      const r = await api.createVerificationRequest(token, {
        holderDid: holderDid.trim(), requestedTypes, purpose: purpose.trim(),
        ...(selectedKey ? { credentialUseCaseKey: selectedKey } : {}),
      });
      setReqId(r.id); setMsg(`Requested — waiting for the holder to consent (request ${r.id.slice(0, 8)}…).`);
      await refreshOutbox(token);
    } catch (e) { setErr(errMessage(e, "Request failed")); }
  }
  async function runVerify(id: string | null = reqId): Promise<void> {
    if (!token || !id) return;
    setErr(null); setReqId(id);
    try {
      setResult(await api.verifyVerification(token, id));
      // Verifying stamps `verifiedAt` on the row — reload so the list says so.
      await refreshOutbox(token);
    } catch (e) { setResult(null); setErr(errMessage(e, "Verification failed")); }
  }

  const check = (ok: boolean | "unknown"): JSX.Element => (
    <Pill tone={ok === true ? "ok" : ok === "unknown" ? "muted" : "danger"}>{ok === true ? "✓" : ok === "unknown" ? "?" : "✗"}</Pill>
  );
  const issuerPill = (r: { registered: boolean; active: boolean; chainId: string }): JSX.Element => (
    r.active
      ? <Pill tone="ok">issuer on-chain · {r.chainId} · active</Pill>
      : r.registered
        ? <Pill tone="danger">issuer deactivated</Pill>
        : <Pill tone="muted">issuer not registered</Pill>
  );

  return (
    <div className="space-y-5">
      <Card title="Request a presentation" description="Ask a holder to present specific credentials. They consent and choose what to disclose.">
        {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
        {msg && <div className="text-sm text-emerald-600 mb-2">{msg}</div>}
        <input className="input w-full mb-2" placeholder="Holder DID (did:key:…)" value={holderDid} onChange={(e) => setHolderDid(e.target.value)} />
        <label className="block text-xs text-slate-500 mb-1">Credential use case (optional)</label>
        <select className="input w-full mb-2" value={selectedKey} onChange={(e) => { setSelectedKey(e.target.value); setPicked({}); }}>
          <option value="">— none (generic) —</option>
          {useCases.map((u) => <option key={u.key} value={u.key}>{u.name} ({u.key})</option>)}
        </select>
        <div className="flex flex-wrap gap-3 mb-2">
          {typeNames.map((t) => (
            <label key={t} className="text-sm flex items-center gap-1">
              <input type="checkbox" checked={!!picked[t]} onChange={(e) => setPicked({ ...picked, [t]: e.target.checked })} /> {t}
            </label>
          ))}
        </div>
        <input className="input w-full mb-3" placeholder="Purpose (e.g. investor onboarding)" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        <div className="flex gap-2">
          <button className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white" onClick={() => void submit()}>Request</button>
          {reqId && <button className="rounded-lg border border-slate-200 px-4 py-2 text-sm" onClick={() => void runVerify()}>Run verification</button>}
        </div>
      </Card>

      <Card title="Your requests" description="Every presentation you have asked for, newest first. Pick one up here after leaving the page.">
        {outbox.length === 0 ? (
          <EmptyState icon="shield" title="No requests yet" hint="Ask a holder for a presentation above; it will appear here until you verify it." />
        ) : (
          <ul className="divide-y divide-slate-100">
            {outbox.map((r) => (
              <li key={r.id} className={`py-3 flex items-start justify-between gap-4 ${r.id === reqId ? "bg-brand-50/40 -mx-2 px-2 rounded-lg" : ""}`}>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{r.purpose}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {r.requestedTypes.join(", ")} · holder {r.holderDid.slice(0, 20)}…
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {new Date(r.createdAt).toLocaleString()}
                    {r.verifiedAt && ` · verified ${new Date(r.verifiedAt).toLocaleString()}`}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Pill tone={r.status === "consented" ? "ok" : r.status === "pending" ? "muted" : "danger"}>{r.status}</Pill>
                  {/* Offered only once the holder has released a presentation:
                      before that the API answers "nothing to verify", and a
                      button whose only outcome is that message is a trap. */}
                  {r.status === "consented" && (
                    <button className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs" onClick={() => void runVerify(r.id)}>Run verification</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {result && (
        <Card title="Verification result" description={result.valid ? "Presentation is valid." : "Presentation did not fully verify."}>
          <div className="mb-2"><Pill tone={result.valid ? "ok" : "danger"}>{result.valid ? "valid" : "invalid"}</Pill> <span className="text-xs text-slate-500">holder {result.holderDid?.slice(0, 20)}…</span></div>
          <div className="space-y-2">
            {result.credentials.map((c, i) => {
              // ID-O: pre-ID-O stored results may lack `checks` entirely — never fabricate ticks.
              const checks = c.checks;
              // The per-credential reason belongs to the FIRST failing check only.
              const firstFail = checks && CHECK_ROWS.find(({ key }) => checks[key] === false)?.key;
              const reasonOnFailingRow = !!firstFail;
              return (
                <div key={i} className="border border-slate-100 rounded-lg p-3">
                  <div className="font-medium">{c.type ?? "unknown credential"} {c.reason && !reasonOnFailingRow && <span className="text-xs text-rose-600">· {c.reason}</span>}</div>
                  {checks ? (
                    <div className="mt-2 space-y-1.5">
                      {CHECK_ROWS.map(({ key, label }) => {
                        const v = checks[key];
                        return (
                          <div key={key} className="text-xs">
                            <div className="flex items-center gap-2">
                              {check(v)}
                              <span className={v === false ? "text-rose-700" : "text-slate-700"}>{label}</span>
                            </div>
                            {key === firstFail && c.reason && <div className="ml-7 mt-0.5 text-[11px] text-rose-500">{c.reason}</div>}
                            {key === "trusted" && c.issuerResolution && <div className="ml-7 mt-0.5">{issuerPill(c.issuerResolution)}</div>}
                            {key === "notRevoked" && c.issuerResolution && <div className="ml-7 mt-0.5 text-[11px] text-slate-400">checked on-chain</div>}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    c.issuerResolution && <div className="flex flex-wrap gap-3 text-xs mt-1 items-center">{issuerPill(c.issuerResolution)}</div>
                  )}
                  {(c.anchorTxHash || c.revokeTxHash) && (
                    <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                      {c.anchorTxHash && <TxHashRow label="Anchored" hash={c.anchorTxHash} chainId={c.anchorChainId} chains={chains} />}
                      {c.revokeTxHash && <TxHashRow label="Revoked" hash={c.revokeTxHash} chainId={c.anchorChainId} chains={chains} />}
                    </div>
                  )}
                  {c.claims && <div className="text-xs text-slate-500 mt-2">{Object.entries(c.claims).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</div>}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
