import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AuthProvider } from "./auth.js";
import { RouterProvider } from "./router.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider>
        <App />
      </RouterProvider>
    </AuthProvider>
  </StrictMode>,
);
