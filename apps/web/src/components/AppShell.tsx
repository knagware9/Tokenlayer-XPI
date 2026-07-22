import { useState } from "react";
import { useAuth } from "../auth.js";
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
}: {
  items: NavItem[];
  active: string;
  onSelect: (id: string) => void;
  children: React.ReactNode;
}): JSX.Element {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  const main = items.filter((i) => !i.pinned);
  const pinned = items.filter((i) => i.pinned);

  const navButton = (item: NavItem): JSX.Element => {
    const isActive = active === item.id;
    return (
      <button
        key={item.id}
        onClick={() => { onSelect(item.id); setOpen(false); }}
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
      {open && (
        <div
          className="fixed inset-0 z-30 bg-ink/60 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={`w-64 shrink-0 bg-ink border-r border-ink-700 flex flex-col fixed inset-y-0 left-0 z-40 transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="px-5 h-16 flex items-center shrink-0">
          <Logo onDark size={30} />
        </div>
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
          <button
            onClick={() => setOpen(true)}
            className="md:hidden mr-auto text-slate-500 hover:text-slate-800"
            aria-label="Open navigation"
          >
            <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
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
