import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        sovereign: {
          black: "#000000",
          panel: "#0C0C0F",
          surface: "rgba(20, 20, 26, 0.75)",
          "surface-light": "rgba(255, 255, 255, 0.82)",
          border: "rgba(255, 255, 255, 0.10)",
          "border-light": "rgba(0, 0, 0, 0.10)",
          purple: "#7C3AED",
          "purple-dark": "#581C87",
          "purple-deep": "#6D28D9",
          "purple-light": "#A78BFA",
          "purple-muted": "rgba(124, 58, 237, 0.15)",
          "purple-glow": "rgba(124, 58, 237, 0.35)",
          // Backward alias for teal -> purple transition
          teal: "#7C3AED",
          "teal-muted": "rgba(124, 58, 237, 0.15)",
          gold: "#D4AF37",
          "gold-muted": "rgba(212, 175, 55, 0.15)",
          text: "#F5F5F7",
          "text-light": "#1A1A1E",
          muted: "#86868B",
          red: "#FF453A",
          green: "#30D158",
        },
        aurora: {
          void: "#000000",
          panel: "#0C0C0F",
          surface: "rgba(20, 20, 26, 0.75)",
          border: "rgba(255, 255, 255, 0.10)",
          cyan: "#7C3AED",
          "cyan-glow": "rgba(124, 58, 237, 0.35)",
          violet: "#D4AF37",
          "violet-glow": "rgba(212, 175, 55, 0.20)",
          amber: "#D4AF37",
          text: "#F5F5F7",
          muted: "#86868B",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "-apple-system", "BlinkMacSystemFont", "SF Pro Display", "Inter", "sans-serif"],
        space: ["var(--font-inter)", "-apple-system", "BlinkMacSystemFont", "Inter", "sans-serif"],
        mono: ["var(--font-mono)", "SF Mono", "JetBrains Mono", "monospace"],
      },
      boxShadow: {
        "apple-glass": "0 20px 40px -15px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.08)",
        "apple-glass-light": "0 20px 40px -15px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.06)",
        "purple-glow": "0 0 35px rgba(124, 58, 237, 0.40)",
      },
      backdropBlur: {
        glass: "24px",
      },
    },
  },
  plugins: [],
};

export default config;
