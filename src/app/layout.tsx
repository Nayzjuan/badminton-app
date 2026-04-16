import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

// Space Grotesk: geometric, slightly editorial — fits a fast-paced sports context
// better than neutral Inter while staying completely legible.
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "Badminton Queue",
  description: "Real-time badminton social queuing and matchmaking",
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
      <body className={`${spaceGrotesk.className} antialiased`}>
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
        </ThemeProvider>
      </body>
    </html>
  );
}
