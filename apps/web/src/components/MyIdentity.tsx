import { useEffect, useState } from "react";
import { ApiError, api } from "../api.js";
import { useAuth } from "../auth.js";
import type { ChainInfo, CredentialStatusInfo, DidDocument, HeldCredential } from "../types.js";
import { Card, EmptyState, SectionHeader, Skeleton } from "./ui.js";
import { CredentialCard } from "./CredentialCard.js";
import { VerificationInbox } from "./VerificationInbox.js";

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
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!token || !did) return;
    setError(null);
    void Promise.all([api.didDocument(token, did), api.myCredentials(token)])
      .then(([d, c]) => { setDoc(d); setCreds(c); })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load identity"));
  }, [token, did, reloadKey]);

  // Whether each credential is anchored on-chain. The status endpoint is public,
  // so it needs no token; a failure just omits that credential's pill.
  const [statuses, setStatuses] = useState<Record<string, CredentialStatusInfo>>({});
  useEffect(() => {
    if (!creds?.length) return;
    void Promise.all(
      creds.map((c) => api.credentialStatus(c.id).then((s) => [c.id, s] as const).catch(() => null)),
    ).then((rows) => setStatuses(Object.fromEntries(rows.filter(Boolean) as (readonly [string, CredentialStatusInfo])[])));
  }, [creds]);

  // Chain catalog for explorer links on tx-hash rows; failure just omits the links.
  const [chains, setChains] = useState<ChainInfo[]>();
  useEffect(() => {
    if (token) void api.chains(token).then(setChains).catch(() => setChains([]));
  }, [token]);

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
            {creds.map((c) => <CredentialCard key={c.id} credential={c} status={statuses[c.id]} chains={chains} onAcceptanceAction={() => setReloadKey((k) => k + 1)} />)}
          </div>
        )}
      </div>

      <VerificationInbox />
    </div>
  );
}
