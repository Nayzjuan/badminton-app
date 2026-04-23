"use client";

// ============================================================
// Login Form — Name + Skill Level + PIN entry for anonymous auth
// ============================================================
// Includes a "Reconnect" flow for returning players who lost
// their browser session. They enter name + PIN to reclaim their
// queue position and match history.
// ============================================================

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signInAnonymously, reconnectPlayer } from "@/app/actions/auth";
import { SKILL_LEVELS } from "@/types/database";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface LoginFormProps {
  /** If provided, the user will be redirected to /play/[sessionId] after login. */
  sessionId?: string;
}

export function LoginForm({ sessionId }: LoginFormProps = {}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [showReconnect, setShowReconnect] = useState(false);

  // Prefetch /play so the redirect after login is instant.
  useEffect(() => {
    router.prefetch(sessionId ? `/play/${sessionId}` : "/play");
  }, [router, sessionId]);

  // Auto-dismiss error toast after 5 seconds.
  useEffect(() => {
    if (error) {
      const id = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(id);
    }
  }, [error]);

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await signInAnonymously(formData);
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  return (
    <>
      <form action={handleSubmit} className="w-full max-w-sm space-y-5">
        {/* Name Input */}
        <div className="space-y-2">
          <label
            htmlFor="display_name"
            className="block text-sm font-medium text-foreground"
          >
            Your Name
          </label>
          <input
            id="display_name"
            name="display_name"
            type="text"
            required
            autoFocus
            disabled={isPending}
            placeholder="e.g. Smash King, Net Ninja..."
            autoComplete="nickname"
            className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                       placeholder:text-muted-foreground focus:outline-none focus:ring-2
                       focus:ring-ring focus:ring-offset-2 disabled:opacity-50"
          />
          <p className="text-xs text-muted-foreground leading-relaxed">
            This is your official player account and login name. Pick a name
            you won&apos;t mind your friends shouting across the court!
          </p>
        </div>

        {/* Skill Level Select */}
        <div className="space-y-2">
          <label
            htmlFor="skill_level"
            className="block text-sm font-medium text-foreground"
          >
            Skill Level
          </label>
          <select
            id="skill_level"
            name="skill_level"
            required
            disabled={isPending}
            defaultValue="beginner"
            className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                       text-foreground focus:outline-none focus:ring-2 focus:ring-ring
                       focus:ring-offset-2 appearance-none disabled:opacity-50"
          >
            {SKILL_LEVELS.map((level) => (
              <option key={level.value} value={level.value}>
                {level.label}
              </option>
            ))}
          </select>
        </div>

        {/* 4-digit PIN */}
        <div className="space-y-2">
          <label
            htmlFor="pin"
            className="block text-sm font-medium text-foreground"
          >
            4-Digit PIN
          </label>
          <p className="text-xs text-muted-foreground">
            Remember this — you&apos;ll need it to reconnect if your browser closes.
          </p>
          <input
            id="pin"
            name="pin"
            type="tel"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            required
            disabled={isPending}
            placeholder="e.g. 1234"
            className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                       tracking-[0.3em] text-center font-mono
                       placeholder:text-muted-foreground placeholder:tracking-normal
                       focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2
                       disabled:opacity-50"
          />
        </div>

        {/* Hidden session_id — routes the redirect to /play/[id] after login */}
        {sessionId && (
          <input type="hidden" name="session_id" value={sessionId} />
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded-lg bg-primary px-4 py-3 text-base font-semibold
                     text-primary-foreground transition-colors hover:bg-primary/90
                     disabled:opacity-70 disabled:cursor-not-allowed
                     flex items-center justify-center gap-2"
        >
          {isPending && <Spinner />}
          {isPending ? "Joining..." : "Enter"}
        </button>
      </form>

      {/* Reconnect link */}
      <div className="mt-4">
        <button
          onClick={() => setShowReconnect(true)}
          className="text-sm text-muted-foreground hover:text-foreground underline transition-colors"
        >
          Returning player? Reconnect
        </button>
      </div>

      {/* Reconnect Modal — Radix Dialog provides focus trap, aria-modal, Escape to close */}
      <ReconnectModal
        open={showReconnect}
        onClose={() => setShowReconnect(false)}
      />

      {/* Error toast — fixed at bottom */}
      {error && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="flex items-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white shadow-lg">
            <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="ml-2 rounded-full p-0.5 hover:bg-white/20 transition-colors"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Reconnect Modal
// ─────────────────────────────────────────────────────────────

function ReconnectModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [isPending, startTransition] = useTransition();
  // Error lives inside the modal so it's always visible to the user.
  // Previously it was passed up to the parent and rendered as a fixed
  // toast at z-50 — same z-index as the Radix dialog overlay — causing
  // the error to render behind the modal.
  const [localError, setLocalError] = useState<string | null>(null);

  function handleReconnect() {
    setLocalError(null);
    if (!name.trim() || !pin.trim()) {
      setLocalError("Name and PIN are required.");
      return;
    }

    startTransition(async () => {
      const result = await reconnectPlayer(name, pin);
      if (!result.success) {
        setLocalError(result.error ?? "Reconnect failed.");
      } else {
        onClose();
        // Priority: active session → pending Wrapped page → lobby.
        // wrappedUrl is set when the player's most recent session closed
        // while they were offline (within the last 48 h).
        if (result.wrappedUrl) {
          router.push(result.wrappedUrl);
        } else if (result.sessionId) {
          router.push(`/play/${result.sessionId}`);
        } else {
          router.push("/play");
        }
      }
    });
  }

  return (
    // Radix Dialog provides: focus trap, aria-modal, role="dialog",
    // Escape-to-close, and scroll-lock — no custom backdrop needed.
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) { onClose(); setLocalError(null); } }}>
      <DialogContent className="w-full max-w-sm p-6 space-y-5">
        <DialogHeader>
          <DialogTitle>Reconnect</DialogTitle>
          <DialogDescription>
            Enter the name and PIN you used when joining.
          </DialogDescription>
        </DialogHeader>

        {/* Player Name */}
        <div className="space-y-2">
          <label htmlFor="reconnect_name" className="block text-sm font-medium text-foreground">
            Player Name
          </label>
          <input
            id="reconnect_name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isPending}
            autoFocus
            placeholder="e.g. Miggy"
            className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                       placeholder:text-muted-foreground focus:outline-none focus:ring-2
                       focus:ring-ring focus:ring-offset-2 disabled:opacity-50"
          />
        </div>

        {/* PIN */}
        <div className="space-y-2">
          <label htmlFor="reconnect_pin" className="block text-sm font-medium text-foreground">
            PIN
          </label>
          <input
            id="reconnect_pin"
            type="tel"
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            disabled={isPending}
            placeholder="1234"
            className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                       tracking-[0.3em] text-center font-mono
                       placeholder:text-muted-foreground placeholder:tracking-normal
                       focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2
                       disabled:opacity-50"
          />
        </div>

        {/* Inline error — always visible inside the modal */}
        {localError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400">
            <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{localError}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={isPending}
            className="flex-1 rounded-lg border border-input px-4 py-3 text-sm font-medium
                       text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleReconnect}
            disabled={isPending || !name.trim() || pin.length !== 4}
            className="flex-1 rounded-lg bg-primary px-4 py-3 text-sm font-semibold
                       text-primary-foreground hover:bg-primary/90 transition-colors
                       disabled:opacity-70 disabled:cursor-not-allowed
                       flex items-center justify-center gap-2"
          >
            {isPending && <Spinner />}
            {isPending ? "Reconnecting..." : "Reconnect"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared Spinner
// ─────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
