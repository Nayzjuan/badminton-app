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
// ============================================================

import { useEffect, useState } from "react";
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

  // SSR-safe: only read localStorage after mount.
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED !== "true") return;
    if (typeof window === "undefined") return;
    if (localStorage.getItem(DISMISSED_KEY)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState("visible");
  }, []);

  function handleDismiss() {
    if (typeof window !== "undefined") {
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
        {/* Header */}
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-foreground leading-tight">
            Save your spot across devices
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Link Google to rejoin with one tap — no PIN needed.
          </p>
        </div>

        {/* CTA — reuses GoogleLinkButton (compact variant) */}
        <div className="flex items-center">
          <div
            className="inline-flex items-center rounded-lg border border-border bg-background
                          px-3 py-2 transition-colors hover:bg-muted"
          >
            <GoogleLinkButton next={next} />
          </div>
        </div>
      </div>
    </div>
  );
}
