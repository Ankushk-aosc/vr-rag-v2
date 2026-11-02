import type { Metadata, Viewport } from "next";
import "./globals.css";

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
    <html lang="en" className="dark">
      <body className="min-h-screen bg-black text-[#F5F5F7] antialiased selection:bg-[#00B4A0] selection:text-black">
        {children}
      </body>
    </html>
  );
}
