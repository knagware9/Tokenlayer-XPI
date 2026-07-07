import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev-only: with VITE_API_URL="" the app calls same-origin /api/…, which this
    // proxies to a locally running API — no CORS reconfiguration needed.
    proxy: { "/api": { target: process.env.DEV_API_PROXY ?? "http://localhost:4000", changeOrigin: true } },
  },
});
