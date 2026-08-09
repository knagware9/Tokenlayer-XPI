import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev-only: with VITE_API_URL="" the app calls same-origin /api/…, which this
    // proxies to a locally running API — no CORS reconfiguration needed.
    proxy: {
      "/api": { target: process.env.DEV_API_PROXY ?? "http://localhost:4000", changeOrigin: true },
      // EN-D1: the OpenAPI document is served at the API's ROOT, not under
      // /api — the docs plugin in apps/api/src/app.ts is registered outside the
      // /api/v1 prefix. The developer portal's Reference tab fetches it, so in
      // same-origin dev mode it needs proxying too or it lands on Vite's own
      // 404 and the reference renders its "could not be loaded" pane.
      "/openapi.json": { target: process.env.DEV_API_PROXY ?? "http://localhost:4000", changeOrigin: true },
    },
  },
});
