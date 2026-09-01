import * as Sentry from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { activePersona } from "./lib/shared/persona.js";
import { scrubEvent } from "./lib/shared/pii-scrub.js";
import { App } from "./App.js";
import { AuthProvider } from "./auth.js";
import { RouterProvider } from "./router.js";
import "./index.css";

// THE TAB'S NAME. Someone running several of these apps side by side otherwise
// has six tabs all reading "XI Tokenize" — the three identity ones included.
// Set once at boot; a build with no persona keeps the title from index.html.
const persona = activePersona();
if (persona) {
  document.title = `${persona.domain === "identity" ? "XI Identity" : "XI Tokenize"} · ${persona.label}`;
}

// Pilot-scale error tracking: a total no-op unless VITE_SENTRY_DSN is set at
// build time. No performance tracing or session replay — this is error
// tracking only. `sendDefaultPii: false` (the default) plus `scrubEvent` are
// belt-and-suspenders: this platform carries KYC/identity data that must
// never leave the browser toward a third-party SaaS, even inside an error
// report.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? import.meta.env.MODE,
    integrations: [],
    beforeSend: (event) => scrubEvent(event),
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider>
        <App />
      </RouterProvider>
    </AuthProvider>
  </StrictMode>,
);
