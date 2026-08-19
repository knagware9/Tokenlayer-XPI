import { useEffect, useRef, useState } from "react";
import { api } from "../../api.js";
import { activePersona, landingView, narrowToPersona } from "../../lib/shared/persona.js";
import { useAuth } from "../../auth.js";
import type { DomainDef, DomainKey } from "../../domains.js";
import { brandCssVars } from "../../lib/shared/branding.js";
import { Logo } from "./Logo.js";
import { Icon, type IconName } from "./ui.js";

export type NavItem = { id: string; label: string; icon: IconName; pinned?: boolean };

/**
 * EN-E: the org's mark as an object URL, or null.
 *
 * The bytes need a bearer token and an `<img src>` sends none, so they have to
 * be fetched and wrapped. Every URL created here is revoked when the id changes
 * and when the shell unmounts — otherwise each logo change would strand a blob
 * for the life of the tab.
 *
 * TWO DOORS, because the two callers are asking different questions (Task 6b).
 * It fetches `GET /orgs/:id/branding/logo` — the org's SAVED mark, readable by
 * every member of that org. `GET /documents/:id` cannot serve this: that route
 * requires the `issue` capability or the Auditor role, so it 403s for an
 * OrgAdmin, a Trader, a Buyer, a Holder and a Verifier — every role but a desk
 * operator's, which is every role that most needs to see its own org's mark.
 *
 * There is deliberately NO id-addressed fallback. A logo that has been uploaded
 * but not yet saved is previewed from the `File` the browser already holds (see
 * `OrgBrandingCard`), so nothing needs to read the document store by id, and no
 * caller can quietly reintroduce the 403.
 *
 * `documentId` is the trigger: it is what changes when the brand changes, and a
 * falsy one means "unbranded", so no request is made at all.
 */
export function useOrgLogo(documentId: string | null | undefined, token: string | null, orgId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!documentId || !token || !orgId) { setUrl(null); return; }
    let objectUrl: string | null = null;
    // A slow fetch that resolves after the id changed must not install its blob
    // over the newer one — and its URL is revoked in this effect's own cleanup.
    let cancelled = false;
    void api.brandLogo(token, orgId)
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
  }, [documentId, token, orgId]);
  return url;
}

/**
 * The single left-sidebar console shell shared by every authenticated role.
 * The caller owns the nav model (`items`), the active id and selection — the
 * shell only renders the chrome and the current panel (`children`).
 *
 * PERSONA NARROWING happens HERE rather than at the four call sites, because
 * here it cannot be forgotten at one of them — and a persona app that leaked a
 * single extra entry would render a button whose request the edge container
 * refuses, which reads to the user as a broken product rather than a narrow one.
 * With no persona configured this is the identity function and the shell behaves
 * exactly as it always has.
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
  const persona = activePersona();
  const shown = narrowToPersona(items, persona);

  // If the caller's active view did not survive narrowing, move to one that did
  // rather than render an empty frame. A wallet opened on `dashboard` — the
  // full app's default — would otherwise show a sidebar and nothing beside it.
  const target = landingView(shown, persona, active);
  useEffect(() => {
    if (persona && shown.length > 0 && !shown.some((i) => i.id === active) && target !== active) onSelect(target);
  }, [persona, active, target, shown, onSelect]);
  // Through the org's own door, not the document store: every role that renders
  // this shell is refused by `GET /documents/:id`, which is why the sidebar mark
  // was invisible to all of them before Task 6b.
  const orgLogo = useOrgLogo(user?.brandLogoDocumentId, token, user?.orgId);

  // ONLY FOR SESSIONS THAT PREDATE TASK 6b. `POST /auth/login` and the QR poll
  // now carry the brand, so a session created from either arrives with both
  // fields present (`null` for an unbranded org) and this never fires. What it
  // still covers is a SessionUser restored from localStorage that was minted
  // before those routes carried the fields: `undefined` there means "not yet
  // fetched", and without one refresh such a session would paint the platform
  // palette at a branded org forever. `null` is a real answer, so this cannot
  // loop. The ref stops a failed request from retrying on every render.
  const brandKnown = user?.brandAccent !== undefined;
  const asked = useRef(false);
  useEffect(() => {
    if (!user || brandKnown || asked.current) return;
    asked.current = true;
    void refreshSession().catch(() => undefined);
  }, [user, brandKnown, refreshSession]);

  const main = shown.filter((i) => !i.pinned);
  const pinned = shown.filter((i) => i.pinned);

  const navButton = (item: NavItem): JSX.Element => {
    const isActive = active === item.id;
    return (
      <button
        key={item.id}
        onClick={() => onSelect(item.id)}
        className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm transition-all duration-150 relative ${
          isActive
            ? "bg-white/12 text-white font-semibold"
            : "text-slate-400 hover:text-white hover:bg-white/6 font-medium"
        }`}
        style={{ fontFamily: "'Manrope', system-ui, sans-serif" }}
      >
        {/* Active left-accent bar */}
        {isActive && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full bg-brand-400" aria-hidden="true" />
        )}
        <Icon name={item.icon} className={`w-4.5 h-4.5 shrink-0 transition-colors ${isActive ? "text-brand-400" : "text-slate-500 group-hover:text-slate-300"}`} />
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
      <aside className="w-64 shrink-0 bg-ink border-r border-ink-700/60 flex flex-col sticky top-0 h-screen" style={{ backgroundImage: "radial-gradient(ellipse at top left, #1a3d37 0%, #0E2B26 60%)" }}>
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
        {/* A persona app serves exactly one product; offering to switch to the
            other would offer a product this container's edge does not proxy. */}
        {!persona && domains && domains.length > 1 && activeDomain && onDomainChange && (
          <div className="px-3 pt-1 pb-2">
            <div className="flex gap-1 rounded-xl bg-white/5 p-1 border border-white/8">
              {domains.map((d) => (
                <button
                  key={d.key}
                  onClick={() => onDomainChange(d.key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold transition-all duration-150 ${
                    activeDomain === d.key
                      ? "bg-brand-500/20 text-brand-300 ring-1 ring-brand-400/30"
                      : "text-slate-400 hover:text-white hover:bg-white/6"
                  }`}
                  style={{ fontFamily: "'Manrope', system-ui, sans-serif" }}
                >
                  <Icon name={d.icon} className="w-3.5 h-3.5 shrink-0" />
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
        <div className="h-14 border-b border-slate-200/80 bg-white/50 backdrop-blur-sm flex items-center justify-end px-6 gap-3">
          <div className="text-xs font-medium text-slate-500 truncate" style={{ fontFamily: "'Manrope', system-ui, sans-serif" }}>{user?.email}</div>
          {user?.role && (
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-semibold text-brand-600 bg-brand-50 border border-brand-200/60 rounded-full px-2.5 py-1 whitespace-nowrap" style={{ fontFamily: "'Manrope', system-ui, sans-serif" }}>
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" aria-hidden="true" />
              {user.role}
            </span>
          )}
        </div>
        <main className="flex-1" style={{ fontFamily: "'Manrope', system-ui, sans-serif" }}>
          <div className="max-w-6xl mx-auto px-6 py-7">{children}</div>
        </main>
      </div>
    </div>
  );
}
