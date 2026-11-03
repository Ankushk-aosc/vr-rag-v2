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
  title: "Aether Sovereign | Spatial Financial Pavilion",
  description:
    "Aether Sovereign: Sovereign voice-first spatial financial intelligence pavilion for Australian family offices with stereoscopic VR WebXR spatial computing.",
  icons: {
    icon: "/icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-black text-[#F5F5F7] antialiased selection:bg-[#00B4A0] selection:text-black">
        {children}
      </body>
    </html>
  );
}
