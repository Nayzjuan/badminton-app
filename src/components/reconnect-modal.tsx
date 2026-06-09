"use client";

// ============================================================
// ReconnectModal — Dialog for returning players to reclaim their
// queue position and match history using name + PIN.
// ============================================================

import { useEffect, useState, useTransition } from "react";
import { ERROR_AUTO_DISMISS_MS } from "@/lib/constants";
import { useRouter } from "next/navigation";
import { reconnectPlayer } from "@/app/actions/auth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

// ─────────────────────────────────────────────────────────────
// Shared Spinner
// ─────────────────────────────────────────────────────────────

export function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────
// Reconnect Modal
// ─────────────────────────────────────────────────────────────

export function ReconnectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [isPending, startTransition] = useTransition();
  // Error lives inside the modal so it's always visible to the user.
  // Previously it was passed up to the parent and rendered as a fixed
  // toast at z-50 — same z-index as the Radix dialog overlay — causing
  // the error to render behind the modal.
  const [localError, setLocalError] = useState<string | null>(null);

  // Auto-dismiss local error after 8 s — matches main form behaviour.
  useEffect(() => {
    if (localError) {
      const id = setTimeout(() => setLocalError(null), ERROR_AUTO_DISMISS_MS);
      return () => clearTimeout(id);
    }
  }, [localError]);

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
        // Duplicate-name gate takes priority: a flagged profile must resolve
        // its name before anything else. Preserve the intended destination.
        if (result.requiresRename) {
          const dest = result.sessionId ? `/play/${result.sessionId}` : "/play";
          router.push(`/rename?next=${encodeURIComponent(dest)}`);
          return;
        }
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
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose();
          setLocalError(null);
        }
      }}
    >
      <DialogContent className="w-full max-w-sm p-6 space-y-5">
        <DialogHeader>
          <DialogTitle>Reconnect</DialogTitle>
          <DialogDescription>Enter the name and PIN you used when joining.</DialogDescription>
        </DialogHeader>

        {/* Player Name */}
        <div className="space-y-2">
          <label htmlFor="reconnect_name" className="block text-sm font-semibold text-foreground">
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
          <label htmlFor="reconnect_pin" className="block text-sm font-semibold text-foreground">
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
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-destructive/30
                       bg-destructive/10 px-3 py-2.5 text-sm text-destructive
                       dark:border-destructive/50 dark:bg-destructive/20"
          >
            <svg
              className="h-4 w-4 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span>{localError}</span>
            <button
              type="button"
              onClick={() => setLocalError(null)}
              aria-label="Dismiss error"
              className="ml-auto cursor-pointer rounded-full p-0.5 transition-colors
                         hover:bg-destructive/20"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="flex-1 cursor-pointer rounded-lg border border-input px-4 py-3 text-sm
                       font-medium text-foreground transition-colors hover:bg-accent
                       disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleReconnect}
            disabled={isPending || !name.trim() || pin.length !== 4}
            className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg
                       bg-amber-500 px-4 py-3 text-sm font-semibold text-[#0E1C3A]
                       transition-colors hover:bg-amber-600
                       disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isPending && <Spinner />}
            {isPending ? "Reconnecting…" : "Reconnect"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
