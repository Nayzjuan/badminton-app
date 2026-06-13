"use client";

// ============================================================
// GoogleLinkCard — Soft-prompt to link a Google account
// ============================================================
// Shown at the top of the My Status tab for anonymous players
// who haven't yet linked a Google account. Lets them upgrade
// to Google sign-in (one-tap return, no PIN) without leaving
// the queue.
//
// Behaviour:
//   • Shown when: NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === "true"
//     AND localStorage key "google-link-card-dismissed" is absent.
//   • Dismiss × writes the key and hides the card permanently on
//     this device (same pattern as NotificationEnrollment).
//   • SSR-safe: initial state is "idle"; useEffect on mount checks
//     localStorage and switches to "visible".
//   • When URL contains ?error=already_linked, shows an explanation
//     instead of the normal CTA (the Google account is already linked
//     to a different Supabase user — likely an orphaned old identity).
// ============================================================

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { GoogleLinkButton } from "@/components/auth/google-link-button";

const DISMISSED_KEY = "google-link-card-dismissed";

interface GoogleLinkCardProps {
  /** Return path after Google link completes (e.g. "/play" or "/play/[id]"). */
  next: string;
}

type CardState = "idle" | "visible" | "dismissed";

export function GoogleLinkCard({ next }: GoogleLinkCardProps) {
  const [state, setState] = useState<CardState>("idle");
  const searchParams = useSearchParams();
  const router = useRouter();
  const linkError = searchParams.get("error") === "already_linked";

  // SSR-safe: only read localStorage after mount.
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED !== "true") return;
    if (typeof window === "undefined") return;
    // Show card on error even if dismissed — user needs the explanation.
    if (!linkError && localStorage.getItem(DISMISSED_KEY)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState("visible");
  }, [linkError]);

  // Clear the ?error param from the URL once the card is visible so refreshing
  // doesn't re-surface the error on a clean load.
  useEffect(() => {
    if (!linkError) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("error");
    const cleaned = params.size > 0 ? `?${params.toString()}` : "";
    router.replace(`${window.location.pathname}${cleaned}`, { scroll: false });
  }, [linkError, router, searchParams]);

  function handleDismiss() {
    // Don't permanently dismiss when showing an error explanation — the user
    // might want to link a different Google account after reading it.
    if (!linkError && typeof window !== "undefined") {
      localStorage.setItem(DISMISSED_KEY, "1");
    }
    setState("dismissed");
  }

  if (state !== "visible") return null;

  return (
    <div
      className="relative rounded-xl border border-border bg-card px-4 py-3.5"
      role="complementary"
      aria-label="Link Google Account"
    >
      {/* Dismiss button */}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="absolute right-2.5 top-2.5 grid h-7 w-7 place-items-center rounded-md
                   text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <div className="pr-7 space-y-2.5">
        {linkError ? (
          /* Error state — Google account is already attached to another profile */
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground leading-tight">
              Google account already linked
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              That Google account is connected to a different profile. Sign out and use{" "}
              <strong>Continue with Google</strong> on the login screen to access it, or link a
              different Google account here.
            </p>
          </div>
        ) : (
          /* Normal state — prompt to link */
          <>
            <div className="space-y-0.5">
              <p className="text-sm font-semibold text-foreground leading-tight">
                Save your spot across devices
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Link Google to rejoin with one tap — no PIN needed.
              </p>
            </div>

            <div className="flex items-center">
              <div
                className="inline-flex items-center rounded-lg border border-border bg-background
                              px-3 py-2 transition-colors hover:bg-muted"
              >
                <GoogleLinkButton next={next} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
