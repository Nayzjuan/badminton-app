"use client";

// ============================================================
// InstallPrompt — Add-to-Home-Screen nudge (iOS + Android)
// ============================================================
// Encourages players to INSTALL the PWA so Web Push works.
//
//   • iOS (not installed): Web Push REQUIRES an installed PWA, so we
//     show a manual "Share → Add to Home Screen" hint. There is no
//     beforeinstallprompt event on iOS. This replaces the "Enable
//     Pings" card (which can't function in an iOS Safari tab — see the
//     iOS gate in notification-enrollment.tsx).
//   • Android: capture the `beforeinstallprompt` event and offer a
//     one-tap install. Surfaced only AFTER the player has dealt with
//     the notification prompt, so the two bottom cards don't stack.
//
// Dismissal persists in localStorage so it won't re-nag this device.
// Renders nothing when already installed (standalone) or dismissed.
// ============================================================

import { useEffect, useRef, useState } from "react";
import { Share, SquarePlus, Download, X, Smartphone } from "lucide-react";
import { isStandalone, isIOS, isAndroid } from "@/lib/pwa/install-detection";
import { hasUserMadeChoice } from "@/lib/notifications/push-client";

const INSTALL_DISMISSED_KEY = "pwa_install_prompt_dismissed";

// The `beforeinstallprompt` event is non-standard and absent from lib.dom.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type View = "hidden" | "ios" | "android";

function isDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(INSTALL_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function markDismissed(): void {
  try {
    localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
  } catch {
    // localStorage may be blocked in private browsing — safe to ignore.
  }
}

export function InstallPrompt() {
  const [view, setView] = useState<View>("hidden");
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  // Tracks the iOS reveal timeout OR the Android "wait for ping choice" poll,
  // so we can always clear it on unmount (no late setState after teardown).
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isStandalone() || isDismissed()) return;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    // ── iOS: no install event exists — show the manual A2HS hint. ──
    if (isIOS()) {
      timerRef.current = setTimeout(() => setView("ios"), 3_000) as unknown as ReturnType<
        typeof setInterval
      >;
      return clearTimer;
    }

    // Desktop: push works in-tab and an install nudge adds little — skip.
    if (!isAndroid()) return;

    // ── Android: capture the install event, then surface ONLY after the
    //    player has resolved the "Enable Pings" prompt, so the two
    //    bottom cards never overlap. Poll (bounded) for that decision
    //    instead of a blind delay, then reveal as a hard fallback. ──
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      clearTimer(); // guard against a (spec-disallowed) refire orphaning a poll
      deferredPrompt.current = e as BeforeInstallPromptEvent;

      const reveal = () => {
        clearTimer();
        if (!isDismissed()) setView("android");
      };
      if (hasUserMadeChoice()) {
        reveal();
        return;
      }
      // Wait for the ping decision; reveal once made or after ~21s max.
      let attempts = 0;
      timerRef.current = setInterval(() => {
        attempts += 1;
        if (hasUserMadeChoice() || attempts >= 14) reveal();
      }, 1_500);
    };
    const onInstalled = () => {
      clearTimer();
      markDismissed();
      setView("hidden");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      clearTimer();
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function handleAndroidInstall() {
    const dp = deferredPrompt.current;
    if (!dp) return;
    try {
      await dp.prompt();
      await dp.userChoice;
    } catch {
      // User dismissed the native sheet — treat as handled.
    }
    deferredPrompt.current = null;
    markDismissed();
    setView("hidden");
  }

  function handleDismiss() {
    markDismissed();
    setView("hidden");
  }

  if (view === "hidden") return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Install Badminton Queue"
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
        <div className="flex items-start gap-3">
          <div className="shrink-0 flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-900/30">
            <Smartphone className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-900 dark:text-foreground leading-snug">
              Install for court alerts 🏸
            </p>
            {view === "ios" ? (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-muted-foreground leading-relaxed">
                Add Badminton Queue to your Home Screen so you get a buzz when your match is ready —
                even with your screen off. Tap{" "}
                <Share className="inline h-3.5 w-3.5 -mt-0.5 text-amber-600 dark:text-amber-400" />{" "}
                <span className="font-semibold">Share</span>, then{" "}
                <SquarePlus className="inline h-3.5 w-3.5 -mt-0.5 text-amber-600 dark:text-amber-400" />{" "}
                <span className="font-semibold">Add to Home Screen</span>.
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-muted-foreground leading-relaxed">
                Install the app for the most reliable court alerts — a buzz on your lock screen the
                moment your match is ready.
              </p>
            )}
          </div>

          <button
            onClick={handleDismiss}
            aria-label="Dismiss install prompt"
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

        {/* Android gets a one-tap install button; iOS is manual-only. */}
        {view === "android" && (
          <div className="mt-3.5 flex gap-2">
            <button
              onClick={handleAndroidInstall}
              className="
                flex-1 flex items-center justify-center gap-1.5
                rounded-xl bg-amber-500 hover:bg-amber-600
                dark:bg-amber-500 dark:hover:bg-amber-600
                px-4 py-2.5 min-h-[44px]
                text-sm font-semibold text-white
                transition-colors
              "
            >
              <Download className="h-3.5 w-3.5 shrink-0" />
              Install app
            </button>
            <button
              onClick={handleDismiss}
              className="
                px-4 py-2.5 min-h-[44px]
                rounded-xl border border-slate-200 dark:border-border
                text-sm font-medium text-slate-600 dark:text-muted-foreground
                hover:bg-slate-50 dark:hover:bg-muted
                transition-colors
              "
            >
              Not now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
