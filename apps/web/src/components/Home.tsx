import { useRoute } from "../router.js";
import { Logo } from "./Logo.js";
import { Icon, type IconName } from "./ui.js";

const STEPS: { icon: IconName; title: string; text: string }[] = [
  { icon: "users", title: "Onboard", text: "Register your company and get a custodial DID plus a verifiable organization credential — after a platform review." },
  { icon: "code", title: "Configure", text: "Define your use case low-code: token standard, compliance rules, fees and maker-checker governance." },
  { icon: "coins", title: "Tokenize", text: "Issue and manage real-world assets on EVM, Fabric or Canton from one console." },
];

export function Home(): JSX.Element {
  const { navigate } = useRoute();

  return (
    <div className="min-h-screen bg-[#EFF8F4] flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-200/70 bg-white/70 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Logo size={30} />
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate("/login")}
              className="rounded-lg border border-slate-200 text-slate-700 px-4 py-2 text-sm font-medium hover:bg-slate-50 transition-colors"
            >
              Login
            </button>
            <button
              onClick={() => navigate("/signup")}
              className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 transition-colors"
            >
              Register your company
            </button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1">
        <section className="max-w-6xl mx-auto px-6 pt-20 pb-16 text-center">
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-ink leading-tight max-w-3xl mx-auto">
            Tokenize real-world assets, on any ledger.
          </h1>
          <p className="mt-6 text-lg text-slate-600 max-w-2xl mx-auto">
            Chain-agnostic tokenization with on-chain identity, verifiable credentials and
            maker-checker governance — issue and manage assets on EVM, Fabric and Canton from one console.
          </p>
          <div className="mt-9 flex items-center justify-center gap-3">
            <button
              onClick={() => navigate("/signup")}
              className="rounded-lg bg-brand-600 text-white px-6 py-3 text-sm font-semibold hover:bg-brand-700 transition-colors"
            >
              Register your company
            </button>
            <button
              onClick={() => navigate("/login")}
              className="rounded-lg border border-slate-300 bg-white text-slate-700 px-6 py-3 text-sm font-semibold hover:bg-slate-50 transition-colors"
            >
              Login
            </button>
          </div>
        </section>

        {/* How it works */}
        <section className="max-w-6xl mx-auto px-6 pb-24">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {STEPS.map((s, i) => (
              <div key={s.title} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
                <div className="flex items-center gap-3">
                  <div className="shrink-0 w-10 h-10 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
                    <Icon name={s.icon} className="w-5 h-5" />
                  </div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    Step {i + 1}
                  </div>
                </div>
                <h3 className="mt-4 text-base font-semibold text-slate-900">{s.title}</h3>
                <p className="mt-1.5 text-sm text-slate-500">{s.text}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
