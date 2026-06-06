"use client";

// ============================================================
// Global Error Boundary — App Router
// ============================================================
// Catches unhandled errors in any route segment and shows a
// recovery UI instead of a blank/broken page.
// Must be a Client Component (Next.js requirement for error.tsx).
// ============================================================

import { useEffect } from "react";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Log to console in development; swap for Sentry/Datadog in production.
    console.error("[GlobalError boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 text-center">
      <div className="space-y-2">
        <p className="font-command text-[9px] uppercase tracking-[0.24em] text-destructive">
          Something went wrong
        </p>
        <h1 className="font-display text-4xl font-bold italic text-foreground">Unexpected Error</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          {error.digest ? `Error ID: ${error.digest}` : "An unexpected error occurred."}
        </p>
      </div>
      <button
        onClick={reset}
        className="clip-cut-sm bg-primary px-6 py-3 font-command text-[10px]
                   uppercase tracking-[0.14em] text-primary-foreground
                   hover:brightness-110 transition-all"
      >
        Try again
      </button>
    </div>
  );
}
