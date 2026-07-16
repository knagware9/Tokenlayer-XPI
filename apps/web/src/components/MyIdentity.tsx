import { useEffect, useState } from "react";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import type { DidDocument, HeldCredential } from "../types.js";
import { Card, EmptyState, Pill, SectionHeader, Skeleton } from "./ui.js";

function truncateDid(v: string): string {
  return v.length > 28 ? `${v.slice(0, 18)}…${v.slice(-6)}` : v;
}

function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

/** The organization that issued a credential, when the claims carry it. */
function issuerLabel(c: HeldCredential): string | null {
  const org = c.claims.organization;
  return typeof org === "string" && org ? org : null;
}

/**
 * The signed-in user's decentralized identity: their DID, the resolved DID
 * document, and the verifiable credentials they hold (e.g. org membership).
 */
export function MyIdentity(): JSX.Element {
  const { token, user } = useAuth();
  const did = user?.did ?? null;
  const [doc, setDoc] = useState<DidDocument | null>(null);
  const [creds, setCreds] = useState<HeldCredential[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !did) return;
    setError(null);
    void Promise.all([api.didDocument(token, did), api.myCredentials(token)])
      .then(([d, c]) => { setDoc(d); setCreds(c); })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load identity"));
  }, [token, did]);

  if (!did) {
    return (
      <div className="space-y-5">
        <SectionHeader title="My identity" />
        <Card>
          <EmptyState
            icon="shield"
            title="No decentralized identity is associated with this account yet."
            hint="Accounts provisioned through an organization are issued a DID and a membership credential."
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SectionHeader title="My identity" description="Your decentralized identifier and the credentials issued to you." />
      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card title="Decentralized identifier" description={user?.email}>
        <p className="font-mono text-xs text-slate-700 break-all">{did}</p>
      </Card>

      <Card title="DID document" description="Resolved from the platform's DID registry.">
        {doc ? (
          <pre className="overflow-x-auto text-xs font-mono bg-slate-950 text-slate-100 rounded-lg p-4">
            {JSON.stringify(doc, null, 2)}
          </pre>
        ) : (
          <Skeleton lines={5} />
        )}
      </Card>

      <div className="space-y-3">
        <SectionHeader title="Credentials" description="Verifiable credentials held by this DID." />
        {creds === null ? (
          <Card><Skeleton lines={3} /></Card>
        ) : creds.length === 0 ? (
          <Card>
            <EmptyState icon="doc" title="No credentials yet" hint="Credentials issued to you will appear here." />
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {creds.map((c) => (
              <div key={c.id} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                    {c.type.map((t) => <Pill key={t} tone="info">{t}</Pill>)}
                  </div>
                  <Pill tone={c.revoked ? "danger" : "ok"}>{c.revoked ? "revoked" : "valid"}</Pill>
                </div>
                <div className="text-xs text-slate-600">
                  {issuerLabel(c) && <span className="font-medium text-slate-800">{issuerLabel(c)}</span>}
                  <span className="font-mono text-slate-500" title={c.issuerDid}>
                    {issuerLabel(c) ? " · " : ""}{truncateDid(c.issuerDid)}
                  </span>
                </div>
                <div className="text-xs text-slate-500">
                  Issued {fmtDate(c.issuedAt)} · Expires {fmtDate(c.expiresAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
