// ============================================================
// Web App Manifest — PWA installability + home screen config
// ============================================================
// Next.js 13+ App Router generates /manifest.webmanifest
// from this file automatically and links it in <head>.
// ============================================================

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Badminton Queue",
    short_name: "BQ",
    description: "Real-time badminton social queuing and matchmaking",
    start_url: "/play",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#1D3A6F",
    theme_color: "#1D3A6F",
    categories: ["sports", "social"],
    icons: [
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
      {
        src: "/icons/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
    // Deep-link shortcuts — long-press the icon on Android to access directly.
    shortcuts: [
      {
        name: "Join a Session",
        short_name: "Join",
        description: "Scan a QR code or enter a session",
        url: "/play",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Organizer Dashboard",
        short_name: "Organizer",
        description: "Manage courts and matchmaking",
        url: "/organizer",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
  };
}
