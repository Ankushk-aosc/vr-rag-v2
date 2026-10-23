import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Sovereign Pavilion | Australian Family Financial Office",
  description:
    "Apple-grade voice-first financial document knowledge assistant for Australian family offices with YouTube-style View in VR WebXR spatial computing.",
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
