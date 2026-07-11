import { useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth.js";
import type { ChainInfo, ChainStatus } from "../types.js";
import { Card, Icon, Pill, type IconName } from "./ui.js";

/** Env vars an operator must set to bring an unconfigured EVM chain online (documentation, mirrors config/chains.json). */
const ENV_VARS: Record<string, string[]> = {
  besu: ["BESU_RPC_URL", "BESU_OPERATOR_KEY"],
  mst: ["MST_RPC_URL", "MST_OPERATOR_KEY"],
  "local-evm": ["EVM_RPC_URL", "EVM_OPERATOR_KEY"],
};

export function familyIcon(family: ChainInfo["family"]): IconName {
  return family === "evm" ? "chain" : "globe";
}

export function modePill(chain: ChainInfo): JSX.Element {
  if (chain.configured === false) return <Pill tone="muted">not configured</Pill>;
  return chain.mode === "real" ? <Pill tone="ok">REAL</Pill> : <Pill tone="info">SIMULATED</Pill>;
}

/** Networks view: every chain in the catalog with its configuration and an on-demand status probe. */
export function NetworksPanel({ chains }: { chains: ChainInfo[] }): JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {chains.map((c) => (
        <ChainCard key={c.id} chain={c} />
      ))}
    </div>
  );
}

function ChainCard({ chain }: { chain: ChainInfo }): JSX.Element {
  const { token } = useAuth();
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const available = chain.available !== false;

  async function probe(): Promise<void> {
    if (!token) return;
    setProbing(true);
    setStatus(null);
    setProbeError(null);
    try {
      setStatus(await api.chainStatus(token, chain.id));
    } catch (err) {
      setProbeError(err instanceof ApiError ? err.message : "Status check failed");
    } finally {
      setProbing(false);
    }
  }

  return (
    <Card
      title={chain.label}
      description={`${chain.family} · ${chain.id}`}
      actions={
        <>
          <span className="text-slate-400">
            <Icon name={familyIcon(chain.family)} className="w-4 h-4" />
          </span>
          {modePill(chain)}
        </>
      }
    >
      {available ? (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            {chain.expectedChainId !== undefined && (
              <Row label="Chain ID">
                <span className="font-mono text-slate-700">{chain.expectedChainId}</span>
              </Row>
            )}
            {chain.rpcHost && (
              <Row label="RPC">
                <span className="font-mono rounded bg-slate-100 text-slate-600 px-1.5 py-0.5">
                  {chain.rpcHost}
                </span>
              </Row>
            )}
            {chain.currencySymbol && (
              <Row label="Currency">
                <span className="text-slate-700">{chain.currencySymbol}</span>
              </Row>
            )}
            {(chain.explorerUrl || chain.faucetUrl) && (
              <Row label="Links">
                <span className="flex flex-wrap gap-3">
                  {chain.explorerUrl && (
                    <a href={chain.explorerUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                      Explorer ↗
                    </a>
                  )}
                  {chain.faucetUrl && (
                    <a href={chain.faucetUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                      Faucet ↗
                    </a>
                  )}
                </span>
              </Row>
            )}
          </dl>

          <div className="border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => void probe()}
              disabled={probing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700 disabled:opacity-50"
            >
              {probing && (
                <span className="w-3 h-3 rounded-full border-2 border-slate-300 border-t-brand-600 animate-spin" aria-hidden="true" />
              )}
              {probing ? "Checking…" : "Check status"}
            </button>

            {probeError && <p className="text-xs text-red-600 mt-2">{probeError}</p>}
            {status && (
              <div className="mt-2 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  {status.reachable ? <Pill tone="ok">reachable</Pill> : <Pill tone="danger">unreachable</Pill>}
                  {status.chainId && (
                    <span className="text-[11px] text-slate-500">
                      chainId <span className="font-mono text-slate-700">{status.chainId}</span>
                    </span>
                  )}
                </div>
                {status.operator && (
                  <div className="text-[11px] text-slate-500">
                    operator{" "}
                    <span className="font-mono text-slate-700" title={status.operator}>
                      {status.operator.length > 18 ? `${status.operator.slice(0, 10)}…${status.operator.slice(-6)}` : status.operator}
                    </span>
                    {status.balance && (
                      <>
                        {" "}· balance <span className="font-mono text-slate-700">{status.balance}</span>
                      </>
                    )}
                  </div>
                )}
                {status.error && <p className="text-xs text-red-600">{status.error}</p>}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-center py-4 px-2">
          <div className="w-10 h-10 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-2">
            <Icon name="warn" className="w-5 h-5" />
          </div>
          <div className="text-sm font-medium text-slate-700">Not connected</div>
          <p className="text-xs text-slate-500 mt-1">
            Set the environment variables below and restart the API to bring this network online.
          </p>
          <div className="mt-3 flex flex-col items-center gap-1">
            {(ENV_VARS[chain.id] ?? []).map((v) => (
              <code key={v} className="text-[11px] font-mono rounded bg-slate-100 text-slate-600 px-2 py-0.5">
                {v}
              </code>
            ))}
          </div>
          {(chain.explorerUrl || chain.faucetUrl) && (
            <div className="mt-3 flex justify-center gap-3 text-xs">
              {chain.explorerUrl && (
                <a href={chain.explorerUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                  Explorer ↗
                </a>
              )}
              {chain.faucetUrl && (
                <a href={chain.faucetUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                  Faucet ↗
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="contents">
      <dt className="text-slate-400 font-medium">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
