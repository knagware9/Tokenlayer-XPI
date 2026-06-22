import { useAuth } from "../auth.js";

export function Header(): JSX.Element {
  const { user, logout } = useAuth();
  const scope = user?.role === "PlatformAdmin" ? "Platform" : (user?.useCaseKey ?? "");
  return (
    <header className="bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-brand-600 flex items-center justify-center text-white font-bold">T</div>
          <div>
            <div className="font-semibold text-slate-900 leading-tight">TokenLayer</div>
            {scope && <div className="text-[11px] text-slate-400 leading-tight">{scope}</div>}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-xs font-medium text-slate-700">{user?.email}</div>
            <div className="text-[11px] text-brand-600 font-semibold">{user?.role}</div>
          </div>
          <button onClick={logout} className="text-xs text-slate-500 hover:text-slate-800 border border-slate-200 rounded-lg px-3 py-1.5">Sign out</button>
        </div>
      </div>
    </header>
  );
}
