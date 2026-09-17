import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api.js";
import { useAuth } from "../../auth.js";
import { activePersona } from "../../lib/shared/persona.js";
import { rankCommandResults, type CommandItem } from "../../lib/shared/command-search.js";
import { Icon, type IconName } from "./ui.js";
import type { NavItem } from "./AppShell.js";

const KIND_ICON: Record<CommandItem["kind"], IconName> = {
  nav: "layers",
  "use-case": "token",
  "credential-use-case": "shield",
  asset: "coins",
};

/**
 * Global Cmd+K / Ctrl+K search across nav items, use cases and assets.
 * Every data source it calls is an existing, already persona-/role-scoped
 * api method (api.useCases / api.credentialUseCases / api.assets) — this
 * component adds no new authorization surface. It also respects the exact
 * persona-gating this codebase already established for /use-cases: an
 * identity-only persona's edge never serves that route (see App.tsx's
 * useCasesSurfaced), so this palette must not call it there either or it
 * repeats the same doomed-CORS-fetch bug fixed in App.tsx/Organizations.tsx.
 *
 * THE MIRROR IMAGE HOLDS TOO. `credential-use-cases` is an identity-domain
 * route: in the standard linked-stacks topology (stack-up.sh, IDENTITY_SERVICE_URL
 * set) a tokenization persona's own API narrows ENABLED_DOMAINS to just
 * "tokenization" and never serves it at all — verified live, it 404s with no
 * CORS headers, the same failure shape as the bug above. So this is gated by
 * `persona.domain === "identity"` the same way the use-case/asset calls are
 * gated by `useCasesSurfaced`, for the same reason.
 */
export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  navItems: NavItem[];
  onSelectNav: (id: string) => void;
}): JSX.Element | null {
  const { open, onClose, navItems, onSelectNav } = props;
  const { token } = useAuth();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [extra, setExtra] = useState<CommandItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const persona = activePersona();
  const useCasesSurfaced = !persona || persona.surfaces.includes("use-cases");
  // See the class doc: a tokenization-only persona's own API does not serve
  // this identity-domain route in the standard linked-stacks topology.
  const credentialUseCasesSurfaced = !persona || persona.domain === "identity";

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    const loaders: Promise<CommandItem[]>[] = [];
    if (useCasesSurfaced) {
      loaders.push(
        api.useCases(token).then((rows) =>
          rows.map((u): CommandItem => ({
            id: `uc-${u.key}`, label: u.name, sublabel: u.symbol, kind: "use-case",
            onSelect: () => onSelectNav(u.key),
          })),
        ).catch(() => []),
      );
    }
    if (credentialUseCasesSurfaced) {
      loaders.push(
        api.credentialUseCases(token).then((rows) =>
          rows.map((u): CommandItem => ({
            id: `cuc-${u.key}`, label: u.name, sublabel: u.key, kind: "credential-use-case",
            onSelect: () => onSelectNav("identity"),
          })),
        ).catch(() => []),
      );
    }
    if (useCasesSurfaced) {
      loaders.push(
        api.assets(token).then((rows) =>
          rows.map((a): CommandItem => ({
            id: `asset-${a.id}`, label: a.name, sublabel: a.symbol, kind: "asset",
            onSelect: () => onSelectNav(a.useCaseKey),
          })),
        ).catch(() => []),
      );
    }
    void Promise.all(loaders).then((lists) => { if (!cancelled) setExtra(lists.flat()); });
    return () => { cancelled = true; };
  }, [open, token, useCasesSurfaced, credentialUseCasesSurfaced, onSelectNav]);

  const navAsItems: CommandItem[] = useMemo(
    () => navItems
      .filter((i) => i.id !== "logout")
      .map((i) => ({ id: `nav-${i.id}`, label: i.label, kind: "nav" as const, onSelect: () => onSelectNav(i.id) })),
    [navItems, onSelectNav],
  );

  const allItems = useMemo(() => [...navAsItems, ...extra], [navAsItems, extra]);
  const results = useMemo(() => rankCommandResults(query, allItems), [query, allItems]);
  const shown = query.trim() ? results : navAsItems.slice(0, 8);

  useEffect(() => { setSelected(0); }, [query]);

  function choose(item: CommandItem): void {
    item.onSelect();
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[selected]) choose(shown[selected]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/30 flex items-start justify-center pt-[15vh] p-4 z-50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden animate-fade-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-100">
          <Icon name="filter" className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a use case, asset, or page…"
            className="flex-1 text-sm outline-none placeholder:text-slate-400"
          />
          <kbd className="text-[10px] font-semibold text-slate-400 bg-slate-100 rounded px-1.5 py-0.5">Esc</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto py-1.5">
          {shown.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-slate-400">No matches for "{query}"</div>
          )}
          {shown.map((item, i) => (
            <button
              key={item.id}
              type="button"
              onClick={() => choose(item)}
              onMouseEnter={() => setSelected(i)}
              className={`w-full flex items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors ${
                i === selected ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-50"
              }`}
            >
              <Icon name={KIND_ICON[item.kind]} className={`w-4 h-4 shrink-0 ${i === selected ? "text-brand-500" : "text-slate-400"}`} />
              <span className="truncate">{item.label}</span>
              {item.sublabel && <span className="text-xs text-slate-400 shrink-0">{item.sublabel}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
