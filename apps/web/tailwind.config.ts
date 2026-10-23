import type { Config } from "tailwindcss";

const config: Config = {
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
          surface: "rgba(20, 20, 24, 0.72)",
          "surface-hover": "rgba(28, 28, 34, 0.85)",
          border: "rgba(255, 255, 255, 0.08)",
          "border-strong": "rgba(255, 255, 255, 0.16)",
          teal: "#00B4A0",
          "teal-muted": "rgba(0, 180, 160, 0.12)",
          gold: "#D4AF37",
          "gold-muted": "rgba(212, 175, 55, 0.12)",
          text: "#F5F5F7",
          muted: "#86868B",
          red: "#FF453A",
          green: "#30D158",
        },
        // Refined Sovereign tokens mapped for backward compatibility
        aurora: {
          void: "#000000",
          panel: "#0C0C0F",
          surface: "rgba(20, 20, 24, 0.72)",
          border: "rgba(255, 255, 255, 0.08)",
          cyan: "#00B4A0",
          "cyan-glow": "rgba(0, 180, 160, 0.20)",
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
        "apple-card": "0 10px 30px -10px rgba(0, 0, 0, 0.6)",
        "apple-sheet": "0 30px 60px -12px rgba(0, 0, 0, 0.8)",
      },
      backdropBlur: {
        glass: "24px",
      },
    },
  },
  plugins: [],
};

export default config;
