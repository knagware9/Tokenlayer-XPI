import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { CredentialUseCase } from "../types.js";
import { CredentialUseCaseBuilder } from "./CredentialUseCaseBuilder.js";
import { IssueUsecaseCredential } from "./IssueUsecaseCredential.js";
import { Card, EmptyState, Pill, SectionHeader, Skeleton } from "./ui.js";

/** One-line summary of the Issuer / Holder / Verifier bindings. */
function bindingSummary(u: CredentialUseCase): string {
  const issuer = u.issuer.kind === "platform" ? "Platform" : `Org ${u.issuer.orgId}`;
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
  const [showBuilder, setShowBuilder] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const isPlatformAdmin = user?.role === "PlatformAdmin";

  const reload = useCallback((): void => {
    if (!token) return;
    void api.credentialUseCases(token).then(setUseCases).catch(() => setUseCases([]));
  }, [token]);

  useEffect(() => reload(), [reload]);

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

  return (
    <div>
      <SectionHeader
        title="Identity"
        description="Configurable credential (DID/VC) use cases — custom claim types plus issuer, holder and verifier bindings."
        actions={
          isPlatformAdmin ? (
            <button
              onClick={() => setShowBuilder(true)}
              className="rounded-lg bg-brand-600 text-white px-3.5 py-1.5 text-xs font-semibold hover:bg-brand-700"
            >
              New credential use case
            </button>
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
              <div className="flex flex-wrap gap-1 mt-3">
                {u.credentialTypes.map((ct) => (
                  <Pill key={ct.name} tone="info">{ct.name}</Pill>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t border-slate-100 text-[11px] text-slate-500">{bindingSummary(u)}</div>
              <button
                onClick={() => setExpandedKey((k) => (k === u.key ? null : u.key))}
                className="mt-3 self-start rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700"
              >
                {expandedKey === u.key ? "Close" : "Issue credential"}
              </button>
              {expandedKey === u.key && <IssueUsecaseCredential useCase={u} onIssued={reload} />}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
