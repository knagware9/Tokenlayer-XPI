import { useEffect, useState } from "react";
import { api } from "./api.js";
import { useAuth } from "./auth.js";
import { useRoute } from "./router.js";
import { ApprovalsPanel } from "./components/ApprovalsPanel.js";
import { AssetManagement } from "./components/AssetManagement.js";
import { Dashboard } from "./components/Dashboard.js";
import { Header } from "./components/Header.js";
import { Home } from "./components/Home.js";
import { InvestorPortal } from "./components/InvestorPortal.js";
import { Login } from "./components/Login.js";
import { MyIdentity } from "./components/MyIdentity.js";
import { Organizations } from "./components/Organizations.js";
import { PlatformHome } from "./components/PlatformHome.js";
import { Signup } from "./components/Signup.js";
import { UseCaseBuilder } from "./components/UseCaseBuilder.js";
import { UserManagement } from "./components/UserManagement.js";
import { VerificationRequests } from "./components/VerificationRequests.js";
import { SectionHeader } from "./components/ui.js";
import { canManageUsers } from "./rbac.js";
import type { ChainInfo, UseCase } from "./types.js";

type Section = "overview" | "assets" | "approvals" | "users" | "organizations" | "verify" | "identity";

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

  // Reset to the Overview section whenever the active use case changes.
  // Reset the section when the active use case changes — honouring a one-shot
  // intent (e.g. "Start tokenizing" lands on Asset Management) set before navigating.
  useEffect(() => {
    const want = sessionStorage.getItem("tl:section");
    if (want) sessionStorage.removeItem("tl:section");
    setSection(want === "assets" ? "assets" : "overview");
  }, [user?.role === "PlatformAdmin" ? routeKey : user?.useCaseKey]);

  // Public (unauthenticated) surface: a marketing homepage plus the corporate
  // self-registration flow. The first path segment selects the screen.
  if (!token || !user) {
    if (routeKey === "signup") return <Signup />;
    if (routeKey === "login") return <Login />;
    return <Home />;
  }

  const isPlatform = user.role === "PlatformAdmin";
  const activeUseCase = isPlatform ? routeKey : user.useCaseKey ?? "";

  // Investors get the dedicated portal experience instead of the operator console —
  // plus a My-identity tab, so a Buyer holder can reach their credentials and their
  // verification-request inbox (otherwise the holder side of verification is unreachable).
  if (user.role === "Buyer") {
    const buyerTab: "portfolio" | "identity" = section === "identity" ? "identity" : "portfolio";
    return (
      <div className="min-h-screen">
        <Header />
        <main className="max-w-6xl mx-auto px-6 py-6">
          <div className="flex gap-1 mb-5">
            {([{ id: "portfolio", label: "Portfolio" }, { id: "identity", label: "My identity" }] as const).map((t) => (
              <button
                key={t.id}
                onClick={() => setSection(t.id === "identity" ? "identity" : "overview")}
                className={`px-4 py-2 rounded-lg text-sm font-medium ${buyerTab === t.id ? "bg-white text-brand-700 shadow-sm border border-slate-200" : "text-slate-500 hover:text-slate-800"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {buyerTab === "portfolio" ? <InvestorPortal useCases={useCases} /> : <MyIdentity />}
        </main>
      </div>
    );
  }

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
    { id: "overview", label: "Overview" },
    { id: "assets", label: "Asset Management" },
    { id: "approvals", label: "Approvals" },
    ...(canManageUsers(user.role) ? [{ id: "users" as Section, label: "User Management" }] : []),
    ...(isPlatform || user.role === "OrgAdmin" ? [{ id: "organizations" as Section, label: "Organizations" }] : []),
    ...(isPlatform || user.role === "OrgAdmin" ? [{ id: "verify" as Section, label: "Verification" }] : []),
    { id: "identity" as Section, label: "My identity" },
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
        {section === "overview" && (user.role === "OrgAdmin" ? (
          <div>
            <SectionHeader title="Configure a use case" description="Design your tokenization use case low-code; it is submitted to the platform for approval, then deploys automatically." />
            <UseCaseBuilder chains={chains} existing={useCases} onCreated={reloadUseCases} />
          </div>
        ) : (
          <Dashboard useCaseKey={activeUseCase} />
        ))}
        {section === "assets" && <AssetManagement useCaseKey={activeUseCase} useCases={useCases} chains={chains} />}
        {section === "approvals" && <ApprovalsPanel />}
        {section === "users" && <UserManagement useCaseKey={activeUseCase} useCases={useCases} />}
        {section === "organizations" && <Organizations />}
        {section === "verify" && <VerificationRequests />}
        {section === "identity" && <MyIdentity />}
      </main>
    </div>
  );
}
