import { useRoute } from "../router.js";
import type { ChainInfo, UseCase } from "../types.js";
import { Dashboard } from "./Dashboard.js";
import { UseCaseBuilder } from "./UseCaseBuilder.js";

export function PlatformHome({ useCases, chains, onReloadUseCases }: { useCases: UseCase[]; chains: ChainInfo[]; onReloadUseCases: () => void }): JSX.Element {
  const { navigate } = useRoute();
  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-semibold text-slate-900 mb-3">Platform overview</h2>
        <Dashboard />
      </div>
      <div>
        <h2 className="font-semibold text-slate-900 mb-3">Use cases</h2>
        {useCases.length === 0 ? (
          <p className="text-sm text-slate-500">No use cases yet — define one below.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {useCases.map((u) => (
              <button key={u.key} onClick={() => navigate(`/${u.key}`)} className="text-left bg-white rounded-xl border border-slate-200 p-4 hover:border-brand-500 hover:shadow-sm transition">
                <div className="font-medium text-slate-800">{u.name}</div>
                <div className="text-xs text-slate-400 mt-0.5">{u.key}</div>
                <span className="inline-block mt-2 text-[10px] px-1.5 py-0.5 rounded bg-brand-600 text-white font-semibold">{u.tokenStandard}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div>
        <h2 className="font-semibold text-slate-900 mb-3">Define a new use case</h2>
        <UseCaseBuilder chains={chains} existing={useCases} onCreated={onReloadUseCases} />
      </div>
    </div>
  );
}
