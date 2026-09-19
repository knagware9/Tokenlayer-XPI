/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["'Inter'", "system-ui", "sans-serif"],
        body:    ["'Inter'", "system-ui", "sans-serif"],
        data:    ["'JetBrains Mono'",      "'Fira Code'", "ui-monospace", "monospace"],
      },
      colors: {
        // EN-E: each stop reads a CSS custom property so an organization's
        // shell can override the palette without a single component changing.
        // `<alpha-value>` keeps Tailwind's `/50` opacity modifiers working,
        // which is why the variables hold "r g b" and not "#rrggbb".
        brand: {
          50: "rgb(var(--brand-50) / <alpha-value>)",
          100: "rgb(var(--brand-100) / <alpha-value>)",
          400: "rgb(var(--brand-400) / <alpha-value>)",
          500: "rgb(var(--brand-500) / <alpha-value>)",
          600: "rgb(var(--brand-600) / <alpha-value>)",
          700: "rgb(var(--brand-700) / <alpha-value>)",
        },
        // Semantic layer — same `rgb(var(--x) / <alpha-value>)` convention as
        // `brand`, so a hand-written CSS rule and a `bg-surface` utility read
        // the identical value. Defined in index.css under `:root`, redefined
        // for dark under both the OS media query and an explicit toggle.
        bg:       "rgb(var(--bg) / <alpha-value>)",
        surface:  "rgb(var(--surface) / <alpha-value>)",
        elevated: "rgb(var(--elevated) / <alpha-value>)",
        border:   "rgb(var(--border) / <alpha-value>)",
        fg:       "rgb(var(--fg) / <alpha-value>)",
        muted:    "rgb(var(--muted) / <alpha-value>)",
        primary:  "rgb(var(--primary) / <alpha-value>)",
        danger:   "rgb(var(--danger) / <alpha-value>)",
        warning:  "rgb(var(--warning) / <alpha-value>)",
        success:  "rgb(var(--success) / <alpha-value>)",
        xiblue: "#0098DB",
        xigreen: "#3FA66B",
        // deep teal-green dark surface (header / hero).
        ink: {
          DEFAULT: "#0E2B26",
          700: "#163a33",
          600: "#33524C",
        },
      },
      boxShadow: {
        // One soft elevation level — never stack a second shadow on top of it.
        card: "0 1px 2px rgb(15 23 42 / 0.04)",
      },
    },
  },
  plugins: [],
};
