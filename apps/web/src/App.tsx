import { useEffect, useState } from "react";
import { api } from "./api.js";
import { useAuth } from "./auth.js";
import { useRoute } from "./router.js";
import { AssetManagement } from "./components/AssetManagement.js";
import { Header } from "./components/Header.js";
import { Login } from "./components/Login.js";
import { PlatformHome } from "./components/PlatformHome.js";
import { UserManagement } from "./components/UserManagement.js";
import { canManageUsers } from "./rbac.js";
import type { ChainInfo, UseCase } from "./types.js";

type Section = "assets" | "users";

export function App(): JSX.Element {
  const { token, user } = useAuth();
  const { useCaseKey: routeKey, navigate } = useRoute();
  const [chains, setChains] = useState<ChainInfo[]>([]);
  const [useCases, setUseCases] = useState<UseCase[]>([]);
  const [section, setSection] = useState<Section>("assets");

  const reloadUseCases = (): void => { if (token) void api.useCases(token).then(setUseCases); };

  useEffect(() => {
    if (!token) return;
    void Promise.all([api.chains(token), api.useCases(token)]).then(([c, u]) => { setChains(c); setUseCases(u); });
  }, [token]);

  // Scoped users are clamped to their own use case's path.
  useEffect(() => {
    if (user && user.useCaseKey && routeKey !== user.useCaseKey) navigate(`/${user.useCaseKey}`);
  }, [user, routeKey, navigate]);

  if (!token || !user) return <Login />;

  const isPlatform = user.role === "PlatformAdmin";
  const activeUseCase = isPlatform ? routeKey : user.useCaseKey ?? "";

  if (isPlatform && !activeUseCase) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="max-w-6xl mx-auto px-6 py-6">
          <PlatformHome useCases={useCases} chains={chains} onReloadUseCases={reloadUseCases} />
        </main>
      </div>
    );
  }

  const sections: { id: Section; label: string }[] = [
    { id: "assets", label: "Asset Management" },
    ...(canManageUsers(user.role) ? [{ id: "users" as Section, label: "User Management" }] : []),
  ];

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-6xl mx-auto px-6 py-6">
        <div className="flex gap-1 mb-5">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${section === s.id ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {section === "assets" && <AssetManagement useCaseKey={activeUseCase} useCases={useCases} chains={chains} />}
        {section === "users" && <UserManagement useCaseKey={activeUseCase} useCases={useCases} />}
      </main>
    </div>
  );
}
