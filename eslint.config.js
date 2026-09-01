// @ts-check
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Repo-wide lint. Deliberately narrow on day one — this codebase has never
 * been linted, so `recommended` presets applied wholesale would surface
 * thousands of pre-existing, non-bug findings and make the first CI run
 * useless. Scope grows from here; the two react-hooks rules below are not
 * negotiable — the Holder-dashboard hooks-order crash this config exists to
 * catch (React error #310, a full white-screen) shipped and was only found
 * by hand during live verification. TypeScript's own compiler has no
 * opinion on React's hooks rules; only this plugin does.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.vite/**",
      "**/generated/**",
      "**/coverage/**",
      "**/*.d.ts",
      "packages/contracts/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // A codebase-wide first pass: real bugs first, style debt later.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // The stable, load-bearing pair — not the plugin's newer React
      // Compiler-oriented rule set (purity, immutability, set-state-in-render,
      // …), which is tuned for compiler readiness and would need its own
      // pass to adopt deliberately rather than arrive as a side effect of
      // "add linting."
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
