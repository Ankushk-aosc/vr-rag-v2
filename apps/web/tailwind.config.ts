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
        aurora: {
          void: "#05050A",
          panel: "#0A0A16",
          surface: "rgba(18, 18, 32, 0.70)",
          border: "rgba(0, 240, 255, 0.22)",
          cyan: "#00F0FF",
          "cyan-glow": "rgba(0, 240, 255, 0.45)",
          violet: "#7928CA",
          "violet-glow": "rgba(121, 40, 202, 0.45)",
          amber: "#FFB800",
          text: "#F8FAFC",
          muted: "#8E9AA8",
        },
      },
      fontFamily: {
        space: ["var(--font-space)", "Space Grotesk", "sans-serif"],
        sans: ["var(--font-inter)", "Inter", "sans-serif"],
      },
      boxShadow: {
        "cyan-glow": "0 0 25px rgba(0, 240, 255, 0.28)",
        "violet-glow": "0 0 25px rgba(121, 40, 202, 0.28)",
        glass: "0 8px 32px 0 rgba(0, 0, 0, 0.45)",
      },
      backdropBlur: {
        glass: "16px",
      },
    },
  },
  plugins: [],
};

export default config;
