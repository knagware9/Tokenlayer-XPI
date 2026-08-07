import { useEffect, useState } from "react";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import type { ChainInfo, CredentialTypeInfo, CredentialUseCase, VerificationResult } from "../types.js";
import { TxHashRow } from "./CredentialCard.js";
import { Card, Pill } from "./ui.js";

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

  useEffect(() => { if (token) void api.credentialTypes(token).then(setTypes).catch(() => setTypes([])); }, [token]);
  useEffect(() => { if (token) void api.credentialUseCases(token).then(setUseCases).catch(() => setUseCases([])); }, [token]);

  // Chain catalog for explorer links on tx-hash rows; failure just omits the links.
  const [chains, setChains] = useState<ChainInfo[]>();
  useEffect(() => { if (token) void api.chains(token).then(setChains).catch(() => setChains([])); }, [token]);

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
    } catch (e) { setErr(errMessage(e, "Request failed")); }
  }
  async function runVerify(): Promise<void> {
    if (!token || !reqId) return;
    setErr(null);
    try { setResult(await api.verifyVerification(token, reqId)); }
    catch (e) { setErr(errMessage(e, "Verification failed")); }
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

      {result && (
        <Card title="Verification result" description={result.valid ? "Presentation is valid." : "Presentation did not fully verify."}>
          <div className="mb-2"><Pill tone={result.valid ? "ok" : "danger"}>{result.valid ? "valid" : "invalid"}</Pill> <span className="text-xs text-slate-500">holder {result.holderDid?.slice(0, 20)}…</span></div>
          <div className="space-y-2">
            {result.credentials.map((c, i) => {
              // ID-O: pre-ID-O stored results may lack `checks` entirely — never fabricate ticks.
              const reasonOnFailingRow = !!c.checks && CHECK_ROWS.some(({ key }) => c.checks[key] === false);
              return (
                <div key={i} className="border border-slate-100 rounded-lg p-3">
                  <div className="font-medium">{c.type ?? "unknown credential"} {c.reason && !reasonOnFailingRow && <span className="text-xs text-rose-600">· {c.reason}</span>}</div>
                  {c.checks ? (
                    <div className="mt-2 space-y-1.5">
                      {CHECK_ROWS.map(({ key, label }) => {
                        const v = c.checks[key];
                        return (
                          <div key={key} className="text-xs">
                            <div className="flex items-center gap-2">
                              {check(v)}
                              <span className={v === false ? "text-rose-700" : "text-slate-700"}>{label}</span>
                            </div>
                            {v === false && c.reason && <div className="ml-7 mt-0.5 text-[11px] text-rose-500">{c.reason}</div>}
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
