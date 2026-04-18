"use client";

// ============================================================
// NotificationEnrollment — Pocket Ping soft-prompt
// ============================================================
// Shown automatically to authenticated players if the browser's
// Notification.permission is 'default' (never asked).
//
// Design rationale:
//   • We DON'T call Notification.requestPermission() cold on page
//     load — that triggers the browser's native permission dialog
//     without context and gets dismissed by ~60% of users.
//   • Instead we show THIS soft prompt first, explain the benefit,
//     then hand off to the browser dialog only after the user clicks
//     "Enable Pocket Pings".
//   • If the user clicks "Not now" we store a flag in localStorage
//     so we never show this prompt again on this device.
// ============================================================

import { useEffect, useState } from "react";
import { Bell, BellOff, X } from "lucide-react";
import {
  isPushSupported,
  getNotificationPermission,
  hasUserMadeChoice,
  markPromptDismissed,
  subscribeAndPersist,
} from "@/lib/notifications/push-client";

interface NotificationEnrollmentProps {
  /** The authenticated user's ID — required to persist the subscription. */
  userId: string;
}

type PromptState = "idle" | "visible" | "requesting" | "granted" | "denied" | "dismissed";

export function NotificationEnrollment({ userId }: NotificationEnrollmentProps) {
  const [state, setState] = useState<PromptState>("idle");

  // ── Mount: decide whether to show the prompt ──────────────
  useEffect(() => {
    // SSR / no push support → never show
    if (!isPushSupported()) return;

    // User already granted OR denied OR dismissed this device → don't show
    if (hasUserMadeChoice()) return;

    // Delay the prompt slightly so it doesn't compete with the
    // page's initial render / loading states.
    const timer = setTimeout(() => {
      // Re-check in case permission was granted in another tab.
      if (getNotificationPermission() === "default") {
        setState("visible");
      }
    }, 2_500);

    return () => clearTimeout(timer);
  }, []);

  // ── Handlers ─────────────────────────────────────────────

  async function handleEnable() {
    setState("requesting");

    // Trigger the browser's native permission dialog.
    let permission: NotificationPermission;
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = "denied";
    }

    if (permission === "granted") {
      const ok = await subscribeAndPersist(userId);
      setState(ok ? "granted" : "denied");
      markPromptDismissed();
    } else {
      setState("denied");
      markPromptDismissed();
    }
  }

  function handleDismiss() {
    markPromptDismissed();
    setState("dismissed");
  }

  // ── Nothing to render ────────────────────────────────────

  if (state === "idle" || state === "dismissed") return null;

  // ── Post-permission feedback ─────────────────────────────

  if (state === "granted") {
    return (
      <GrantedBanner onClose={() => setState("dismissed")} />
    );
  }

  if (state === "denied") {
    return (
      <DeniedBanner onClose={() => setState("dismissed")} />
    );
  }

  // ── Soft prompt card ─────────────────────────────────────

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Enable Pocket Pings"
      className="
        fixed bottom-4 left-1/2 -translate-x-1/2 z-50
        w-[calc(100vw-2rem)] max-w-sm
        rounded-2xl border border-amber-200 dark:border-amber-900/50
        bg-white dark:bg-card
        shadow-xl shadow-amber-100/40 dark:shadow-black/40
        overflow-hidden
        animate-in slide-in-from-bottom-4 fade-in duration-300
      "
    >
      {/* Amber accent stripe */}
      <div className="h-1 w-full bg-gradient-to-r from-amber-400 to-amber-500" />

      <div className="p-4">
        {/* Header row */}
        <div className="flex items-start gap-3">
          {/* Bell icon */}
          <div className="shrink-0 flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-900/30">
            <Bell className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>

          {/* Text */}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-900 dark:text-foreground leading-snug">
              Enable Pocket Pings 🏸
            </p>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-muted-foreground leading-relaxed">
              Get notified when your match is ready — even if your screen is off or you&apos;re chatting with friends.
            </p>
          </div>

          {/* Dismiss X */}
          <button
            onClick={handleDismiss}
            aria-label="Dismiss notification prompt"
            className="
              shrink-0 flex items-center justify-center
              h-7 w-7 rounded-full
              text-slate-400 hover:text-slate-600
              dark:text-muted-foreground dark:hover:text-foreground
              hover:bg-slate-100 dark:hover:bg-muted
              transition-colors
            "
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Action buttons */}
        <div className="mt-3.5 flex gap-2">
          <button
            onClick={handleEnable}
            disabled={state === "requesting"}
            className="
              flex-1 flex items-center justify-center gap-1.5
              rounded-xl bg-amber-500 hover:bg-amber-600
              dark:bg-amber-500 dark:hover:bg-amber-600
              px-4 py-2.5 min-h-[44px]
              text-sm font-semibold text-white
              disabled:opacity-60 disabled:cursor-not-allowed
              transition-colors
            "
          >
            <Bell className="h-3.5 w-3.5 shrink-0" />
            {state === "requesting" ? "Enabling…" : "Enable Pings"}
          </button>

          <button
            onClick={handleDismiss}
            disabled={state === "requesting"}
            className="
              px-4 py-2.5 min-h-[44px]
              rounded-xl border border-slate-200 dark:border-border
              text-sm font-medium text-slate-600 dark:text-muted-foreground
              hover:bg-slate-50 dark:hover:bg-muted
              disabled:opacity-60 disabled:cursor-not-allowed
              transition-colors
            "
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Post-permission banners ───────────────────────────────────

function GrantedBanner({ onClose }: { onClose: () => void }) {
  // Auto-dismiss after 4 seconds.
  useEffect(() => {
    const t = setTimeout(onClose, 4_000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="
      fixed bottom-4 left-1/2 -translate-x-1/2 z-50
      w-[calc(100vw-2rem)] max-w-sm
      flex items-center gap-3
      rounded-2xl bg-emerald-50 dark:bg-emerald-950/50
      border border-emerald-200 dark:border-emerald-800
      px-4 py-3 shadow-lg
      animate-in slide-in-from-bottom-4 fade-in duration-300
    ">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/50">
        <Bell className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
      </div>
      <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200 flex-1">
        Pocket Pings enabled! You&apos;re all set. 🎉
      </p>
      <button
        onClick={onClose}
        aria-label="Close"
        className="text-emerald-500 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-200"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function DeniedBanner({ onClose }: { onClose: () => void }) {
  // Auto-dismiss after 5 seconds.
  useEffect(() => {
    const t = setTimeout(onClose, 5_000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="
      fixed bottom-4 left-1/2 -translate-x-1/2 z-50
      w-[calc(100vw-2rem)] max-w-sm
      flex items-center gap-3
      rounded-2xl bg-slate-50 dark:bg-card
      border border-slate-200 dark:border-border
      px-4 py-3 shadow-lg
      animate-in slide-in-from-bottom-4 fade-in duration-300
    ">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-muted">
        <BellOff className="h-4 w-4 text-slate-500 dark:text-muted-foreground" />
      </div>
      <p className="text-xs text-slate-500 dark:text-muted-foreground flex-1">
        No worries — you can always enable notifications later in your browser settings.
      </p>
      <button
        onClick={onClose}
        aria-label="Close"
        className="text-slate-400 hover:text-slate-600"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
