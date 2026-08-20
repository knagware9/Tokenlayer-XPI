import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { canDesignCertificate } from "../../lib/identity/certificate-access.js";
import type { CredentialUseCase, Organization } from "../../types.js";
import { CertificateDesignPanel } from "./CertificateDesignPanel.js";
import { CredentialUseCaseBuilder } from "./CredentialUseCaseBuilder.js";
import { IssueUsecaseCredential } from "./IssueUsecaseCredential.js";
import { ProvisionFromTemplate } from "./ProvisionFromTemplate.js";
import { Card, EmptyState, Pill, SectionHeader, Skeleton } from "../shared/ui.js";

/** One-line summary of the Issuer / Holder / Verifier bindings. */
function bindingSummary(u: CredentialUseCase, orgNames: Record<string, string>): string {
  const issuer = u.issuer.kind === "platform" ? "Platform" : (orgNames[u.issuer.orgId] ?? `Org ${u.issuer.orgId}`);
  const holder =
    u.holderPolicy.who === "any-onboarded"
      ? "any onboarded org"
      : u.holderPolicy.who === "orgType"
        ? `org types ${u.holderPolicy.orgTypes.join(", ")}`
        : `${u.holderPolicy.orgIds.length} org(s)`;
  const verifier = u.verifier.kind === "any" ? "anyone" : `${u.verifier.orgIds.length} org(s)`;
  return `Issued by ${issuer} · held by ${holder} · verified by ${verifier}`;
}

export function IdentityHome(): JSX.Element {
  const { token, user } = useAuth();
  const [useCases, setUseCases] = useState<CredentialUseCase[] | null>(null);
  const [orgNames, setOrgNames] = useState<Record<string, string>>({});
  const [showBuilder, setShowBuilder] = useState(false);
  const [showProvision, setShowProvision] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // The designer needs the full width, so it replaces the list the way the
  // builder and the provisioner do rather than expanding inside a card.
  const [designing, setDesigning] = useState<{ key: string; typeName: string } | null>(null);
  const isPlatformAdmin = user?.role === "PlatformAdmin";
  // The provisioning API allows an OrgAdmin to stand up a use case for their own
  // org as well as a PlatformAdmin acting platform-wide.
  const canProvision = isPlatformAdmin || user?.role === "OrgAdmin";

  // Mirror the server's issuer binding: a PlatformAdmin may issue for any use
  // case; an OrgAdmin only when their own org is the bound issuer. Anyone else
  // never sees the action (the server would 403 with an empty holder list).
  const canIssue = (u: CredentialUseCase): boolean =>
    isPlatformAdmin || (user?.role === "OrgAdmin" && u.issuer.kind === "org" && !!user.orgId && u.issuer.orgId === user.orgId);

  const reload = useCallback((): void => {
    if (!token) return;
    void api.credentialUseCases(token).then(setUseCases).catch(() => setUseCases([]));
    // Resolve issuer-org ids to names for the binding summary (best-effort — a
    // caller who can't list orgs simply sees the id fall back).
    void api.orgs(token).then((os: Organization[]) => setOrgNames(Object.fromEntries(os.map((o) => [o.id, o.name])))).catch(() => {});
  }, [token]);

  useEffect(() => reload(), [reload]);

  const designingUseCase = designing ? useCases?.find((u) => u.key === designing.key) : undefined;
  if (designing && designingUseCase) {
    return (
      <CertificateDesignPanel
        useCase={designingUseCase}
        credentialTypeName={designing.typeName}
        onSaved={reload}
        onClose={() => setDesigning(null)}
      />
    );
  }

  if (showBuilder) {
    return (
      <div>
        <SectionHeader
          title="New credential use case"
          description="Author custom credential types and bind who issues, holds and verifies them."
          actions={
            <button
              onClick={() => setShowBuilder(false)}
              className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700"
            >
              ← Back to list
            </button>
          }
        />
        <CredentialUseCaseBuilder
          onCreated={() => {
            reload();
            setShowBuilder(false);
          }}
        />
      </div>
    );
  }

  if (showProvision) {
    return (
      <div>
        <div className="flex justify-end mb-2">
          <button
            onClick={() => setShowProvision(false)}
            className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700"
          >
            ← Back to list
          </button>
        </div>
        <ProvisionFromTemplate
          onDone={() => {
            setShowProvision(false);
            reload();
          }}
        />
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title="Identity"
        description="Configurable credential (DID/VC) use cases — custom claim types plus issuer, holder and verifier bindings."
        actions={
          isPlatformAdmin || canProvision ? (
            <div className="flex items-center gap-2">
              {canProvision && (
                <button
                  onClick={() => setShowProvision(true)}
                  className="rounded-lg border border-slate-200 text-slate-600 px-3.5 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700"
                >
                  Provision from template
                </button>
              )}
              {isPlatformAdmin && (
                <button
                  onClick={() => setShowBuilder(true)}
                  className="rounded-lg bg-brand-600 text-white px-3.5 py-1.5 text-xs font-semibold hover:bg-brand-700"
                >
                  New credential use case
                </button>
              )}
            </div>
          ) : undefined
        }
      />

      {useCases === null ? (
        <Card>
          <Skeleton lines={5} />
        </Card>
      ) : useCases.length === 0 ? (
        <Card>
          <EmptyState
            icon="shield"
            title="No credential use cases yet"
            hint={isPlatformAdmin ? "Author one to define custom credential types and their issuer/holder/verifier bindings." : "A platform admin has not configured any credential use cases yet."}
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {useCases.map((u) => (
            <Card key={u.key} className="flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900 truncate">{u.name}</div>
                  <div className="text-xs text-slate-400">{u.key}</div>
                </div>
              </div>
              {u.description && <p className="text-xs text-slate-500 mt-2 line-clamp-3">{u.description}</p>}
              <div className="flex flex-wrap items-center gap-1 mt-3">
                {u.credentialTypes.map((ct) => (
                  <span key={ct.name} className="inline-flex items-center gap-1">
                    <Pill tone="info">{ct.name}</Pill>
                    {/* EN-F follow-up: artwork is the ORG's to set on a use case
                        the org owns. Mirrors the server's ownership gate — see
                        `canDesignCertificate`. */}
                    {canDesignCertificate(user, u) && (
                      <button
                        onClick={() => setDesigning({ key: u.key, typeName: ct.name })}
                        title={`Design the ${ct.name} certificate`}
                        className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 hover:border-brand-400 hover:text-brand-700"
                      >
                        Design certificate
                      </button>
                    )}
                  </span>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t border-slate-100 text-[11px] text-slate-500">{bindingSummary(u, orgNames)}</div>
              {canIssue(u) && (
                <button
                  onClick={() => setExpandedKey((k) => (k === u.key ? null : u.key))}
                  className="mt-3 self-start rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700"
                >
                  {expandedKey === u.key ? "Close" : "Issue credential"}
                </button>
              )}
              {canIssue(u) && expandedKey === u.key && <IssueUsecaseCredential useCase={u} onIssued={reload} />}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
