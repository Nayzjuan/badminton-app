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
import { Eye, EyeOff } from "lucide-react";
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

// Short descriptor shown beneath each skill level label in the radio card grid.
const SKILL_DESCRIPTORS: Record<string, string> = {
  beginner: "Just starting out",
  lower_intermediate: "Getting consistent",
  intermediate: "Solid rallies",
  upper_intermediate: "Match-ready",
  lower_advanced: "Competitive play",
  advanced: "Tournament level",
};

// Tier indicator dot — maps to the same 3-group color language as SkillBadge:
//   emerald = new player  |  sky/blue = developing  |  amber = competitive  |  purple = elite
const SKILL_TIER_DOT: Record<string, string> = {
  beginner:           "bg-emerald-400 dark:bg-emerald-500",
  lower_intermediate: "bg-sky-400 dark:bg-sky-500",
  intermediate:       "bg-sky-400 dark:bg-sky-500",
  upper_intermediate: "bg-amber-400 dark:bg-amber-500",
  lower_advanced:     "bg-amber-400 dark:bg-amber-500",
  advanced:           "bg-purple-400 dark:bg-purple-500",
};

export function LoginForm({ sessionId }: LoginFormProps = {}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [showReconnect, setShowReconnect] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [skillLevel, setSkillLevel] = useState("beginner");
  const [showPin, setShowPin] = useState(false);

  // Prefetch /play so the redirect after login is instant.
  useEffect(() => {
    router.prefetch(sessionId ? `/play/${sessionId}` : "/play");
  }, [router, sessionId]);

  // Auto-dismiss error toast after 8 s — courtside, player may be looking away.
  useEffect(() => {
    if (error) {
      const id = setTimeout(() => setError(null), 8000);
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
      <form action={handleSubmit} className="w-full max-w-sm sm:max-w-md space-y-5">
        {/* ── Name ─────────────────────────────────────────── */}
        <div className="space-y-2">
          <label
            htmlFor="display_name"
            className="block text-sm font-semibold text-foreground"
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
            maxLength={30}
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            placeholder="e.g. Smash King, Net Ninja…"
            autoComplete="nickname"
            className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                       placeholder:text-muted-foreground focus:outline-none focus:ring-2
                       focus:ring-ring focus:ring-offset-2 disabled:opacity-50"
          />
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Pick a name you won&apos;t mind your friends shouting across the
              court!
            </p>
            <span
              className={`shrink-0 text-xs font-mono tabular-nums ${
                nameValue.length === 30
                  ? "font-semibold text-red-500"
                  : nameValue.length >= 25
                  ? "text-amber-500"
                  : "text-muted-foreground"
              }`}
            >
              {nameValue.length}/30
            </span>
          </div>
        </div>

        {/* ── Skill Level — radio card grid ─────────────────── */}
        {/* fieldset/legend is the semantic group label for screen readers */}
        <fieldset className="space-y-2 border-0 p-0 m-0">
          <legend className="block text-sm font-semibold text-foreground">
            Skill Level
          </legend>
          {/* Hidden input carries the controlled value into FormData */}
          <input type="hidden" name="skill_level" value={skillLevel} />
          <div
            className={`grid grid-cols-2 gap-2 ${
              isPending ? "pointer-events-none opacity-50" : ""
            }`}
          >
            {SKILL_LEVELS.map((level) => (
              <label
                key={level.value}
                className={`relative flex min-h-[56px] cursor-pointer flex-col justify-center
                            gap-0.5 rounded-lg border-2 px-3 py-2.5 transition-colors
                            ${
                              skillLevel === level.value
                                ? "border-amber-500 bg-amber-50 dark:border-amber-400 dark:bg-amber-950/30"
                                : "border-input bg-background hover:bg-amber-50/50 dark:hover:bg-amber-950/10"
                            }`}
              >
                <input
                  type="radio"
                  name="skill_level_radio"
                  value={level.value}
                  checked={skillLevel === level.value}
                  onChange={() => setSkillLevel(level.value)}
                  disabled={isPending}
                  className="sr-only"
                />
                {/* Tier indicator dot — top-right corner */}
                <span
                  className={`absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full ${SKILL_TIER_DOT[level.value]}`}
                  aria-hidden="true"
                />
                <span className="text-sm font-semibold leading-tight text-foreground">
                  {level.label}
                </span>
                <span className="text-xs leading-tight text-muted-foreground">
                  {SKILL_DESCRIPTORS[level.value]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* ── 4-digit PIN ───────────────────────────────────── */}
        <div className="space-y-2">
          <label
            htmlFor="pin"
            className="block text-sm font-semibold text-foreground"
          >
            4-Digit PIN
          </label>
          <div className="relative">
            <input
              id="pin"
              name="pin"
              type={showPin ? "tel" : "password"}
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              required
              disabled={isPending}
              placeholder="1234"
              autoComplete="off"
              className="w-full rounded-lg border border-input bg-background px-4 py-3 pr-12
                         text-base tracking-[0.3em] text-center font-mono
                         placeholder:text-muted-foreground placeholder:tracking-normal
                         focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2
                         disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setShowPin((v) => !v)}
              aria-label={showPin ? "Hide PIN" : "Show PIN"}
              aria-pressed={showPin}
              aria-controls="pin"
              disabled={isPending}
              className="absolute right-0 top-0 flex h-full min-w-[44px] cursor-pointer
                         items-center justify-center px-3 text-muted-foreground
                         transition-colors hover:text-foreground disabled:pointer-events-none"
            >
              {showPin ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Your PIN lets you rejoin if you disconnect. Pick something
            you&apos;ll remember.
          </p>
        </div>

        {/* Hidden session_id — routes the redirect to /play/[id] after login */}
        {sessionId && (
          <input type="hidden" name="session_id" value={sessionId} />
        )}

        {/* ── Submit ───────────────────────────────────────── */}
        <button
          type="submit"
          disabled={isPending}
          className="flex min-h-[52px] w-full cursor-pointer items-center justify-center
                     gap-2 rounded-lg bg-amber-500 px-4 py-4 text-base font-semibold
                     text-[#0E1C3A] transition-colors hover:bg-amber-600
                     disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isPending && <Spinner />}
          {isPending ? "Joining…" : sessionId ? "Join Session" : "Join Queue"}
        </button>
      </form>

      {/* ── Reconnect link ───────────────────────────────── */}
      <div className="mt-4">
        <button
          onClick={() => setShowReconnect(true)}
          className="flex min-h-[44px] cursor-pointer items-center justify-center
                     text-sm text-muted-foreground underline transition-colors
                     hover:text-foreground dark:text-amber-400/60 dark:hover:text-amber-400"
        >
          Already have a PIN? Reconnect
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
          <div className="flex items-center gap-2 rounded-xl bg-destructive px-4 py-3 text-sm font-medium text-destructive-foreground shadow-lg">
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
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              aria-label="Dismiss error"
              className="ml-2 cursor-pointer rounded-full p-0.5 transition-colors hover:bg-destructive-foreground/20"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
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
          <DialogDescription>
            Enter the name and PIN you used when joining.
          </DialogDescription>
        </DialogHeader>

        {/* Player Name */}
        <div className="space-y-2">
          <label
            htmlFor="reconnect_name"
            className="block text-sm font-semibold text-foreground"
          >
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
          <label
            htmlFor="reconnect_pin"
            className="block text-sm font-semibold text-foreground"
          >
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
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive dark:border-destructive/50 dark:bg-destructive/20">
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
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
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
      aria-hidden="true"
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
