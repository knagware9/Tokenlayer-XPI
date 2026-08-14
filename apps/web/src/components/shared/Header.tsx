import { useAuth } from "../../auth.js";
import { useRoute } from "../../router.js";
import { Logo } from "./Logo.js";

export function Header(): JSX.Element {
  const { user, logout } = useAuth();
  const { useCaseKey, navigate } = useRoute();
  const isPlatform = user?.role === "PlatformAdmin";
  const scope = isPlatform ? (useCaseKey || "Platform") : (user?.useCaseKey ?? "");
  return (
    <header className="bg-ink border-b border-ink-700">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3.5">
          <button
            onClick={() => isPlatform && navigate("/")}
            className={`flex items-center rounded-lg ${isPlatform ? "cursor-pointer" : "cursor-default"}`}
            aria-label="Home"
          >
            <Logo onDark size={30} />
          </button>
          {scope && (
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium text-brand-400 bg-brand-400/10 border border-brand-400/25 rounded-full px-2.5 py-1 whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-400" aria-hidden="true" />
              {scope}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right leading-tight">
            <div className="text-xs font-medium text-slate-100">{user?.email}</div>
            <div className="text-[11px] text-brand-400 font-semibold mt-0.5">{user?.role}</div>
          </div>
          <button
            onClick={() => { navigate("/"); logout(); }}
            className="text-xs font-medium text-slate-200 hover:text-white border border-white/20 hover:border-white/40 hover:bg-white/5 rounded-lg px-3 py-1.5 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
