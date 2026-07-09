import { useState } from "react";
import { useRoute } from "../router.js";
import type { ChainInfo, UseCase } from "../types.js";
import { Dashboard } from "./Dashboard.js";
import { UseCaseBuilder } from "./UseCaseBuilder.js";

export function PlatformHome({ useCases, chains, onReloadUseCases }: { useCases: UseCase[]; chains: ChainInfo[]; onReloadUseCases: () => void }): JSX.Element {
  const { navigate } = useRoute();
  const [selected, setSelected] = useState<string>(useCases[0]?.key ?? "");
  const chosen = useCases.find((u) => u.key === selected);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-semibold text-slate-900 mb-3">Platform overview</h2>
        <Dashboard />
      </div>

      <div>
        <h2 className="font-semibold text-slate-900 mb-1">Use cases</h2>
        <p className="text-sm text-slate-500 mb-3">Select an existing use-case template and start tokenizing your assets.</p>
        {useCases.length === 0 ? (
          <p className="text-sm text-slate-500">No use cases yet — set one up below.</p>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-end gap-3">
            <label className="flex-1 block">
              <span className="text-xs font-medium text-slate-500">Use-case template</span>
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                {useCases.map((u) => (
                  <option key={u.key} value={u.key}>
                    {u.name} — {u.tokenStandard} ({u.symbol})
                  </option>
                ))}
              </select>
            </label>
            {chosen && (
              <div className="text-xs text-slate-400 sm:pb-2 sm:max-w-xs">
                <span className="text-slate-500">{chosen.key}</span>
                {chosen.description ? <span className="block line-clamp-2 mt-0.5">{chosen.description}</span> : null}
              </div>
            )}
            <button
              onClick={() => selected && navigate(`/${selected}`)}
              disabled={!selected}
              className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-semibold hover:bg-brand-700 disabled:opacity-50 whitespace-nowrap"
            >
              Start tokenizing →
            </button>
          </div>
        )}
      </div>

      <div>
        <h2 className="font-semibold text-slate-900 mb-3">Setup/Configure your Use case</h2>
        <UseCaseBuilder chains={chains} existing={useCases} onCreated={onReloadUseCases} />
      </div>
    </div>
  );
}
