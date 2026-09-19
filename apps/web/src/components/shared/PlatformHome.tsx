import { useEffect, useState } from "react";
import { api, ApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import { useRoute } from "../../router.js";
import type { ChainInfo, ContractCode, UseCase } from "../../types.js";
import { ApprovalsPanel } from "./ApprovalsPanel.js";
import { ContractCodeView } from "../tokenization/ContractCodeView.js";
import { Dashboard } from "../tokenization/Dashboard.js";
import { IdentityHome } from "../identity/IdentityHome.js";
import { NetworksPanel } from "../tokenization/NetworksPanel.js";
import { Organizations } from "./Organizations.js";
import { ChainDeployBadge, UseCaseBuilder } from "../tokenization/UseCaseBuilder.js";
import { VerificationRequests } from "../identity/VerificationRequests.js";
import { Card, EmptyState, Pill, SectionHeader, Skeleton } from "./ui.js";

export type PlatformTab = "overview" | "organizations" | "approvals" | "verify" | "use-cases" | "networks" | "create" | "identity";
type Tab = PlatformTab;

export function PlatformHome({ useCases, chains, onReloadUseCases, view }: { useCases: UseCase[]; chains: ChainInfo[]; onReloadUseCases: () => void; view?: PlatformTab }): JSX.Element {
  const [internalTab, setInternalTab] = useState<Tab>("overview");
  const tab = view ?? internalTab;
  // Organizations sits beside Overview: an org is the top tenant that OWNS use
  // cases, so onboarding one must not require picking a use case first.
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "organizations", label: "Organizations" },
    // Credential issuance is org-scoped and gated, so its inbox lives beside Organizations.
    { id: "approvals", label: "Approvals" },
    { id: "verify", label: "Verification" },
    { id: "identity", label: "Identity" },
    { id: "use-cases", label: "Use cases" },
    { id: "networks", label: "Networks" },
    { id: "create", label: "Create use case" },
  ];

  return (
    <div>
      {view === undefined && (
        <div className="flex gap-1 mb-5 flex-wrap">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setInternalTab(t.id)}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium ${tab === t.id ? "bg-primary text-white border-primary" : "bg-surface text-muted border-border hover:bg-elevated"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === "overview" && (
        <div>
          <SectionHeader title="Platform overview" description="Cross-ledger issuance, holders and trading at a glance." />
          <Dashboard useCases={useCases} chains={chains} />
        </div>
      )}

      {tab === "organizations" && <Organizations />}

      {tab === "approvals" && (
        <div>
          <SectionHeader title="Approvals" description="Every proposal awaiting your decision — asset issuance, settlement and credentials." />
          <ApprovalsPanel />
        </div>
      )}

      {tab === "verify" && (
        <div>
          <SectionHeader title="Verification" description="Request a credential presentation from a holder, then run per-credential verification." />
          <VerificationRequests />
        </div>
      )}

      {tab === "identity" && <IdentityHome />}

      {tab === "use-cases" && <UseCasesTab useCases={useCases} chains={chains} onChanged={onReloadUseCases} />}

      {tab === "networks" && (
        <div>
          <SectionHeader title="Networks" description="Every supported ledger, its configuration and a live connectivity probe." />
          <NetworksPanel chains={chains} />
        </div>
      )}

      {tab === "create" && (
        <div>
          <SectionHeader title="Create a use case" description="A guided setup — strong defaults, live contract-code preview, deploys on save." />
          <UseCaseBuilder chains={chains} existing={useCases} onCreated={onReloadUseCases} />
        </div>
      )}
    </div>
  );
}

export function UseCasesTab({ useCases, chains, onChanged }: { useCases: UseCase[]; chains: ChainInfo[]; onChanged: () => void }): JSX.Element {
  const { navigate } = useRoute();
  const [codeFor, setCodeFor] = useState<UseCase | null>(null);

  const open = (key: string): void => {
    // Land directly on the Asset Management tab of the chosen use case.
    sessionStorage.setItem("tl:section", "assets");
    navigate(`/${key}`);
  };

  return (
    <div>
      <SectionHeader title="Use cases" description="Select an existing use-case template and start tokenizing your assets." />
      {useCases.length === 0 ? (
        <Card>
          <EmptyState icon="doc" title="No use cases yet" hint="Set one up in the Create use case tab — presets get you there in a minute." />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {useCases.map((u) => (
            <Card key={u.key} className="flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-fg truncate">{u.name}</div>
                  <div className="text-xs text-muted">{u.key}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Pill tone="info">{u.tokenStandard}</Pill>
                  <Pill tone="muted">{u.symbol}</Pill>
                </div>
              </div>
              {u.description && <p className="text-xs text-muted mt-2 line-clamp-3">{u.description}</p>}
              <div className="flex flex-wrap gap-1 mt-3">
                {u.allowedChainIds.map((cid) => (
                  <ChainDeployBadge
                    key={cid}
                    useCaseKey={u.key}
                    chainId={cid}
                    chain={chains.find((c) => c.id === cid)}
                    deployed={u.contracts?.[cid]}
                    onDeployed={onChanged}
                  />
                ))}
              </div>
              <div className="mt-4 pt-3 border-t border-border flex flex-wrap items-center gap-2">
                <button
                  onClick={() => open(u.key)}
                  className="rounded-lg bg-brand-600 text-white px-3.5 py-1.5 text-xs font-semibold hover:bg-brand-700"
                >
                  Start tokenizing →
                </button>
                <button
                  onClick={() => setCodeFor(u)}
                  className="rounded-lg border border-border text-muted px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700"
                >
                  View code
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {codeFor && <CodeModal useCase={codeFor} chains={chains} onClose={() => setCodeFor(null)} />}
    </div>
  );
}

/** Modal showing the contract code backing a use case, per allowed chain. */
function CodeModal({ useCase, chains, onClose }: { useCase: UseCase; chains: ChainInfo[]; onClose: () => void }): JSX.Element {
  const { token } = useAuth();
  const [chainId, setChainId] = useState(useCase.defaultChainId);
  const [code, setCode] = useState<ContractCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    setCode(null);
    api
      .useCaseCode(token, useCase.key, chainId)
      .then((c) => setCode(c))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the contract code"))
      .finally(() => setLoading(false));
  }, [token, useCase.key, chainId]);

  return (
    <div className="fixed inset-0 bg-black/30 flex items-start justify-center p-4 sm:p-8 z-50 overflow-y-auto" onClick={onClose}>
      <div className="bg-surface rounded-2xl shadow-xl w-full max-w-3xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-fg truncate">
              Contract code — {useCase.name} <span className="text-muted font-normal">({useCase.symbol})</span>
            </h3>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select className="select w-auto text-xs" value={chainId} onChange={(e) => setChainId(e.target.value)}>
              {useCase.allowedChainIds.map((id) => (
                <option key={id} value={id}>
                  {chains.find((c) => c.id === id)?.label ?? id}
                </option>
              ))}
            </select>
            <button onClick={onClose} className="text-muted hover:text-fg text-lg leading-none px-1">
              ×
            </button>
          </div>
        </div>
        <div className="p-5">
          {loading && <Skeleton lines={6} />}
          {error && <p className="text-sm text-danger rounded-lg bg-danger/10 border border-danger/25 px-4 py-2">{error}</p>}
          {code && <ContractCodeView code={code} />}
        </div>
      </div>
    </div>
  );
}
