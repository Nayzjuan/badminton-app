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
    start_url: "/play",
    scope: "/",
    display: "standalone",
    // Orientation is intentionally OMITTED so the installed PWA follows the
    // device's own rotation setting: it stays put when the user has their OS
    // rotation lock ON, and rotates freely when it's OFF. Declaring
    // `orientation: "any"` here would OVERRIDE the system rotation lock on
    // Android (the app rotated even with portrait-lock engaged). Omitting it
    // still lets organizers use landscape on an iPad/phone with rotation
    // unlocked — the UI is fully responsive at any orientation either way.
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
        name: "Play",
        short_name: "Play",
        description: "Open your sessions, or scan a session QR code",
        url: "/play",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
