import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { CredentialStatusInfo, HeldCredential, Organization } from "../types.js";
import { Card, EmptyState, SectionHeader, Skeleton } from "./ui.js";
import { CredentialCard } from "./CredentialCard.js";

/** The signed-in OrgAdmin's ENTITY wallet: credentials held by the org's own DID. */
export function OrganizationWallet(): JSX.Element {
  const { token, user } = useAuth();
  const orgId = user?.orgId ?? null;
  const [creds, setCreds] = useState<HeldCredential[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, CredentialStatusInfo>>({});
  const [org, setOrg] = useState<Organization | null>(null);

  useEffect(() => {
    if (!token || !orgId) { setCreds([]); return; }
    void api.orgWallet(token, orgId).then(setCreds).catch(() => setCreds([]));
    void api.org(token, orgId).then(setOrg).catch(() => setOrg(null));
  }, [token, orgId]);

  useEffect(() => {
    if (!creds?.length) return;
    void Promise.all(creds.map((c) => api.credentialStatus(c.id).then((s) => [c.id, s] as const).catch(() => null)))
      .then((rows) => setStatuses(Object.fromEntries(rows.filter(Boolean) as (readonly [string, CredentialStatusInfo])[])));
  }, [creds]);

  if (!orgId) {
    return (
      <div>
        <SectionHeader title="Organization wallet" />
        <Card><EmptyState icon="shield" title="No organization" hint="This account is not affiliated with an organization." /></Card>
      </div>
    );
  }
  return (
    <div>
      <SectionHeader
        title={org ? `Organization wallet · ${org.name}` : "Organization wallet"}
        description="Verifiable credentials held by your organization as an entity."
      />
      {org && <p className="font-mono text-xs text-slate-500 break-all -mt-3 mb-4">{org.did}</p>}
      {creds === null ? <Card><Skeleton lines={4} /></Card>
        : creds.length === 0 ? <Card><EmptyState icon="doc" title="No credentials yet" hint="Credentials issued to your organization will appear here." /></Card>
        : <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{creds.map((c) => <CredentialCard key={c.id} credential={c} status={statuses[c.id]} />)}</div>}
    </div>
  );
}
