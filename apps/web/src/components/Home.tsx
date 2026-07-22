import { useRoute } from "../router.js";
import { Logo, LogoMark } from "./Logo.js";
import { Icon, type IconName } from "./ui.js";

// Landing-page copy is drawn from the XI Tokenize product deck
// (XPI Quantum Technologies Pvt Ltd): no-code tokenization infrastructure for
// real-world assets — interface-driven, cross-chain, compliance-ready.

const STATS: { value: string; label: string }[] = [
  { value: "5", label: "Token standards" },
  { value: "3+", label: "KYC partners" },
  { value: "∞", label: "Issuance chains" },
  { value: "0", label: "Lines of code" },
];

const CHALLENGES: { icon: IconName; title: string; text: string }[] = [
  { icon: "code", title: "Months to build", text: "Issuers engineer smart contracts, KYC pipelines and compliance logic from scratch for every single asset." },
  { icon: "chain", title: "Vendor lock-in", text: "Hard-coded KYC and blockchain integrations trap issuers to one provider and one chain." },
  { icon: "shield", title: "Fragmented compliance", text: "KYC and Travel Rule rules differ by jurisdiction and asset class, with no plug-and-play way to adapt." },
  { icon: "doc", title: "Illiquid, paper-based assets", text: "Gold, silver, invoices, loans and real estate stay locked in paper records — untraded and untokenized." },
];

const PILLARS: { icon: IconName; title: string; text: string }[] = [
  { icon: "spark", title: "No-code studio", text: "Configure asset terms, compliance rules and issuance flow through guided screens — go live in days, not months." },
  { icon: "chain", title: "Interface-oriented core", text: "Every dependency — KYC, Travel Rule, issuance chain — is a swappable plug-in, never hard-coded." },
  { icon: "globe", title: "Cross-chain by design", text: "Move tokenized assets across blockchains without re-engineering the asset or its compliance wrapper." },
  { icon: "coins", title: "Any asset class", text: "From bullion to invoices — one platform spans physical commodities and financial instruments alike." },
];

const STEPS: { icon: IconName; title: string; text: string }[] = [
  { icon: "users", title: "Onboard", text: "Register your company and receive a custodial DID plus a verifiable organization credential — after a platform review." },
  { icon: "code", title: "Configure", text: "Design your use case low-code: token standard, compliance rules, fees and maker-checker governance." },
  { icon: "coins", title: "Tokenize", text: "Issue and manage real-world assets across EVM, Fabric and Canton from a single console." },
];

const STANDARDS: { code: string; name: string; text: string }[] = [
  { code: "ERC-20", name: "Fungible tokens", text: "Fractional, pooled ownership of an asset class — ideal for bullion or receivables pools." },
  { code: "ERC-721", name: "Unique NFTs", text: "One-of-a-kind titles — a single gold bar, a single property or invoice." },
  { code: "ERC-1155", name: "Multi-token", text: "Batch-issue mixed fungible and non-fungible assets in one contract." },
  { code: "ERC-3643", name: "Permissioned securities", text: "On-chain identity and transfer-restriction logic for regulated security tokens (T-REX)." },
  { code: "ERC-7943", name: "Universal RWA", text: "Emerging interoperable standard for real-world assets across chains (uRWA)." },
];

const ASSETS: { icon: IconName; title: string; text: string }[] = [
  { icon: "coins", title: "Gold", text: "Bullion and vaulted gold reserves, fractionalised for retail and institutional access." },
  { icon: "coins", title: "Silver", text: "Precious-metal holdings issued as digital, tradeable tokens." },
  { icon: "globe", title: "Real estate & more", text: "Property and other tangible assets, onboarded through the same no-code flow." },
  { icon: "doc", title: "Invoices", text: "Trade receivables tokenized for early liquidity and investor access." },
  { icon: "arrow", title: "Loans", text: "Loan books and debt instruments represented on-chain for transfer and settlement." },
  { icon: "spark", title: "Funds & more", text: "Structured funds and other regulated instruments — extendable to new classes." },
];

const KYC_PARTNERS: { name: string; text: string }[] = [
  { name: "Sumsub", text: "Global identity verification and AML screening" },
  { name: "IDfy", text: "India-focused KYC, AML and background checks" },
  { name: "Digio", text: "Digital KYC, eSign and onboarding workflows" },
];

function SectionTag({ children }: { children: string }): JSX.Element {
  return (
    <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-600">
      <span className="w-5 h-px bg-brand-400" aria-hidden="true" />
      {children}
    </div>
  );
}

export function Home(): JSX.Element {
  const { navigate } = useRoute();

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ink/95 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Logo onDark size={30} />
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate("/login")}
              className="rounded-lg border border-white/20 text-slate-100 px-4 py-2 text-sm font-medium hover:bg-white/10 transition-colors"
            >
              Login
            </button>
            <button
              onClick={() => navigate("/signup")}
              className="rounded-lg bg-brand-500 text-white px-4 py-2 text-sm font-medium hover:bg-brand-400 transition-colors"
            >
              Register your company
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section
          className="relative overflow-hidden bg-ink text-white"
          style={{ backgroundImage: "radial-gradient(60% 80% at 78% 12%, rgba(26,200,169,0.20), transparent 60%), radial-gradient(50% 70% at 10% 90%, rgba(0,152,219,0.16), transparent 60%)" }}
        >
          <div className="max-w-6xl mx-auto px-6 pt-20 pb-24 text-center">
            <div className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs font-medium text-brand-100">
              <span>Interface-Driven</span><span className="text-white/30">·</span>
              <span>Cross-Chain</span><span className="text-white/30">·</span>
              <span>Compliance-Ready</span>
            </div>
            <h1 className="mt-7 text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.05] max-w-4xl mx-auto">
              No-code tokenization infrastructure for{" "}
              <span className="bg-gradient-to-r from-xiblue via-brand-400 to-xigreen bg-clip-text text-transparent">real-world assets</span>
            </h1>
            <p className="mt-6 text-lg text-slate-300 max-w-2xl mx-auto">
              Launch, manage and move real-world assets on-chain — without writing a single line of
              smart-contract code. Pluggable KYC and Travel Rule, cross-chain by design, any asset class.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => navigate("/signup")}
                className="rounded-lg bg-brand-500 text-white px-6 py-3 text-sm font-semibold hover:bg-brand-400 transition-colors"
              >
                Register your company
              </button>
              <button
                onClick={() => navigate("/login")}
                className="rounded-lg border border-white/25 bg-white/5 text-white px-6 py-3 text-sm font-semibold hover:bg-white/10 transition-colors"
              >
                Login
              </button>
            </div>
            <p className="mt-8 text-sm text-slate-400 max-w-xl mx-auto">
              <span className="font-semibold text-white">$326T</span> in global real-world assets remain untokenized today —
              XI Tokenize removes the engineering barrier to unlocking them.
            </p>
          </div>

          {/* Stat band */}
          <div className="border-t border-white/10 bg-black/15">
            <div className="max-w-6xl mx-auto px-6 py-8 grid grid-cols-2 md:grid-cols-4 gap-6">
              {STATS.map((s) => (
                <div key={s.label} className="text-center">
                  <div className="text-3xl sm:text-4xl font-extrabold tracking-tight bg-gradient-to-r from-brand-400 to-xiblue bg-clip-text text-transparent">
                    {s.value}
                  </div>
                  <div className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-400">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* The challenge */}
        <section className="max-w-6xl mx-auto px-6 pt-20 pb-8">
          <div className="max-w-2xl">
            <SectionTag>The challenge</SectionTag>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-ink">
              Real-world assets are still trapped in paper, silos and hard-coded infrastructure
            </h2>
          </div>
          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-5">
            {CHALLENGES.map((c) => (
              <div key={c.title} className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-6">
                <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 text-slate-500 flex items-center justify-center">
                  <Icon name={c.icon} className="w-5 h-5" />
                </div>
                <h3 className="mt-4 text-base font-semibold text-slate-900">{c.title}</h3>
                <p className="mt-1.5 text-sm text-slate-500 leading-relaxed">{c.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* The solution */}
        <section className="max-w-6xl mx-auto px-6 pt-16 pb-8">
          <div className="max-w-2xl">
            <SectionTag>The solution</SectionTag>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-ink">Introducing XI Tokenize</h2>
            <p className="mt-3 text-slate-600">
              A no-code tokenization studio that lets issuers launch, manage and move real-world assets
              on-chain — without engineering smart contracts, KYC pipelines or compliance logic from scratch.
            </p>
          </div>
          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {PILLARS.map((p) => (
              <div key={p.title} className="rounded-2xl border border-slate-200/80 bg-white shadow-sm p-6">
                <div className="w-10 h-10 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
                  <Icon name={p.icon} className="w-5 h-5" />
                </div>
                <h3 className="mt-4 text-base font-semibold text-slate-900">{p.title}</h3>
                <p className="mt-1.5 text-sm text-slate-500 leading-relaxed">{p.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="max-w-6xl mx-auto px-6 pt-16 pb-8">
          <div className="max-w-2xl">
            <SectionTag>How it works</SectionTag>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-ink">From registration to live issuance in days</h2>
          </div>
          <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-5">
            {STEPS.map((s, i) => (
              <div key={s.title} className="relative rounded-2xl border border-slate-200/80 bg-white shadow-sm p-6">
                <div className="flex items-center gap-3">
                  <div className="shrink-0 w-10 h-10 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
                    <Icon name={s.icon} className="w-5 h-5" />
                  </div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Step {i + 1}</div>
                </div>
                <h3 className="mt-4 text-base font-semibold text-slate-900">{s.title}</h3>
                <p className="mt-1.5 text-sm text-slate-500 leading-relaxed">{s.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Token standards */}
        <section className="max-w-6xl mx-auto px-6 pt-16 pb-8">
          <div className="max-w-2xl">
            <SectionTag>Technical foundation</SectionTag>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-ink">Multi-standard token support</h2>
            <p className="mt-3 text-slate-600">Choose the right standard per asset, or mix several in one issuance.</p>
          </div>
          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {STANDARDS.map((s) => (
              <div key={s.code} className="rounded-2xl border border-slate-200/80 bg-white shadow-sm p-6">
                <div className="inline-flex items-center rounded-md bg-ink px-2.5 py-1 text-xs font-bold tracking-wide text-brand-400">
                  {s.code}
                </div>
                <h3 className="mt-3 text-base font-semibold text-slate-900">{s.name}</h3>
                <p className="mt-1.5 text-sm text-slate-500 leading-relaxed">{s.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Asset coverage */}
        <section className="max-w-6xl mx-auto px-6 pt-16 pb-8">
          <div className="max-w-2xl">
            <SectionTag>Coverage</SectionTag>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-ink">One platform, every asset class</h2>
            <p className="mt-3 text-slate-600">From physical commodities to financial instruments — asset-class agnostic by design.</p>
          </div>
          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {ASSETS.map((a) => (
              <div key={a.title} className="flex gap-4 rounded-2xl border border-slate-200/80 bg-slate-50/60 p-6">
                <div className="shrink-0 w-10 h-10 rounded-xl bg-white border border-slate-200 text-brand-600 flex items-center justify-center">
                  <Icon name={a.icon} className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-900">{a.title}</h3>
                  <p className="mt-1 text-sm text-slate-500 leading-relaxed">{a.text}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Compliance layer */}
        <section className="max-w-6xl mx-auto px-6 pt-16 pb-20">
          <div className="rounded-3xl border border-slate-200/80 bg-ink text-white overflow-hidden">
            <div className="grid lg:grid-cols-2 gap-10 p-8 sm:p-10">
              <div>
                <SectionTag>Compliance layer</SectionTag>
                <h2 className="mt-3 text-3xl font-extrabold tracking-tight">Choose your own compliance stack</h2>
                <p className="mt-3 text-slate-300">
                  KYC and Travel Rule are interface-bound, not hard-wired. Select the provider that fits your
                  jurisdiction, asset class and risk policy — and switch without touching core logic.
                </p>
                <ul className="mt-6 space-y-3">
                  {[
                    "Plug in any KYC provider through a standard adapter interface",
                    "Configure any FATF-aligned Travel Rule provider per corridor",
                    "Jurisdiction-aware rules applied automatically at issuance and transfer",
                  ].map((t) => (
                    <li key={t} className="flex gap-3 text-sm text-slate-200">
                      <Icon name="check" className="w-5 h-5 shrink-0 text-brand-400" />
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-400">KYC partner ecosystem</div>
                <div className="mt-4 space-y-3">
                  {KYC_PARTNERS.map((k) => (
                    <div key={k.name} className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                      <div className="shrink-0 w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center">
                        <Icon name="shield" className="w-5 h-5 text-brand-400" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white">{k.name}</div>
                        <div className="text-xs text-slate-400">{k.text}</div>
                      </div>
                    </div>
                  ))}
                  <div className="rounded-xl border border-dashed border-white/15 px-4 py-3 text-xs text-slate-400">
                    + more — any provider, onboarded through the same interface
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="max-w-6xl mx-auto px-6 pb-20">
          <div
            className="rounded-3xl bg-ink text-white text-center px-6 py-16 overflow-hidden relative"
            style={{ backgroundImage: "radial-gradient(50% 90% at 50% 0%, rgba(26,200,169,0.22), transparent 60%)" }}
          >
            <div className="flex justify-center"><LogoMark size={44} /></div>
            <h2 className="mt-6 text-3xl sm:text-4xl font-extrabold tracking-tight">Tokenize any asset. Any chain. No code.</h2>
            <p className="mt-3 text-slate-300 max-w-xl mx-auto">
              Register your company to start configuring compliant, cross-chain real-world asset issuance.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => navigate("/signup")}
                className="rounded-lg bg-brand-500 text-white px-6 py-3 text-sm font-semibold hover:bg-brand-400 transition-colors"
              >
                Register your company
              </button>
              <button
                onClick={() => navigate("/login")}
                className="rounded-lg border border-white/25 bg-white/5 text-white px-6 py-3 text-sm font-semibold hover:bg-white/10 transition-colors"
              >
                Login
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <Logo size={26} />
          <div className="text-xs text-slate-500 text-center sm:text-right">
            <div>A product by XPI Quantum Technologies Pvt Ltd · 2026</div>
            <div className="mt-0.5">GIFT City · IFSCA Regulatory Sandbox</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
