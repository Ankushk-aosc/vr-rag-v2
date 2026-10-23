import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aurora Spatial Financial RAG | Australian Family Office",
  description:
    "Voice-first, evidence-grounded financial document knowledge assistant for Australian families with YouTube-style View in VR WebXR spatial computing.",
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
    <html lang="en" className="dark">
      <body className="min-h-screen bg-aurora-void text-aurora-text hud-grid antialiased selection:bg-aurora-cyan selection:text-black">
        {children}
      </body>
    </html>
  );
}
