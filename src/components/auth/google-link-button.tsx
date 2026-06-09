"use client";

// ============================================================
// GoogleLinkButton — "Link Google Account" (compact, menu-safe)
// ============================================================
// Used inside the player dashboard overflow menu to let an
// existing anonymous player upgrade to Google sign-in without
// losing their profile. Calls linkWithGoogle() which starts the
// PKCE link flow — the user returns to the same session after
// Google consent.
//
// Flag-gated: renders nothing unless NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED
// === "true". Compact styling (not full-width) to fit inside menu rows.
// ============================================================

import { useState, useTransition } from "react";
import { linkWithGoogle } from "@/app/actions/oauth";
import { Spinner } from "@/components/reconnect-modal";

interface GoogleLinkButtonProps {
  /** Path to return to after Google link completes (default /play). */
  next?: string;
}

export function GoogleLinkButton({ next }: GoogleLinkButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Feature flag — inlined at build time. Hidden until Google is configured.
  if (process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED !== "true") return null;

  function onClick() {
    setError(null);
    startTransition(async () => {
      const result = await linkWithGoogle(next);
      if (result.success) {
        window.location.href = result.url;
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={onClick}
        disabled={isPending}
        className="flex w-full cursor-pointer items-center gap-2 text-left text-xs font-medium
                   text-foreground transition-colors hover:text-foreground/80
                   disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? (
          <Spinner />
        ) : (
          <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
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
        <span>{isPending ? "Redirecting…" : "Link Google Account"}</span>
      </button>
      {error && <p className="text-[11px] text-red-500 dark:text-red-400">{error}</p>}
    </div>
  );
}
