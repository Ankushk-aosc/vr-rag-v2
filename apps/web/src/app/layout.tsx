import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// next/font downloads these at build time and serves them from this app, so visitors' browsers never
// contact Google Fonts (Audit I-26). Exposed as CSS variables consumed by globals.css.
const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  variable: "--font-inter-self",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono-self",
});

export const metadata: Metadata = {
  title: "Aether Sovereign — Family Office Financial Intelligence",
  description:
    "Evidence-grounded financial intelligence for Australian family offices, with optional spatial and VR views.",
  icons: {
    icon: "/icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // Light by default; page.tsx applies the saved theme by toggling `dark` / `light` on <html>.
    <html lang="en" className={`light ${inter.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen antialiased selection:bg-blue-200 selection:text-slate-900">
        {children}
      </body>
    </html>
  );
}
