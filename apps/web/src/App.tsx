import { useEffect, useState } from "react";
import { api } from "./api.js";
import { useAuth } from "./auth.js";
import { useRoute } from "./router.js";
import { ApprovalsPanel } from "./components/ApprovalsPanel.js";
import { AppShell, type NavItem } from "./components/AppShell.js";
import { AssetManagement, isInvoiceUseCase } from "./components/AssetManagement.js";
import { Dashboard } from "./components/Dashboard.js";
import { Developers } from "./components/Developers.js";
import { Home } from "./components/Home.js";
import { IdentityDashboard } from "./components/IdentityDashboard.js";
import { IdentityHome } from "./components/IdentityHome.js";
import { InvestorPortal } from "./components/InvestorPortal.js";
import { InvoiceRegister } from "./components/InvoiceRegister.js";
import { IssueUsecaseCredential } from "./components/IssueUsecaseCredential.js";
import { Login } from "./components/Login.js";
import { MyIdentity } from "./components/MyIdentity.js";
import { MyProfile } from "./components/MyProfile.js";
import { Organizations } from "./components/Organizations.js";
import { OrganizationWallet } from "./components/OrganizationWallet.js";
import { PlatformHome, type PlatformTab } from "./components/PlatformHome.js";
import { AuditConsole } from "./components/AuditConsole.js";
import { PublicVerify } from "./components/PublicVerify.js";
import { QrSign } from "./components/QrSign.js";
import { Signup } from "./components/Signup.js";
import { UseCaseBuilder } from "./components/UseCaseBuilder.js";
import { UserManagement } from "./components/UserManagement.js";
import { VerificationRequests } from "./components/VerificationRequests.js";
import { SectionHeader } from "./components/ui.js";
import { confirmNavigation } from "./lib/nav-guard.js";
import { can, canManageUsers } from "./rbac.js";
import { DOMAINS, DOMAIN_KEYS, type DomainKey, loadActiveDomain, saveActiveDomain, itemsForDomain, availableDomains } from "./domains.js";
import type { ChainInfo, CredentialUseCase, OrgOperatingRole, UseCase } from "./types.js";

export function App(): JSX.Element {
  const { token, user, logout } = useAuth();
  const { useCaseKey: routeKey, navigate } = useRoute();
  const [chains, setChains] = useState<ChainInfo[]>([]);
  const [useCases, setUseCases] = useState<UseCase[]>([]);
  const [view, setView] = useState<string>("dashboard");
  const [enabledDomains, setEnabledDomains] = useState<DomainKey[]>(DOMAIN_KEYS);
  const [activeDomain, setActiveDomain] = useState<DomainKey>(() => loadActiveDomain(DOMAIN_KEYS));
  // The credential use case this desk operates, loaded only for an identity-domain
  // desk user (drives the Issue Credentials surface). Null otherwise.
  const [deskCredUC, setDeskCredUC] = useState<CredentialUseCase | null>(null);

  const reloadUseCases = (): void => { if (token) void api.useCases(token).then(setUseCases); };
  const reloadDeskCredUC = (): void => {
    if (token && user?.useCaseKey) void api.credentialUseCase(token, user.useCaseKey).then(setDeskCredUC).catch(() => setDeskCredUC(null));
  };

  useEffect(() => {
    if (!token) return;
    void Promise.all([api.chains(token), api.useCases(token)]).then(([c, u]) => { setChains(c); setUseCases(u); });
    // Isolated from chains/useCases: a /config failure must not blank the dashboard —
    // it only falls back to all domains, leaving the rest of the app fully functional.
    void api.config(token).then((cfg) => {
      const enabled = (cfg.domains as DomainKey[]).filter((d) => DOMAIN_KEYS.includes(d));
      const eff = enabled.length ? enabled : DOMAIN_KEYS;
      setEnabledDomains(eff);
      setActiveDomain((cur) => (eff.includes(cur) ? cur : loadActiveDomain(eff)));
    }).catch(() => { setEnabledDomains(DOMAIN_KEYS); });
  }, [token]);

  // Scoped users are clamped to their own use case's path.
  useEffect(() => {
    if (user && user.useCaseKey && routeKey !== user.useCaseKey) navigate(`/${user.useCaseKey}`);
  }, [user, routeKey, navigate]);

  // Load the desk's own credential use case for identity-domain operators.
  useEffect(() => {
    if (token && user?.useCaseKey && user.useCaseDomain === "identity") {
      void api.credentialUseCase(token, user.useCaseKey).then(setDeskCredUC).catch(() => setDeskCredUC(null));
    } else {
      setDeskCredUC(null);
    }
  }, [token, user?.useCaseKey, user?.useCaseDomain]);

  // Reset the active view when the active use case changes — honouring a one-shot
  // intent (e.g. "Start tokenizing" lands on the Asset Ledger) set before navigating.
  useEffect(() => {
    const want = sessionStorage.getItem("tl:section");
    if (want) sessionStorage.removeItem("tl:section");
    setView(want === "assets" ? "assets" : "dashboard");
  }, [user?.role === "PlatformAdmin" ? routeKey : user?.useCaseKey]);

  // An enrolled device opening a QR's signUrl must reach the sign page
  // regardless of its own session — so this precedes the auth gate below.
  // Placed after all hooks to keep hook order unconditional on every render.
  if (routeKey === "qr-sign") return <QrSign />;

  // The PUBLIC verification portal, before the auth gate for the same reason as
  // qr-sign: its whole audience is people with no account here — a counterparty
  // handed a certificate, a citizen, a regulator. It also has to work for a
  // signed-in operator who follows a link, so it precedes the session check
  // rather than living inside the console's view switch.
  if (routeKey === "verify") return <PublicVerify />;

  // Public (unauthenticated) surface: a marketing homepage plus the corporate
  // self-registration flow. The first path segment selects the screen.
  if (!token || !user) {
    if (routeKey === "signup") return <Signup />;
    if (routeKey === "login") return <Login />;
    return <Home />;
  }

  const isPlatform = user.role === "PlatformAdmin";
  const isOrgAdmin = user.role === "OrgAdmin";
  const activeUseCase = isPlatform ? routeKey : user.useCaseKey ?? "";

  const handleSelect = (id: string): void => {
    // The panel being replaced may be holding something that unmounting would
    // destroy — today, the one-time API key secret on the Developers panel. Ask
    // it first; with no guard registered this is a no-op for every other panel.
    if (!confirmNavigation()) return;
    if (id === "logout") { navigate("/"); logout(); return; }
    if (id === "back") { navigate("/"); return; }
    setView(id);
  };

  const onDomainChange = (d: DomainKey): void => {
    // Switching domain also swaps the panel out, so it needs the same gate.
    if (!confirmNavigation()) return;
    setActiveDomain(d);
    saveActiveDomain(d);
    setView(DOMAINS.find((x) => x.key === d)!.defaultView);
  };

  const pinned: NavItem[] = [
    { id: "profile", label: "My Profile", icon: "users", pinned: true },
    { id: "credentials", label: "My Credentials", icon: "shield", pinned: true },
    { id: "logout", label: "Logout", icon: "arrow", pinned: true },
  ];

  // Investors get the dedicated portal experience instead of the operator console —
  // plus My Profile and My Credentials, so a Buyer holder can reach their credentials
  // and their verification-request inbox (otherwise the holder side is unreachable).
  if (user.role === "Buyer") {
    const items: NavItem[] = [
      { id: "portfolio", label: "Portfolio", icon: "coins" },
      { id: "offerings", label: "Offerings", icon: "spark" },
      { id: "transactions", label: "Recent Transactions", icon: "arrow" },
      ...pinned,
    ];
    const buyerTab: "offerings" | "portfolio" | "activity" =
      view === "offerings" ? "offerings" : view === "transactions" ? "activity" : "portfolio";
    const activeId = ["portfolio", "offerings", "transactions", "profile", "credentials"].includes(view) ? view : "portfolio";
    const panel =
      view === "profile" ? <MyProfile onSelect={setView} />
      : view === "credentials" ? <MyIdentity />
      : <InvestorPortal useCases={useCases} tab={buyerTab} onTabChange={(t) => setView(t === "activity" ? "transactions" : t)} />;
    return <AppShell items={items} active={activeId} onSelect={handleSelect}>{panel}</AppShell>;
  }

  if (isPlatform && !activeUseCase) {
    const items: NavItem[] = [
      { id: "dashboard", label: "Dashboard", icon: "spark" },
      { id: "use-cases", label: "Use Cases", icon: "doc" },
      { id: "create", label: "Create Use Case", icon: "code" },
      { id: "organizations", label: "Organizations", icon: "users" },
      { id: "developers", label: "Developers", icon: "code" },
      { id: "audit", label: "Audit", icon: "shield" },
      { id: "approvals", label: "Approvals", icon: "check" },
      { id: "verify", label: "Verification", icon: "shield" },
      { id: "identity", label: "Identity", icon: "shield" },
      { id: "identity-dashboard", label: "Identity Dashboard", icon: "spark" },
      { id: "networks", label: "Networks", icon: "chain" },
      ...pinned,
    ];
    const platViews: Record<string, PlatformTab> = {
      dashboard: "overview", "use-cases": "use-cases", create: "create",
      organizations: "organizations", approvals: "approvals", verify: "verify", networks: "networks", identity: "identity",
    };
    const branchDomains = availableDomains(items, enabledDomains);
    const effDomain = branchDomains.some((d) => d.key === activeDomain) ? activeDomain : (branchDomains[0]?.key ?? activeDomain);
    const visible = itemsForDomain(items, effDomain);
    const knownIds = [...Object.keys(platViews), "profile", "credentials", "identity-dashboard", "developers", "audit"];
    const activeId = knownIds.includes(view) && itemsForDomain([{ id: view }], effDomain).length ? view : DOMAINS.find((d) => d.key === effDomain)!.defaultView;
    const panel =
      activeId === "profile" ? <MyProfile onSelect={setView} />
      : activeId === "credentials" ? <MyIdentity />
      : activeId === "identity-dashboard" ? <IdentityDashboard />
      : activeId === "developers" ? <Developers />
      : activeId === "audit" ? <AuditConsole enabledDomains={enabledDomains} />
      : <PlatformHome useCases={useCases} chains={chains} onReloadUseCases={reloadUseCases} view={platViews[activeId] ?? "overview"} />;
    return <AppShell items={visible} active={activeId} onSelect={handleSelect} domains={branchDomains} activeDomain={effDomain} onDomainChange={onDomainChange}>{panel}</AppShell>;
  }

  // Operator console: desk roles (UseCaseAdmin/Issuer/Auditor), OrgAdmin, and a
  // PlatformAdmin scoped into a specific use case.
  //
  // Identity-domain desk: a credential-use-case-scoped operator (UseCaseAdmin /
  // Issuer / Verifier / Holder). Their nav + panels are the credential desk, not
  // the tokenization ledger. OrgAdmin and everyone tokenization-scoped fall
  // through to the unchanged branch below (their useCaseDomain is null →
  // "tokenization"), so nothing about the existing desk changes.
  const deskDomain = user.useCaseDomain ?? "tokenization";
  if (deskDomain === "identity") {
    const r = user.role;
    const idItems: NavItem[] = [
      ...(r === "UseCaseAdmin" || r === "Issuer" ? [{ id: "identity-dashboard", label: "Dashboard", icon: "spark" as const }] : []),
      ...(r === "UseCaseAdmin" || r === "Issuer" ? [{ id: "issue-credentials", label: "Issue Credentials", icon: "doc" as const }] : []),
      ...(r === "UseCaseAdmin" || r === "Verifier" ? [{ id: "verify", label: "Verification", icon: "shield" as const }] : []),
      ...(r === "UseCaseAdmin" || r === "Issuer" ? [{ id: "approvals", label: "Approvals", icon: "check" as const }] : []),
      ...(canManageUsers(r) ? [{ id: "users", label: "User Management", icon: "users" as const }] : []),
      ...pinned,
    ];
    const idIds = idItems.map((i) => i.id).filter((id) => id !== "logout");
    const idActive = idIds.includes(view) ? view : (idIds[0] ?? "credentials");
    let idPanel: JSX.Element;
    if (idActive === "identity-dashboard") {
      idPanel = <IdentityDashboard />;
    } else if (idActive === "issue-credentials") {
      idPanel = deskCredUC
        ? <IssueUsecaseCredential useCase={deskCredUC} onIssued={reloadDeskCredUC} />
        : <SectionHeader title="Issue Credentials" description="Loading this desk's credential use case…" />;
    } else if (idActive === "verify") {
      idPanel = <VerificationRequests />;
    } else if (idActive === "approvals") {
      idPanel = <ApprovalsPanel />;
    } else if (idActive === "users") {
      idPanel = <UserManagement useCaseKey={user.useCaseKey ?? ""} useCases={useCases} />;
    } else if (idActive === "profile") {
      idPanel = <MyProfile onSelect={setView} />;
    } else {
      idPanel = <MyIdentity />;
    }
    return <AppShell items={idItems} active={idActive} onSelect={handleSelect}>{idPanel}</AppShell>;
  }

  const activeUseCaseObj = useCases.find((u) => u.key === activeUseCase);
  const showInvoices = isInvoiceUseCase(activeUseCaseObj) && can(user.role, "issue");

  // EN-A capability envelope — applied to the OrgAdmin console only. `null`
  // (legacy) makes every check below a no-op, so a legacy org's nav is
  // byte-identical to before. A PlatformAdmin bypasses org capabilities
  // server-side, and scoped desk operators are already clamped by their own
  // role + use case, so neither is narrowed here.
  const envelope = isOrgAdmin ? user.orgCapabilities ?? null : null;
  const orgCan = (role: OrgOperatingRole): boolean => envelope === null || envelope.roles.includes(role);

  const items: NavItem[] = [
    ...(isPlatform ? [{ id: "back", label: "← All use cases", icon: "arrow" as const }] : []),
    { id: "dashboard", label: isOrgAdmin ? "Configure Use Case" : "Dashboard", icon: isOrgAdmin ? "code" : "spark" },
    { id: "assets", label: "Asset Ledger", icon: "coins" },
    ...(showInvoices ? [{ id: "invoices", label: "Invoices", icon: "doc" as const }] : []),
    { id: "approvals", label: "Approvals", icon: "check" },
    ...(canManageUsers(user.role) ? [{ id: "users", label: "User Management", icon: "users" as const }] : []),
    ...(isPlatform || isOrgAdmin ? [{ id: "organizations", label: "Organizations", icon: "users" as const }] : []),
    ...(isPlatform || isOrgAdmin ? [{ id: "developers", label: "Developers", icon: "code" as const }] : []),
    // Audit is offered to the two roles that answer for the tenant. A scoped
    // desk operator is left out on purpose: GET /events is ORG-grained, so it
    // would show them every use case in the org, including ones they cannot open.
    ...(isPlatform || isOrgAdmin ? [{ id: "audit", label: "Audit", icon: "shield" as const }] : []),
    ...((isPlatform || isOrgAdmin) && orgCan("Verifier") ? [{ id: "verify", label: "Verification", icon: "shield" as const }] : []),
    ...(isPlatform || isOrgAdmin ? [{ id: "identity", label: "Identity", icon: "shield" as const }] : []),
    ...(isPlatform || isOrgAdmin ? [{ id: "identity-dashboard", label: "Identity Dashboard", icon: "spark" as const }] : []),
    ...(isOrgAdmin && orgCan("Holder") ? [{ id: "org-wallet", label: "Organization Wallet", icon: "coins" as const }] : []),
    ...pinned,
  ];

  // Intersect the deployment's enabled domains with the org's envelope BEFORE
  // availableDomains, so an identity-only org never sees a Tokenization switcher.
  const capDomains = envelope === null ? enabledDomains : enabledDomains.filter((d) => envelope.domains.includes(d));
  const branchDomains = availableDomains(items, capDomains);
  const effDomain = branchDomains.some((d) => d.key === activeDomain) ? activeDomain : (branchDomains[0]?.key ?? activeDomain);
  const visible = itemsForDomain(items, effDomain);
  const deskIds = visible.map((i) => i.id).filter((id) => id !== "back" && id !== "logout");
  const activeId = deskIds.includes(view) ? view : (deskIds.includes(DOMAINS.find((d) => d.key === effDomain)!.defaultView) ? DOMAINS.find((d) => d.key === effDomain)!.defaultView : (deskIds[0] ?? "dashboard"));

  // Render the panel from the reconciled `activeId` (not raw `view`) so the panel
  // always matches the sidebar highlight — including after a reload with a stale
  // persisted domain, where `view` may point at a surface hidden in the active domain.
  let panel: JSX.Element;
  if (activeId === "assets") {
    panel = <AssetManagement useCaseKey={activeUseCase} useCases={useCases} chains={chains} />;
  } else if (activeId === "invoices") {
    panel = activeUseCaseObj
      ? <InvoiceRegister useCase={activeUseCaseObj} chains={chains} />
      : (
        <div>
          <SectionHeader title="Invoices" description="Select an invoice use case to view its register." />
        </div>
      );
  } else if (activeId === "approvals") {
    panel = <ApprovalsPanel />;
  } else if (activeId === "users") {
    panel = <UserManagement useCaseKey={activeUseCase} useCases={useCases} />;
  } else if (activeId === "organizations") {
    panel = <Organizations />;
  } else if (activeId === "developers") {
    panel = <Developers />;
  } else if (activeId === "audit") {
    // Scoped to the use case being operated, so the integrity tab verifies the
    // chains of the assets on screen rather than every asset on the platform.
    panel = <AuditConsole useCaseKey={activeUseCase} enabledDomains={enabledDomains} />;
  } else if (activeId === "verify") {
    panel = <VerificationRequests />;
  } else if (activeId === "identity") {
    panel = <IdentityHome />;
  } else if (activeId === "identity-dashboard") {
    panel = <IdentityDashboard />;
  } else if (activeId === "org-wallet") {
    panel = <OrganizationWallet />;
  } else if (activeId === "profile") {
    panel = <MyProfile onSelect={setView} />;
  } else if (activeId === "credentials") {
    panel = <MyIdentity />;
  } else if (isOrgAdmin) {
    // Dashboard slot for OrgAdmin is the low-code use-case configurator.
    panel = (
      <div>
        <SectionHeader title="Configure a use case" description="Design your tokenization use case low-code; it is submitted to the platform for approval, then deploys automatically." />
        <UseCaseBuilder chains={chains} existing={useCases} onCreated={reloadUseCases} />
      </div>
    );
  } else {
    panel = <Dashboard useCaseKey={activeUseCase} />;
  }

  return <AppShell items={visible} active={activeId} onSelect={handleSelect} domains={branchDomains} activeDomain={effDomain} onDomainChange={onDomainChange}>{panel}</AppShell>;
}
