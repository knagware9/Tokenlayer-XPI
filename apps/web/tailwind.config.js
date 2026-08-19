/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["'Bricolage Grotesque'", "system-ui", "sans-serif"],
        body:    ["'Manrope'",             "system-ui", "sans-serif"],
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
        xiblue: "#0098DB",
        xigreen: "#3FA66B",
        // deep teal-green dark surface (header / hero).
        ink: {
          DEFAULT: "#0E2B26",
          700: "#163a33",
          600: "#33524C",
        },
      },
    },
  },
  plugins: [],
};
