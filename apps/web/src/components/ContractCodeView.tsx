import type { ContractCode } from "../types.js";
import { Card, Icon, Pill } from "./ui.js";

/**
 * Renders the contract code that backs a use case on one chain: filename +
 * language header, the constructor arguments the platform passes on deploy,
 * the full source (downloadable), and — when already deployed — the on-chain
 * contract reference and deploy transaction.
 */
export function ContractCodeView({ code }: { code: ContractCode }): JSX.Element {
  const downloadHref = `data:text/plain;charset=utf-8,${encodeURIComponent(code.source)}`;
  return (
    <Card
      title={code.filename}
      description={
        code.mode === "simulated"
          ? "Simulated model — a real network runs the equivalent."
          : undefined
      }
      actions={
        <>
          <Pill tone="info">{code.language}</Pill>
          <a
            href={downloadHref}
            download={code.filename}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700"
          >
            <Icon name="doc" className="w-3.5 h-3.5" />
            Download
          </a>
        </>
      }
    >
      <div className="space-y-4">
        {code.constructorArgs.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
              Constructor arguments
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              {code.constructorArgs.map((a) => (
                <div key={a.name} className="contents">
                  <dt className="text-slate-500 font-medium">{a.name}</dt>
                  <dd className="font-mono text-slate-700 break-all">{a.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {code.deployed && (
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="ok">deployed</Pill>
            <span
              className="inline-flex items-center rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 text-[11px] font-mono"
              title={code.deployed.contractRef}
            >
              contract {truncate(code.deployed.contractRef)}
            </span>
            <span
              className="inline-flex items-center rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 text-[11px] font-mono"
              title={code.deployed.deployTxHash}
            >
              tx {truncate(code.deployed.deployTxHash)}
            </span>
          </div>
        )}

        <pre className="overflow-x-auto text-xs font-mono bg-slate-950 text-slate-100 rounded-lg p-4">
          {code.source}
        </pre>
      </div>
    </Card>
  );
}

function truncate(v: string): string {
  return v.length > 18 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v;
}
