"use client";

// ============================================================
// GoogleSignInButton — "Continue with Google"
// ============================================================
// Dark by default: renders nothing unless NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED
// === "true". Starts the PKCE redirect via the signInWithGoogle action and
// navigates the browser to the returned provider URL.
// ============================================================

import { useState, useTransition } from "react";
import { signInWithGoogle } from "@/app/actions/oauth";
import { Spinner } from "@/components/reconnect-modal";

interface GoogleSignInButtonProps {
  /** Internal path to return to after sign-in (defaults to /play). */
  next?: string;
  /** Club context (from a /c/[clubSlug]/join QR): threaded through so
   *  /auth/callback can enroll the user in the club, mirroring the
   *  club_slug handling the anonymous sign-in flow already does. */
  clubSlug?: string;
  /**
   * Where to render the "─── or ───" divider relative to the button.
   * "above" (default) — button is at the bottom of a form, divider separates it from the CTA above.
   * "below" — button is at the top of the page, divider separates it from the form below.
   */
  dividerPosition?: "above" | "below";
}

export function GoogleSignInButton({
  next,
  clubSlug,
  dividerPosition = "above",
}: GoogleSignInButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Feature flag — inlined at build time. Hidden until Google is configured.
  if (process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED !== "true") return null;

  function onClick() {
    setError(null);
    startTransition(async () => {
      const result = await signInWithGoogle(next, clubSlug);
      if (result.success) {
        window.location.href = result.url; // full-page redirect to Google (PKCE)
      } else {
        setError(result.error);
      }
    });
  }

  const divider = (
    <div className={`flex items-center gap-3 ${dividerPosition === "below" ? "pt-6 pb-2" : ""}`}>
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">or</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );

  return (
    <div className="space-y-2">
      {dividerPosition === "above" && divider}
      <button
        type="button"
        onClick={onClick}
        disabled={isPending}
        className="flex min-h-[52px] w-full cursor-pointer items-center justify-center gap-3
                   rounded-lg border border-input bg-background px-4 py-4 text-base font-semibold
                   text-foreground transition-colors hover:bg-muted
                   disabled:cursor-not-allowed disabled:opacity-70"
      >
        {isPending ? (
          <Spinner />
        ) : (
          <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"
            />
          </svg>
        )}
        {isPending ? "Redirecting…" : "Continue with Google"}
      </button>
      {error && <p className="text-center text-sm text-red-600 dark:text-red-400">{error}</p>}
      {dividerPosition === "below" && divider}
    </div>
  );
}
