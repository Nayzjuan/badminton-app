// ============================================================
// /offline — PWA offline fallback page
// ============================================================
// Shown by the Service Worker when a page navigation fails due
// to no network connection. Precached at build time so it is
// always available even with zero connectivity.
//
// Rules:
//   • Show NO player/match/queue data — stale state is dangerous.
//   • Clear, honest message: real-time features need a connection.
//   • Single CTA: reload the page.
// ============================================================

"use client";

import { WifiOff, RefreshCw } from "lucide-react";

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#1D3A6F] px-6 text-center">
      {/* Icon */}
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-white/10">
        <WifiOff className="h-9 w-9 text-white/70" />
      </div>

      {/* Heading */}
      <h1 className="mb-3 text-2xl font-bold text-white">
        You&rsquo;re offline
      </h1>

      {/* Body */}
      <p className="mb-2 max-w-xs text-sm leading-relaxed text-white/60">
        Badminton Queue uses live matchmaking and real-time court updates — it
        requires an active internet connection to work.
      </p>
      <p className="mb-8 max-w-xs text-sm leading-relaxed text-white/60">
        Check your Wi-Fi or mobile data, then tap below to reload.
      </p>

      {/* CTA */}
      <button
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3
                   text-sm font-semibold text-[#1D3A6F] shadow-lg
                   transition-all active:scale-95 hover:bg-white/90"
      >
        <RefreshCw className="h-4 w-4" />
        Try again
      </button>

      {/* App wordmark */}
      <p className="mt-12 text-xs font-semibold tracking-widest text-white/25 uppercase">
        Badminton Queue
      </p>
    </main>
  );
}
