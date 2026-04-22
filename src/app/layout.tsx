import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { SerwistRegister } from "@/components/serwist-register";
import { PwaNavBar } from "@/components/pwa-nav-bar";
import "./globals.css";

// Space Grotesk: geometric, slightly editorial — fits a fast-paced sports context
// better than neutral Inter while staying completely legible.
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "Badminton Queue",
  description: "Real-time badminton social queuing and matchmaking",
  // ── PWA / Apple home screen ──────────────────────────────────
  appleWebApp: {
    capable: true,
    title: "Badminton Queue",
    // black-translucent: the status bar overlays the app content,
    // letting our navy header bleed all the way to the top edge on iOS.
    statusBarStyle: "black-translucent",
  },
  icons: {
    // Standard browser favicon
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon.svg", type: "image/svg+xml" },
    ],
    // iOS "Add to Home Screen" icon — must be PNG, 180×180
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  // Tells browsers this is a PWA-capable page
  applicationName: "Badminton Queue",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#1D3A6F" },
    { media: "(prefers-color-scheme: dark)",  color: "#120826" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning prevents React from warning about the
    // class/style mismatch next-themes causes on the <html> element
    // between SSR and the first client render.
    <html lang="en" suppressHydrationWarning>
      <body className={`${spaceGrotesk.className} antialiased pb-12`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
          {/* Sonner toast portal — renders above all page content. */}
          <Toaster
            position="top-center"
            richColors
            closeButton
            toastOptions={{
              // Baseline duration; individual toasts can override.
              duration: 5_000,
              classNames: {
                toast: "font-sans text-sm",
              },
            }}
          />
          {/*
            PWA URL bar — fixed to the bottom of the screen.
            In standalone mode (installed PWA) the browser's native URL
            bar is hidden; this restores URL visibility and editability.
            The pb-12 on <body> above ensures content is never obscured.
          */}
          <PwaNavBar />
        </ThemeProvider>

        {/*
          Service Worker registration.
          – Runs only in the browser (client component).
          – NEXT_PUBLIC_KILL_SW=true in Vercel env vars instantly
            unregisters any active SW on next page load — emergency
            escape hatch if a bad SW ships to production.
        */}
        <SerwistRegister />
      </body>
    </html>
  );
}
