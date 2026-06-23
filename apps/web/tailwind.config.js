/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // XI Tokenize brand palette (from the product deck):
        // primary teal — re-skins every existing `brand-*` usage.
        brand: {
          50: "#e9f9f4",
          100: "#cdeee6",
          400: "#1AC8A9",
          500: "#12b39a",
          600: "#0E8C75",
          700: "#0a6f5d",
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
