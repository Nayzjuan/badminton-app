"use client";

// ============================================================
// Club route error boundary — /c/[clubSlug]/*
// ============================================================
// Catches transient failures thrown by the club data layer. The clubs.ts read
// helpers now THROW on a real DB/network error (instead of coalescing to
// null/[]/false, which used to masquerade as "not a member" / "no clubs" / 404).
// This boundary turns those into a retryable surface. `reset()` re-runs the
// segment's server render, which re-issues the reads — resolving a blip.
//
// Catches errors from the (app)/(full) group layouts + their pages. Errors in
// the root [clubSlug]/layout itself bubble to the app-level error boundary.
// ============================================================

import { useEffect } from "react";
import Link from "next/link";

export default function ClubError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[club error boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-destructive">
          Could not load this club
        </p>
        <h1 className="text-2xl font-black tracking-tight text-foreground">Something went wrong</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          This is usually temporary. Try again — if it keeps happening, head back to your clubs.
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
          href="/clubs"
          className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
        >
          All clubs
        </Link>
      </div>
    </div>
  );
}
