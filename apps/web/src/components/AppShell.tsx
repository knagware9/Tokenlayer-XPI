import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.js";
import type { DomainDef, DomainKey } from "../domains.js";
import { brandCssVars } from "../lib/branding.js";
import { Logo } from "./Logo.js";
import { Icon, type IconName } from "./ui.js";

export type NavItem = { id: string; label: string; icon: IconName; pinned?: boolean };

/**
 * EN-E: the org's mark as an object URL, or null.
 *
 * `GET /documents/:id` requires a bearer token and an `<img src>` sends none,
 * so the bytes have to be fetched and wrapped. Every URL created here is
 * revoked when the id changes and when the shell unmounts — otherwise each
 * logo change would strand a blob for the life of the tab.
 */
export function useOrgLogo(documentId: string | null | undefined, token: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!documentId || !token) { setUrl(null); return; }
    let objectUrl: string | null = null;
    // A slow fetch that resolves after the id changed must not install its blob
    // over the newer one — and its URL is revoked in this effect's own cleanup.
    let cancelled = false;
    void api.downloadDocument(token, documentId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      // A missing or unreadable logo is not worth an error surface in the
      // chrome: the platform mark beside it is already the identity.
      .catch(() => { if (!cancelled) setUrl(null); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [documentId, token]);
  return url;
}

/**
 * The single left-sidebar console shell shared by every authenticated role.
 * The caller owns the nav model (`items`), the active id and selection — the
 * shell only renders the chrome and the current panel (`children`).
 */
export function AppShell({
  items,
  active,
  onSelect,
  children,
  domains,
  activeDomain,
  onDomainChange,
}: {
  items: NavItem[];
  active: string;
  onSelect: (id: string) => void;
  children: React.ReactNode;
  domains?: DomainDef[];
  activeDomain?: DomainKey;
  onDomainChange?: (d: DomainKey) => void;
}): JSX.Element {
  const { user, token, refreshSession } = useAuth();
  const orgLogo = useOrgLogo(user?.brandLogoDocumentId, token);

  // `POST /auth/login` does not carry the brand — only `GET /me` does — so a
  // freshly signed-in (or localStorage-restored) session arrives with the two
  // fields ABSENT and would paint the platform palette at a branded org. One
  // refresh fills them in; `null` is a real answer, so this cannot loop. The
  // ref stops a failed request from retrying on every render.
  const brandKnown = user?.brandAccent !== undefined;
  const asked = useRef(false);
  useEffect(() => {
    if (!user || brandKnown || asked.current) return;
    asked.current = true;
    void refreshSession().catch(() => undefined);
  }, [user, brandKnown, refreshSession]);

  const main = items.filter((i) => !i.pinned);
  const pinned = items.filter((i) => i.pinned);

  const navButton = (item: NavItem): JSX.Element => {
    const isActive = active === item.id;
    return (
      <button
        key={item.id}
        onClick={() => onSelect(item.id)}
        className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          isActive ? "bg-white/10 text-white" : "text-slate-300 hover:text-white hover:bg-white/5"
        }`}
      >
        <Icon name={item.icon} className={`w-5 h-5 shrink-0 ${isActive ? "text-brand-400" : ""}`} />
        <span className="truncate">{item.label}</span>
      </button>
    );
  };

  return (
    // EN-E: six custom properties and the whole app follows, because every
    // `brand-*` class reads them. A member of an unbranded org gets `{}`, which
    // sets nothing and leaves the :root defaults standing.
    <div className="flex min-h-screen" style={brandCssVars(user?.brandAccent) as React.CSSProperties}>
      {/* Fixed, always-visible left navigation — static on every screen size. */}
      <aside className="w-64 shrink-0 bg-ink border-r border-ink-700 flex flex-col sticky top-0 h-screen">
        <div className="px-4 h-16 flex items-center gap-3 shrink-0 min-w-0">
          <Logo onDark size={orgLogo ? 26 : 30} />
          {orgLogo && (
            <>
              {/* The platform mark stays: this is XI Tokenize operated FOR the
                  org, not white-label, and the two marks say exactly that. */}
              <span className="w-px h-6 bg-white/20 shrink-0" aria-hidden="true" />
              <img src={orgLogo} alt="" className="h-7 max-w-[5.5rem] object-contain shrink-0" />
            </>
          )}
        </div>
        {domains && domains.length > 1 && activeDomain && onDomainChange && (
          <div className="px-3 pt-1 pb-2">
            <div className="flex gap-1 rounded-lg bg-white/5 p-1">
              {domains.map((d) => (
                <button
                  key={d.key}
                  onClick={() => onDomainChange(d.key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    activeDomain === d.key ? "bg-white/10 text-white" : "text-slate-400 hover:text-white"
                  }`}
                >
                  <Icon name={d.icon} className="w-4 h-4 shrink-0" />
                  <span className="truncate">{d.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
          {main.map(navButton)}
        </nav>
        {pinned.length > 0 && (
          <div className="px-3 pt-2 pb-3 border-t border-ink-700 space-y-1">
            {pinned.map(navButton)}
          </div>
        )}
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-14 border-b border-slate-200 flex items-center justify-end px-6 gap-4">
          <div className="text-xs font-medium text-slate-600 truncate">{user?.email}</div>
          {user?.role && (
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium text-brand-400 bg-brand-400/10 border border-brand-400/25 rounded-full px-2.5 py-1 whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-400" aria-hidden="true" />
              {user.role}
            </span>
          )}
        </div>
        <main className="flex-1 bg-slate-50">
          <div className="max-w-6xl mx-auto px-6 py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
