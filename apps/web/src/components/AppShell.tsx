import { useAuth } from "../auth.js";
import type { DomainDef, DomainKey } from "../domains.js";
import { Logo } from "./Logo.js";
import { Icon, type IconName } from "./ui.js";

export type NavItem = { id: string; label: string; icon: IconName; pinned?: boolean };

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
  const { user } = useAuth();

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
    <div className="flex min-h-screen">
      {/* Fixed, always-visible left navigation — static on every screen size. */}
      <aside className="w-64 shrink-0 bg-ink border-r border-ink-700 flex flex-col sticky top-0 h-screen">
        <div className="px-5 h-16 flex items-center shrink-0">
          <Logo onDark size={30} />
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
