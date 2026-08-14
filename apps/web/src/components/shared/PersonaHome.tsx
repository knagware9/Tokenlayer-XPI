/**
 * THE FRONT DOOR OF ONE PERSONA'S APP.
 *
 * Replaces the shared marketing homepage on a persona build. Every container was
 * serving the same tokenization pitch — including the three identity ones — so a
 * citizen opening their credential wallet read about cross-chain asset issuance,
 * and nothing named which of the six apps they had reached.
 *
 * The page says three things, in this order, because that is the order the
 * questions arrive in: which PRODUCT, which APP, and what you do here.
 */
import type { JSX } from "react";
import { useRoute } from "../../router.js";
import { Logo } from "./Logo.js";
import { activePersona } from "../../lib/persona.js";
import { landingFor } from "../../lib/persona-landing.js";

export function PersonaHome(): JSX.Element | null {
  const { navigate } = useRoute();
  const persona = activePersona();
  const copy = landingFor(persona);
  // Null means this build is the full application — App.tsx renders <Home/>.
  if (!persona || !copy) return null;

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-ink/95 backdrop-blur">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Logo onDark size={30} />
            {/* The persona's own name, beside the product mark. Someone with
                several of these open needs to tell the tabs apart. */}
            <span className="hidden sm:inline text-white/30" aria-hidden="true">/</span>
            <span className="hidden sm:inline text-sm text-white/70 truncate">{copy.product} · {persona.label}</span>
          </div>
          <div className="flex items-center gap-2">
            {persona.domain === "identity" && (
              <button onClick={() => navigate("verify")}
                className="text-sm text-white/70 hover:text-white px-3 py-1.5 rounded-lg transition-colors">
                Verify a credential
              </button>
            )}
            <button onClick={() => navigate("login")}
              className="text-sm text-white bg-white/10 hover:bg-white/20 px-4 py-1.5 rounded-lg transition-colors">
              Login
            </button>
            {copy.publicSignup && (
              <button onClick={() => navigate("signup")}
                className="text-sm font-medium text-ink bg-brand-400 hover:bg-brand-300 px-4 py-1.5 rounded-lg transition-colors">
                Register your organization
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 bg-ink text-white">
        <div className="max-w-5xl mx-auto px-6 py-20 sm:py-28">
          <p className="text-sm font-medium tracking-wide text-brand-300 uppercase">{copy.product}</p>
          <h1 className="mt-3 text-4xl sm:text-5xl font-semibold tracking-tight max-w-3xl">{copy.headline}</h1>
          <p className="mt-6 text-lg text-white/70 max-w-2xl leading-relaxed">{copy.blurb}</p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <button onClick={() => navigate("login")}
              className="text-sm font-medium text-ink bg-brand-400 hover:bg-brand-300 px-5 py-2.5 rounded-lg transition-colors">
              {copy.cta}
            </button>
            {copy.publicSignup && (
              <button onClick={() => navigate("signup")}
                className="text-sm text-white bg-white/10 hover:bg-white/20 px-5 py-2.5 rounded-lg transition-colors">
                Register your organization
              </button>
            )}
          </div>

          <div className="mt-16 border-t border-white/10 pt-10">
            <h2 className="text-sm font-medium tracking-wide text-white/50 uppercase">What you do here</h2>
            <ul className="mt-6 grid gap-6 sm:grid-cols-3">
              {copy.does.map((line, i) => (
                <li key={line} className="text-sm text-white/80 leading-relaxed">
                  <span className="block text-brand-300 font-mono text-xs mb-2">{String(i + 1).padStart(2, "0")}</span>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </main>

      <footer className="bg-ink border-t border-white/10">
        <div className="max-w-5xl mx-auto px-6 py-6 text-xs text-white/40">
          {copy.product} · {persona.label}
          <span className="mx-2 text-white/20">·</span>
          one of six audience applications; this one serves {persona.domain === "identity" ? "digital identity" : "tokenization"} only
        </div>
      </footer>
    </div>
  );
}
