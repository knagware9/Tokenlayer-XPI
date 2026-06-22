import { useEffect, useState } from "react";
import { api } from "./api.js";
import { useAuth } from "./auth.js";
import { AssetDetail } from "./components/AssetDetail.js";
import { AssetList } from "./components/AssetList.js";
import { Header } from "./components/Header.js";
import { IssuePanel } from "./components/IssuePanel.js";
import { Login } from "./components/Login.js";
import { MyHoldings } from "./components/MyHoldings.js";
import { UseCaseBuilder } from "./components/UseCaseBuilder.js";
import { UsersAdmin } from "./components/UsersAdmin.js";
import type { ChainInfo, Role, UseCase } from "./types.js";

type Tab = "assets" | "issue" | "build" | "users" | "holdings";

const TABS_BY_ROLE: Record<Role, { id: Tab; label: string }[]> = {
  PlatformAdmin: [
    { id: "build", label: "Use Cases" },
    { id: "users", label: "Use-Case Admins" },
    { id: "assets", label: "All Assets" },
  ],
  UseCaseAdmin: [
    { id: "assets", label: "Assets" },
    { id: "issue", label: "Issue Asset" },
    { id: "users", label: "Users" },
  ],
  Issuer: [
    { id: "assets", label: "Assets" },
    { id: "issue", label: "Issue Asset" },
  ],
  Trader: [{ id: "assets", label: "Trading Desk" }],
  Buyer: [
    { id: "assets", label: "Marketplace" },
    { id: "holdings", label: "My Holdings" },
  ],
  Auditor: [{ id: "assets", label: "Assets" }],
};

export function App(): JSX.Element {
  const { token, user } = useAuth();
  const [chains, setChains] = useState<ChainInfo[]>([]);
  const [useCases, setUseCases] = useState<UseCase[]>([]);
  const [tab, setTab] = useState<Tab>("assets");
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const reloadUseCases = (): void => {
    if (token) void api.useCases(token).then(setUseCases);
  };

  useEffect(() => {
    if (!token) return;
    void Promise.all([api.chains(token), api.useCases(token)]).then(([c, u]) => {
      setChains(c);
      setUseCases(u);
    });
  }, [token]);

  useEffect(() => {
    if (user) { const first = TABS_BY_ROLE[user.role][0]; if (first) setTab(first.id); }
  }, [user?.role]);

  if (!token || !user) return <Login />;
  const tabs = TABS_BY_ROLE[user.role];

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-6xl mx-auto px-6 py-6">
        {selected ? (
          <AssetDetail assetId={selected} useCases={useCases} chains={chains} onBack={() => setSelected(null)} onChanged={() => setRefreshKey((k) => k + 1)} />
        ) : (
          <>
            <div className="flex gap-1 mb-5">
              {tabs.map((t) => (
                <TabButton key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
                  {t.label}
                </TabButton>
              ))}
            </div>
            {tab === "assets" && <AssetList chains={chains} refreshKey={refreshKey} onSelect={setSelected} />}
            {tab === "issue" && (
              <IssuePanel useCases={useCases} chains={chains} onIssued={(id) => { setRefreshKey((k) => k + 1); setSelected(id); }} />
            )}
            {tab === "build" && <UseCaseBuilder chains={chains} existing={useCases} onCreated={reloadUseCases} />}
            {tab === "users" && <UsersAdmin useCases={useCases} />}
            {tab === "holdings" && <MyHoldings onSelect={setSelected} />}
          </>
        )}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button onClick={onClick} className={`px-4 py-2 rounded-lg text-sm font-medium ${active ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}>
      {children}
    </button>
  );
}
