/**
 * THE PUBLIC VERIFICATION PORTAL — the one surface with no account behind it.
 *
 * Everything else in this console assumes a session and a tenant. This page
 * assumes neither: it is for the person holding a certificate and the
 * counterparty, regulator or citizen who needs to know whether it is real. Both
 * of its tools call routes that were already public — `GET /credentials/{id}/
 * status` and `GET /dids/{did}/resolve` — so nothing new is exposed here; what
 * was missing was a way to reach them without curl.
 *
 * TWO RULES GOVERN THE COPY, and they are the reason this file is careful
 * rather than pretty:
 *
 *   1. NEVER DRESS UP PROVENANCE. The status route answers with a `source` of
 *      `chain`, `database` or `sandbox`, and they mean genuinely different
 *      things: the chain confirmed it; only this platform's own record says so;
 *      or it is a rehearsal credential that never had on-chain existence and
 *      never claimed one. A page that rendered all three as a green tick would
 *      be the most damaging thing in the product — a verifier would believe an
 *      unanchored record had been independently confirmed. Each gets its own
 *      wording and its own colour.
 *   2. SAY WHAT IS ABSENT. The public route returns no claims and no holder, by
 *      design — the holder's data stays behind their consent in the
 *      presentation exchange. A reader who does not see a name might reasonably
 *      assume the credential is empty or that verification failed, so the page
 *      states plainly that this is a validity check, not a disclosure.
 */
import { useEffect, useState } from "react";
import { api, describeApiError } from "../api.js";
import { credentialIdFrom, provenanceOf, verdictOf } from "../lib/public-verify.js";
import { useRoute } from "../router.js";
import type { CredentialStatusInfo, DidResolution } from "../types.js";
import { Logo } from "./Logo.js";
import { Card, Icon, Pill } from "./ui.js";

function Row(props: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 py-2 border-b border-slate-100 last:border-0">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500 sm:w-40 shrink-0">{props.label}</div>
      <div className="text-sm text-slate-800 min-w-0 break-all">{props.children}</div>
    </div>
  );
}

function CredentialTool(props: { initialId: string }): JSX.Element {
  const [input, setInput] = useState(props.initialId);
  const [status, setStatus] = useState<CredentialStatusInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(raw: string): Promise<void> {
    const id = credentialIdFrom(raw);
    if (!id) { setError("Enter a credential id, or paste the link from a certificate."); return; }
    setBusy(true); setError(null); setStatus(null);
    try {
      setStatus(await api.credentialStatus(id));
    } catch (err) {
      // A 404 is the commonest answer here and is not an error condition — it
      // is a verdict: nothing on this platform has that id.
      const described = describeApiError(err, "Could not check this credential.");
      setError(described.includes("404") || /not found/i.test(described)
        ? `No credential with id “${id}” exists on this platform. Check the id, or the certificate may have been issued elsewhere.`
        : described);
    } finally {
      setBusy(false);
    }
  }

  // A QR on a certificate points straight here with ?id=… — run it on arrival
  // rather than making the holder press a button they did not ask for.
  useEffect(() => { if (props.initialId) void check(props.initialId); /* eslint-disable-next-line */ }, [props.initialId]);

  const verdict = status ? verdictOf(status) : null;
  const prov = status ? provenanceOf(status) : null;

  return (
    <Card
      title="Verify a credential"
      description="Paste a credential id, or the link from a certificate or QR code."
    >
      <form className="flex flex-col sm:flex-row gap-2" onSubmit={(e) => { e.preventDefault(); void check(input); }}>
        <input
          className="input flex-1"
          placeholder="cred_… or https://…/credentials/…/status"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Credential id or link"
        />
        <button
          className="rounded-lg bg-brand-600 text-white px-5 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-40 shrink-0"
          type="submit" disabled={busy}
        >
          {busy ? "Checking…" : "Check"}
        </button>
      </form>

      {error && (
        <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">{error}</div>
      )}

      {status && verdict && prov && (
        <div className="mt-5">
          <div className={`rounded-xl border px-4 py-3 ${
            verdict.tone === "ok" ? "bg-emerald-50 border-emerald-200" :
            verdict.tone === "danger" ? "bg-red-50 border-red-200" :
            verdict.tone === "warn" ? "bg-amber-50 border-amber-200" : "bg-slate-50 border-slate-200"}`}>
            <div className="flex items-center gap-2">
              <Icon name={verdict.tone === "ok" ? "check" : "shield"} className="w-5 h-5" />
              <span className="text-base font-semibold text-slate-900">{verdict.headline}</span>
              <Pill tone={prov.tone === "muted" ? "muted" : prov.tone}>{prov.label}</Pill>
            </div>
            <p className="text-sm text-slate-700 mt-1">{verdict.detail}</p>
            <p className="text-xs text-slate-600 mt-1">{prov.detail}</p>
          </div>

          <div className="mt-4">
            <Row label="Credential id">{status.id}</Row>
            {status.revokedAt && <Row label="Revoked at">{new Date(status.revokedAt).toLocaleString()}</Row>}
            {status.source === "chain" && (
              <>
                <Row label="Ledger">{status.chainId}</Row>
                <Row label="Registry contract">{status.registry}</Row>
                {status.vcHash && <Row label="Credential hash">{status.vcHash}</Row>}
                {status.anchorTxHash && <Row label="Anchor transaction">{status.anchorTxHash}</Row>}
                {status.revokeTxHash && <Row label="Revocation transaction">{status.revokeTxHash}</Row>}
              </>
            )}
          </div>

          <p className="text-xs text-slate-500 mt-4">
            This is a validity check, not a disclosure. It deliberately shows no claims and no holder —
            those stay with the holder and are released only when they consent to a presentation.
          </p>
        </div>
      )}
    </Card>
  );
}

function DidTool(props: { initialDid: string }): JSX.Element {
  const [input, setInput] = useState(props.initialDid);
  const [res, setRes] = useState<DidResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function resolve(raw: string): Promise<void> {
    const did = raw.trim();
    if (!did) { setError("Enter a DID, e.g. did:key:z6Mk…"); return; }
    setBusy(true); setError(null); setRes(null);
    try {
      setRes(await api.resolveDid(did));
    } catch (err) {
      setError(describeApiError(err, "Could not resolve this DID."));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (props.initialDid) void resolve(props.initialDid); /* eslint-disable-next-line */ }, [props.initialDid]);

  const meta = res?.didDocumentMetadata;
  const failure = res?.didResolutionMetadata.error;

  return (
    <Card
      title="Look up an issuer"
      description="Resolve a DID to its public key and its registration on the ledger."
    >
      <form className="flex flex-col sm:flex-row gap-2" onSubmit={(e) => { e.preventDefault(); void resolve(input); }}>
        <input
          className="input flex-1"
          placeholder="did:key:z6Mk…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="DID"
        />
        <button
          className="rounded-lg bg-brand-600 text-white px-5 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-40 shrink-0"
          type="submit" disabled={busy}
        >
          {busy ? "Resolving…" : "Resolve"}
        </button>
      </form>

      {error && (
        <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">{error}</div>
      )}

      {res && failure && (
        <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900">
          {failure === "methodNotSupported"
            ? "That is a DID, but not a did:key — this platform resolves did:key only."
            : "That is not a valid DID."}
        </div>
      )}

      {res?.didDocument && meta && (
        <div className="mt-5">
          <div className={`rounded-xl border px-4 py-3 ${
            meta.source === "chain" && meta.registered && meta.active ? "bg-emerald-50 border-emerald-200" :
            meta.source === "chain" && meta.deactivated ? "bg-red-50 border-red-200" : "bg-slate-50 border-slate-200"}`}>
            <div className="flex items-center gap-2">
              <Icon name="shield" className="w-5 h-5" />
              <span className="text-base font-semibold text-slate-900">
                {meta.source !== "chain" ? "Key resolved — registration unknown"
                  : meta.deactivated ? "Registered, then deactivated"
                  : meta.registered ? "Registered on the ledger"
                  : "Not registered on the ledger"}
              </span>
            </div>
            <p className="text-sm text-slate-700 mt-1">
              {meta.source !== "chain"
                // The resolver never fabricates chain state, and neither does this.
                ? "The DID's public key is derived from the identifier itself, so it always resolves. This deployment anchors no DID registry, so whether any authority accredited this issuer cannot be answered here."
                : meta.deactivated ? "This DID was registered on the ledger and has since been deactivated. Treat anything it signed after that date with caution."
                : meta.registered ? "The ledger's DID registry lists this identifier as registered and active."
                : "The key is valid, but the ledger's registry does not list it. Anyone can create a did:key — registration is what says an authority recognised this one."}
            </p>
          </div>

          <div className="mt-4">
            <Row label="DID">{res.didDocument.id}</Row>
            <Row label="Public key">{res.didDocument.verificationMethod[0]?.publicKeyMultibase ?? "—"}</Row>
            <Row label="Key type">{res.didDocument.verificationMethod[0]?.type ?? "—"}</Row>
            {meta.source === "chain" && (
              <>
                <Row label="Ledger">{meta.chainId}</Row>
                <Row label="DID registry">{meta.registry}</Row>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * The page. Reads `?id=` and `?did=` so a QR code, a certificate footer or an
 * email can link straight to a finished answer.
 */
export function PublicVerify(): JSX.Element {
  const { navigate } = useRoute();
  const params = new URLSearchParams(window.location.search);
  const initialId = credentialIdFrom(params.get("id") ?? "");
  const initialDid = (params.get("did") ?? "").trim();

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="border-b border-white/10 bg-ink/95">
        <div className="max-w-4xl mx-auto px-6 h-16 flex items-center justify-between">
          <button onClick={() => navigate("/")} aria-label="Home"><Logo onDark size={30} /></button>
          <button
            onClick={() => navigate("/login")}
            className="rounded-lg border border-white/20 text-slate-100 px-4 py-2 text-sm font-medium hover:bg-white/10 transition-colors"
          >
            Login
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Verify a credential</h1>
        <p className="text-sm text-slate-600 mt-1 max-w-2xl">
          Anyone can check a credential issued on this platform — no account needed. Both checks read the
          public record directly; where a ledger is in use, the answer comes from the chain rather than from us.
        </p>

        <div className="mt-6 grid gap-6">
          <CredentialTool initialId={initialId} />
          <DidTool initialDid={initialDid} />
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-4xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <Logo size={26} />
          <div className="text-xs text-slate-500 text-center sm:text-right">
            <div>A product by XPI Quantum Technologies Pvt Ltd · 2026</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
