import { useEffect, useState } from "react";
import { api, ApiError } from "../../api.js";
import { useAuth } from "../../auth.js";
import { useRoute } from "../../router.js";
import { SANDBOX_LEDGER_NOTE, chainChoicesFor, checkUseCaseDraft, modeLabel, modeOf, modeTone } from "../../lib/modes.js";
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
              className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === t.id ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === "overview" && (
        <div>
          <SectionHeader title="Platform overview" description="Cross-ledger issuance, holders and trading at a glance." />
          <Dashboard />
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

function UseCasesTab({ useCases, chains, onChanged }: { useCases: UseCase[]; chains: ChainInfo[]; onChanged: () => void }): JSX.Element {
  const { navigate } = useRoute();
  const [codeFor, setCodeFor] = useState<UseCase | null>(null);
  const [cloneFor, setCloneFor] = useState<UseCase | null>(null);

  const open = (key: string): void => {
    // Land directly on the Asset Management tab of the chosen use case.
    sessionStorage.setItem("tl:section", "assets");
    navigate(`/${key}`);
  };

  const sandboxCount = useCases.filter((u) => modeOf(u.sandbox) === "test").length;

  return (
    <div>
      <SectionHeader title="Use cases" description="Select an existing use-case template and start tokenizing your assets." />
      {/*
        THE LIST MIXES BOTH ENVIRONMENTS AND ALWAYS WILL. `GET /use-cases` hands
        a human session everything (`modeFilter(request, true)`) — deliberately,
        since an OrgAdmin who could not find their own sandbox programme could
        not configure it. So the environment has to be legible per card rather
        than assumed from the heading.
      */}
      {sandboxCount > 0 && (
        <p className="text-xs text-slate-500 -mt-2 mb-3">
          {sandboxCount} of these {sandboxCount === 1 ? "is a sandbox use case" : "are sandbox use cases"}, marked{" "}
          <Pill tone={modeTone("test")}>{modeLabel("test")}</Pill> below. Nothing issued under one is real.
        </p>
      )}
      {useCases.length === 0 ? (
        <Card>
          <EmptyState icon="doc" title="No use cases yet" hint="Set one up in the Create use case tab — presets get you there in a minute." />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {useCases.map((u) => {
            const isSandbox = modeOf(u.sandbox) === "test";
            return (
            <Card key={u.key} className={`flex flex-col ${isSandbox ? "ring-1 ring-amber-300" : ""}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900 truncate">{u.name}</div>
                  <div className="text-xs text-slate-400">{u.key}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* The environment leads: a reader who takes in one pill must
                      take in this one, not the token standard. */}
                  {isSandbox && <Pill tone={modeTone("test")}>{modeLabel("test")}</Pill>}
                  <Pill tone="info">{u.tokenStandard}</Pill>
                  <Pill tone="muted">{u.symbol}</Pill>
                </div>
              </div>
              {u.description && <p className="text-xs text-slate-500 mt-2 line-clamp-3">{u.description}</p>}
              {isSandbox && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-2">
                  {SANDBOX_LEDGER_NOTE}
                </p>
              )}
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
              <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => open(u.key)}
                  className="rounded-lg bg-brand-600 text-white px-3.5 py-1.5 text-xs font-semibold hover:bg-brand-700"
                >
                  Start tokenizing →
                </button>
                <button
                  onClick={() => setCodeFor(u)}
                  className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium hover:border-brand-400 hover:text-brand-700"
                >
                  View code
                </button>
                {/*
                  CLONE TO LIVE STANDS IN FOR THE EDIT THE SERVER REFUSES. There
                  is no "make this live" toggle anywhere, because `sandbox` is
                  immutable (409 SANDBOX_IMMUTABLE) — this is the affordance the
                  server actually has, and it is offered only where it applies.
                */}
                {isSandbox && (
                  <button
                    onClick={() => setCloneFor(u)}
                    className="rounded-lg border border-amber-300 text-amber-800 px-3 py-1.5 text-xs font-medium hover:bg-amber-50"
                  >
                    Clone to live
                  </button>
                )}
              </div>
            </Card>
            );
          })}
        </div>
      )}

      {codeFor && <CodeModal useCase={codeFor} chains={chains} onClose={() => setCodeFor(null)} />}
      {cloneFor && (
        <CloneToLiveModal
          source={cloneFor}
          chains={chains}
          existing={useCases}
          onClose={() => setCloneFor(null)}
          onCloned={onChanged}
        />
      )}
    </div>
  );
}

/**
 * Promote a sandbox use case's CONFIGURATION into a live one.
 *
 * The modal's whole job is to be honest about what does NOT come with it. The
 * server copies the definition and nothing else — no assets, holders, staged
 * invoices, proposals or events — and it deliberately drops the contract map,
 * because a clone that inherited it would name an in-memory ledger as the
 * deployment of a real programme. An operator who reads "clone" as "move my
 * sandbox data into production" and finds an empty register afterwards has been
 * misled by this screen, not by the API.
 *
 * The chain picker offers LIVE chains only, through the same helper the builder
 * uses: the clone is a live use case, so the sandbox chain is refused on it with
 * 400 INVALID_SANDBOX_CHAINS.
 */
function CloneToLiveModal({ source, chains, existing, onClose, onCloned }: {
  source: UseCase;
  chains: ChainInfo[];
  existing: UseCase[];
  onClose: () => void;
  onCloned: () => void;
}): JSX.Element {
  const { token } = useAuth();
  const liveChains = chainChoicesFor(false, chains);
  const seed = (liveChains.find((c) => c.available !== false) ?? liveChains[0])?.id ?? "";
  const [key, setKey] = useState(`${source.key}-live`);
  const [allowedChainIds, setAllowedChainIds] = useState<string[]>(seed ? [seed] : []);
  const [defaultChainId, setDefaultChainId] = useState(seed);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const keyValid = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(key);
  const keyTaken = existing.some((u) => u.key === key);
  // The clone is LIVE, so it is checked as a live draft — same helper, same
  // rule, so the modal cannot build something the builder would have refused.
  const check = checkUseCaseDraft({ sandbox: false, allowedChainIds, defaultChainId });

  function toggle(id: string): void {
    const next = allowedChainIds.includes(id) ? allowedChainIds.filter((x) => x !== id) : [...allowedChainIds, id];
    setAllowedChainIds(next);
    if (!next.includes(defaultChainId)) setDefaultChainId(next[0] ?? "");
  }

  async function submit(): Promise<void> {
    if (!token || !check.ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.cloneUseCaseToLive(token, source.key, {
        key: key.trim(),
        allowedChainIds: check.allowedChainIds,
        defaultChainId: check.defaultChainId,
      });
      // 202 → an OrgAdmin's clone is a create-use-case proposal like any other
      // create; 201 → a PlatformAdmin's clone exists and has deployed.
      setDone("proposal" in res
        ? `Submitted as proposal ${res.proposal.id.slice(0, 8)}… — '${res.key}' does not exist until a Platform Admin approves it. No data was copied.`
        : `Created '${res.key}' in the live environment. Its configuration came from '${source.key}'; no assets, holders, invoices or events did.`);
      onCloned();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not clone this use case");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-start justify-center p-4 sm:p-8 z-50 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-900 truncate">
            Clone <span className="font-mono">{source.key}</span> to live
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none px-1">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 px-3 py-2 space-y-1">
            <p>
              <strong className="font-semibold text-slate-800">Configuration only.</strong> The asset fields, lifecycle,
              compliance rules, fees and approval thresholds are copied. <strong className="font-semibold text-slate-800">No
              data is:</strong> no assets, holders, balances, staged invoices, proposals or events, and the clone starts
              undeployed on every ledger you pick below.
            </p>
            <p>
              <span className="font-mono">{source.key}</span> is left exactly as it is. Its own environment never changes.
            </p>
          </div>

          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">Key for the live copy</span>
            <input className="input" value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} />
            {!keyValid && <span className="block text-[11px] text-red-600 mt-1">Lowercase letters, digits and hyphens only.</span>}
            {keyTaken && <span className="block text-[11px] text-red-600 mt-1">A use case with this key already exists.</span>}
          </label>

          <div>
            <span className="block text-xs font-medium text-slate-600 mb-1.5">Ledgers for the live copy</span>
            <div className="flex flex-wrap gap-2">
              {liveChains.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggle(c.id)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    allowedChainIds.includes(c.id) ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-600 hover:border-brand-400"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {allowedChainIds.length > 1 && (
              <label className="block mt-2">
                <span className="block text-[11px] text-slate-500 mb-1">Default ledger for new assets</span>
                <select className="select w-auto text-xs" value={defaultChainId} onChange={(e) => setDefaultChainId(e.target.value)}>
                  {allowedChainIds.map((id) => (
                    <option key={id} value={id}>{chains.find((c) => c.id === id)?.label ?? id}</option>
                  ))}
                </select>
              </label>
            )}
            <p className="text-[11px] text-slate-400 mt-1.5">
              The sandbox ledger is not offered: a live use case may never name it.
            </p>
          </div>

          {!check.ok && <p className="text-xs text-amber-700">{check.message}</p>}
          {error && <p className="text-sm text-red-600 rounded-lg bg-red-50 border border-red-200 px-3 py-2">{error}</p>}
          {done && <p className="text-sm text-emerald-800 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">{done}</p>}

          <div className="flex items-center gap-2">
            <button
              onClick={() => void submit()}
              disabled={busy || done !== null || !check.ok || !keyValid || keyTaken}
              className="rounded-lg bg-brand-600 text-white px-4 py-1.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-40"
            >
              {busy ? "Cloning…" : "Create the live copy"}
            </button>
            <button onClick={onClose} className="rounded-lg border border-slate-200 text-slate-600 px-3 py-1.5 text-sm font-medium hover:bg-slate-50">
              {done ? "Close" : "Cancel"}
            </button>
          </div>
        </div>
      </div>
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
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900 truncate">
              Contract code — {useCase.name} <span className="text-slate-400 font-normal">({useCase.symbol})</span>
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
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none px-1">
              ×
            </button>
          </div>
        </div>
        <div className="p-5">
          {loading && <Skeleton lines={6} />}
          {error && <p className="text-sm text-red-600 rounded-lg bg-red-50 border border-red-200 px-4 py-2">{error}</p>}
          {code && <ContractCodeView code={code} />}
        </div>
      </div>
    </div>
  );
}
