// ============================================================
// Web App Manifest — PWA installability + home screen config
// ============================================================
// Next.js 13+ App Router generates /manifest.webmanifest
// from this file automatically and links it in <head>.
// ============================================================

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Chillax Badminton",
    short_name: "Chillax",
    description: "Real-time badminton social queuing and matchmaking",
    start_url: "/clubs",
    scope: "/",
    display: "standalone",
    // "any" allows both portrait and landscape so organizers can rotate their
    // iPad courtside. Players on phones will still default to portrait since
    // that is the natural phone orientation; the app adapts at any rotation.
    orientation: "any",
    background_color: "#1D3A6F",
    theme_color: "#1D3A6F",
    categories: ["sports", "social"],
    icons: [
      // purpose:"any" — standard home screen icon used by all browsers.
      // Firefox on Android requires a PNG with purpose:"any" to render the
      // app icon; it does not support SVG for PWA installs.
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      // purpose:"maskable" — adaptive icon for Android (content within the
      // safe zone allows the OS to apply its own shape mask).
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    // Deep-link shortcuts — long-press the icon on Android/iOS.
    shortcuts: [
      {
        name: "My Clubs",
        short_name: "Clubs",
        description: "Open your clubs, or scan a session QR code",
        url: "/clubs",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
