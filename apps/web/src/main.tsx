import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { activePersona } from "./lib/persona.js";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider>
        <App />
      </RouterProvider>
    </AuthProvider>
  </StrictMode>,
);
