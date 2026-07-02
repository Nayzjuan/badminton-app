"use client";

// ============================================================
// Clubs hub error boundary — /clubs/*
// ============================================================
// getMyClubs now throws on a real DB/network error instead of returning [] —
// which previously rendered as the legitimate "you are not in any clubs yet"
// empty state, hiding a real member's clubs. This boundary makes that failure
// retryable rather than a misleading empty state.
// ============================================================

import { useEffect } from "react";
import Link from "next/link";

export default function ClubsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[clubs error boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-destructive">
          Could not load your clubs
        </p>
        <h1 className="text-2xl font-black tracking-tight text-foreground">Something went wrong</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          We could not load your clubs just now — this is usually temporary.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={reset}
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:brightness-110"
        >
          Try again
        </button>
        <Link
          href="/play"
          className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
        >
          Back to play
        </Link>
      </div>
    </div>
  );
}
