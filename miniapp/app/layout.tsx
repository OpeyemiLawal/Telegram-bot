import type { Metadata, Viewport } from "next";
import Script from "next/script";

import { AuthProvider } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Solana Games",
  description: "One wallet. Every game.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0b1620",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // Telegram's script writes --tg-theme-* custom properties onto <html>
    // before React hydrates, so the server and client markup will never
    // match on this element. The warning is noise, not a real mismatch.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Must load before any app code — `window.Telegram.WebApp` has to
          exist by the time the auth provider mounts and reads initData.
        */}
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
