/**
 * Fitra design system — T-013.
 *
 * Everything the UI uses must come from these tokens. No component may invent a
 * colour, radius, shadow or font step. Palette: warm "paper" surfaces, deep
 * violet-ink text, teal primary (brand), saffron accent (floor / live state /
 * test-deployment badge). Chosen for Arabic-first legibility and for a
 * classroom product that must feel calm, not "AI purple gradient".
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Warm paper surfaces (card / page background).
        paper: {
          DEFAULT: "#FBF7F0",
          raised: "#FFFFFF",
          sunk: "#F3EDE1",
          line: "#E4DACA",
        },
        // Deep violet-ink text scale.
        ink: {
          900: "#16132A",
          800: "#2A2444",
          700: "#3C3560",
          600: "#565080",
          500: "#736C94",
          400: "#9B95AF",
          300: "#C3BFD2",
        },
        // Teal — brand / primary action.
        brand: {
          50: "#E8F4F3",
          100: "#C7E5E3",
          300: "#6FBDB7",
          500: "#17827E",
          600: "#0F6A67",
          700: "#0B4F4D",
          900: "#052E2D",
        },
        // Saffron — live floor, warnings, test-deployment badge.
        saffron: {
          50: "#FDF4E3",
          100: "#FBE7BE",
          300: "#F0BE4C",
          500: "#D99213",
          600: "#B4740A",
          700: "#8A5606",
        },
        // Semantic states.
        success: "#0E7A55",
        danger: {
          50: "#FCEDEB",
          500: "#B42318",
          700: "#7A1811",
        },
        info: "#2A5FA8",
      },
      fontFamily: {
        sans: [
          '"IBM Plex Sans Arabic"',
          '"Noto Sans Arabic"',
          '"Segoe UI"',
          "system-ui",
          "sans-serif",
        ],
        mono: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        xs: "0.25rem",
        sm: "0.375rem",
        md: "0.625rem",
        lg: "1rem",
        xl: "1.375rem",
      },
      boxShadow: {
        soft: "0 1px 2px 0 rgb(22 19 42 / 0.06), 0 1px 3px 0 rgb(22 19 42 / 0.04)",
        lift: "0 2px 4px -1px rgb(22 19 42 / 0.08), 0 12px 28px -8px rgb(22 19 42 / 0.16)",
        focus: "0 0 0 3px rgb(23 130 126 / 0.35)",
        live: "0 0 0 1px rgb(217 146 19 / 0.45), 0 8px 24px -10px rgb(217 146 19 / 0.55)",
      },
      transitionTimingFunction: {
        enter: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
      keyframes: {
        "rise-in": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-live": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
        "sheen": {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
      },
      animation: {
        "rise-in": "rise-in 320ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "pulse-live": "pulse-live 1.4s ease-in-out infinite",
        sheen: "sheen 2.4s linear infinite",
      },
    },
  },
  plugins: [],
};