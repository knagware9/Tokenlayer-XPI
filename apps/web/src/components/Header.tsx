import { useAuth } from "../auth.js";
import { useRoute } from "../router.js";
import { Logo } from "./Logo.js";

export function Header(): JSX.Element {
  const { user, logout } = useAuth();
  const { useCaseKey, navigate } = useRoute();
  const isPlatform = user?.role === "PlatformAdmin";
  const scope = isPlatform ? (useCaseKey || "Platform") : (user?.useCaseKey ?? "");
  return (
    <header className="bg-ink border-b border-ink-700">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => isPlatform && navigate("/")} className={isPlatform ? "cursor-pointer" : "cursor-default"} aria-label="Home">
            <Logo onDark size={30} />
          </button>
          {scope && <span className="hidden sm:inline-block text-[11px] text-brand-400 font-medium border border-brand-400/30 rounded-full px-2 py-0.5">{scope}</span>}
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-xs font-medium text-slate-100">{user?.email}</div>
            <div className="text-[11px] text-brand-400 font-semibold">{user?.role}</div>
          </div>
          <button onClick={logout} className="text-xs text-slate-200 hover:text-white border border-white/20 hover:border-white/40 rounded-lg px-3 py-1.5">Sign out</button>
        </div>
      </div>
    </header>
  );
}
