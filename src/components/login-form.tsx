"use client";

// ============================================================
// Login Form — Name + Skill Level + PIN entry for anonymous auth
// ============================================================
// Two modes toggled by a segmented control at the top:
//   NEW PLAYER   — name + skill level + PIN → Join Queue
//   RETURNING    — name + PIN → Reconnect (inline, no modal)
//
// The RETURNING path replaces the old buried "Already have a PIN?
// Reconnect" underline link, giving equal visual hierarchy to both
// journeys from the first interaction.
// ============================================================

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, UserPlus, RotateCcw } from "lucide-react";
import { signInAnonymously, reconnectPlayer } from "@/app/actions/auth";
import { SKILL_LEVELS } from "@/types/database";
import { Spinner } from "./reconnect-modal";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { clubPlay, clubBase } from "@/lib/club-paths";

interface LoginFormProps {
  /** If provided, the user will be redirected to /play/[sessionId] after login. */
  sessionId?: string;
  /** Club context (from a /c/[clubSlug]/join QR): the new player is auto-enrolled
   *  in the club and routed to the club-scoped session. */
  clubSlug?: string;
}

type LoginMode = "new" | "returning";

// Per-level color config — each skill level gets a distinct color so players
// can self-identify at a glance. Spectrum runs cool→warm with difficulty:
//   emerald → teal → sky → indigo → fuchsia → purple
//   (amber avoided — reserved for the app's pending/warning semantic)
const SKILL_COLORS: Record<
  string,
  { descriptor: string; dot: string; idle: string; active: string }
> = {
  beginner: {
    descriptor: "Just starting out",
    dot: "bg-emerald-400 dark:bg-emerald-500",
    idle: "border-emerald-200 bg-emerald-50/60 hover:bg-emerald-50 dark:border-emerald-800/40 dark:bg-emerald-950/20 dark:hover:bg-emerald-950/30",
    active: "border-emerald-500 bg-emerald-100 dark:border-emerald-400 dark:bg-emerald-950/50",
  },
  lower_intermediate: {
    descriptor: "Getting consistent",
    dot: "bg-teal-400 dark:bg-teal-500",
    idle: "border-teal-200 bg-teal-50/60 hover:bg-teal-50 dark:border-teal-800/40 dark:bg-teal-950/20 dark:hover:bg-teal-950/30",
    active: "border-teal-500 bg-teal-100 dark:border-teal-400 dark:bg-teal-950/50",
  },
  intermediate: {
    descriptor: "Solid rallies",
    dot: "bg-sky-400 dark:bg-sky-500",
    idle: "border-sky-200 bg-sky-50/60 hover:bg-sky-50 dark:border-sky-800/40 dark:bg-sky-950/20 dark:hover:bg-sky-950/30",
    active: "border-sky-500 bg-sky-100 dark:border-sky-400 dark:bg-sky-950/50",
  },
  upper_intermediate: {
    descriptor: "Match-ready",
    dot: "bg-indigo-400 dark:bg-indigo-500",
    idle: "border-indigo-200 bg-indigo-50/60 hover:bg-indigo-50 dark:border-indigo-800/40 dark:bg-indigo-950/20 dark:hover:bg-indigo-950/30",
    active: "border-indigo-500 bg-indigo-100 dark:border-indigo-400 dark:bg-indigo-950/50",
  },
  lower_advanced: {
    descriptor: "Competitive play",
    dot: "bg-fuchsia-400 dark:bg-fuchsia-500",
    idle: "border-fuchsia-200 bg-fuchsia-50/60 hover:bg-fuchsia-50 dark:border-fuchsia-800/40 dark:bg-fuchsia-950/20 dark:hover:bg-fuchsia-950/30",
    active: "border-fuchsia-500 bg-fuchsia-100 dark:border-fuchsia-400 dark:bg-fuchsia-950/50",
  },
  advanced: {
    descriptor: "Tournament level",
    dot: "bg-purple-400 dark:bg-purple-500",
    idle: "border-purple-200 bg-purple-50/60 hover:bg-purple-50 dark:border-purple-800/40 dark:bg-purple-950/20 dark:hover:bg-purple-950/30",
    active: "border-purple-500 bg-purple-100 dark:border-purple-400 dark:bg-purple-950/50",
  },
};

// ─────────────────────────────────────────────────────────────
// Inline error banner — shared between both form modes
// ─────────────────────────────────────────────────────────────
function ErrorBanner({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
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
      <span>{error}</span>
      <button
        type="button"
        onClick={onDismiss}
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
  );
}

// ─────────────────────────────────────────────────────────────
// Main LoginForm
// ─────────────────────────────────────────────────────────────

export function LoginForm({ sessionId, clubSlug }: LoginFormProps = {}) {
  const router = useRouter();

  // ── Mode toggle ───────────────────────────────────────────
  const [mode, setMode] = useState<LoginMode>("new");

  // ── New Player state ──────────────────────────────────────
  const [newError, setNewError] = useState<string | null>(null);
  const [newIsPending, startNewTransition] = useTransition();
  const [nameValue, setNameValue] = useState("");
  const [skillLevel, setSkillLevel] = useState("beginner");
  const [showPin, setShowPin] = useState(false);

  // ── Returning Player state ────────────────────────────────
  const [reconnectName, setReconnectName] = useState("");
  const [reconnectPin, setReconnectPin] = useState("");
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const [reconnectIsPending, startReconnectTransition] = useTransition();
  // Set when the reconnected account has Google linked — prompts the player
  // to use "Continue with Google" above instead of the PIN form.
  const [googleHint, setGoogleHint] = useState(false);

  // Prefetch /play so the redirect after login is instant.
  useEffect(() => {
    router.prefetch(sessionId ? `/play/${sessionId}` : "/play");
  }, [router, sessionId]);

  // Auto-dismiss error toasts after 8 s — courtside, player may be looking away.
  useEffect(() => {
    if (newError) {
      const id = setTimeout(() => setNewError(null), 8000);
      return () => clearTimeout(id);
    }
  }, [newError]);

  useEffect(() => {
    if (reconnectError) {
      const id = setTimeout(() => setReconnectError(null), 8000);
      return () => clearTimeout(id);
    }
  }, [reconnectError]);

  // ── Handlers ──────────────────────────────────────────────

  function handleNewPlayerSubmit(formData: FormData) {
    setNewError(null);
    startNewTransition(async () => {
      const result = await signInAnonymously(formData);
      if (result?.error) {
        setNewError(result.error);
      }
    });
  }

  function handleReconnect() {
    setReconnectError(null);
    setGoogleHint(false);
    if (!reconnectName.trim() || reconnectPin.length !== 4) {
      setReconnectError("Name and a 4-digit PIN are required.");
      return;
    }
    startReconnectTransition(async () => {
      const result = await reconnectPlayer(reconnectName.trim(), reconnectPin, clubSlug);
      if (!result.success) {
        setReconnectError(result.error ?? "Reconnect failed. Check your name and PIN.");
        if (result.useGoogleSignIn) setGoogleHint(true);
      } else {
        if (result.wrappedUrl) {
          router.push(result.wrappedUrl);
        } else if (result.sessionId) {
          router.push(
            clubSlug ? clubPlay(clubSlug, result.sessionId) : `/play/${result.sessionId}`
          );
        } else {
          router.push(clubSlug ? clubBase(clubSlug) : "/play");
        }
      }
    });
  }

  // ── Tab toggle ────────────────────────────────────────────

  function handleModeSwitch(next: LoginMode) {
    setMode(next);
    // Clear errors when switching tabs so we don't carry stale state
    setNewError(null);
    setReconnectError(null);
    setGoogleHint(false);
  }

  // Arrow-key navigation for the tablist (ARIA APG pattern).
  // ArrowRight focuses RETURNING; ArrowLeft focuses NEW PLAYER.
  function handleTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      handleModeSwitch("returning");
      (document.getElementById("tab-returning") as HTMLButtonElement | null)?.focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      handleModeSwitch("new");
      (document.getElementById("tab-new") as HTMLButtonElement | null)?.focus();
    }
  }

  // ─────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────

  return (
    <div className="w-full max-w-sm sm:max-w-md space-y-5">
      {/* ── Google sign-in — top of form, optional fast path ── */}
      {/* Outlined (not filled) — signals convenient shortcut, not mandatory primary action */}
      <GoogleSignInButton
        next={
          clubSlug
            ? sessionId
              ? clubPlay(clubSlug, sessionId)
              : clubBase(clubSlug)
            : sessionId
              ? `/play/${sessionId}`
              : "/play"
        }
        clubSlug={clubSlug}
        dividerPosition="below"
      />

      {/* ── PIN-holder note — bridges Google button & tab choice ── */}
      {/* Shown only when OAuth is live. RotateCcw icon echoes the RETURNING
          tab label, creating a visual link without needing an arrow. The mono
          chip mirrors a keyboard-key aesthetic consistent with the sporty HUD
          design language — not a generic help card. */}
      {process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === "true" && (
        <div className="flex items-start gap-2">
          <RotateCcw
            className="mt-px h-3 w-3 shrink-0 text-muted-foreground/50"
            aria-hidden="true"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Played here before? Sign back in using the{" "}
            <span
              className="inline-flex items-center rounded bg-muted px-1.5 py-0.5
                         font-mono text-[10px] font-semibold text-foreground"
            >
              RETURNING
            </span>{" "}
            tab below — then link Google from inside the app.
          </p>
        </div>
      )}

      {/* ── Segmented toggle — NEW PLAYER / RETURNING ──────── */}
      {/* This is the first element — returning players see their path
          immediately without scrolling past the entire new-player form. */}
      <div
        role="tablist"
        aria-label="Login mode"
        className="grid grid-cols-2 rounded-xl border border-border bg-muted/40 p-1 gap-1"
      >
        <button
          role="tab"
          aria-selected={mode === "new"}
          id="tab-new"
          type="button"
          tabIndex={mode === "new" ? 0 : -1}
          onClick={() => handleModeSwitch("new")}
          onKeyDown={handleTabKeyDown}
          className={`flex cursor-pointer flex-col items-center gap-0.5 rounded-lg px-3 py-3
                      text-sm font-semibold transition-all duration-150
                      ${
                        mode === "new"
                          ? "bg-background text-foreground shadow-sm ring-1 ring-border/50"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
        >
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          <span>NEW PLAYER</span>
          <span className="text-[10px] font-normal tracking-wide opacity-70">First time here</span>
        </button>

        <button
          role="tab"
          aria-selected={mode === "returning"}
          id="tab-returning"
          type="button"
          tabIndex={mode === "returning" ? 0 : -1}
          onClick={() => handleModeSwitch("returning")}
          onKeyDown={handleTabKeyDown}
          className={`flex cursor-pointer flex-col items-center gap-0.5 rounded-lg px-3 py-3
                      text-sm font-semibold transition-all duration-150
                      ${
                        mode === "returning"
                          ? "bg-background text-foreground shadow-sm ring-1 ring-border/50"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          <span>RETURNING</span>
          <span className="text-[10px] font-normal tracking-wide opacity-70">I have a PIN</span>
        </button>
      </div>

      {/* ── NEW PLAYER panel ───────────────────────────────── */}
      {mode === "new" && (
        <form
          id="panel-new"
          role="tabpanel"
          aria-labelledby="tab-new"
          action={handleNewPlayerSubmit}
          className="space-y-5 animate-in fade-in duration-150"
        >
          {/* ── Trust badge — anonymous-first framing ─────────── */}
          {/* Answers "do I need an account?" before the form starts */}
          <div className="flex items-center justify-center gap-4 py-0.5" aria-hidden="true">
            {(["No email", "No password", "Just a PIN"] as const).map((label) => (
              <span key={label} className="flex items-center gap-1 text-xs text-muted-foreground">
                <svg
                  className="h-3 w-3 shrink-0 text-emerald-500"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2 6l3 3 5-5" />
                </svg>
                {label}
              </span>
            ))}
          </div>

          {/* ── Name ─────────────────────────────────────────── */}
          <div className="space-y-2">
            <label htmlFor="display_name" className="block text-sm font-semibold text-foreground">
              Your Name
            </label>
            <input
              id="display_name"
              name="display_name"
              type="text"
              required
              autoFocus
              disabled={newIsPending}
              maxLength={30}
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              placeholder="e.g. Miggy, Stelle, Carlo B"
              autoComplete="nickname"
              className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                         placeholder:text-muted-foreground focus:outline-none focus:ring-2
                         focus:ring-ring focus:ring-offset-2 disabled:opacity-50"
            />
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Pick a name you won&apos;t mind your friends shouting across the court!
              </p>
              {nameValue.length > 0 && (
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
              )}
            </div>
          </div>

          {/* ── Skill Level — radio card grid ─────────────────── */}
          <fieldset className="space-y-2 border-0 p-0 m-0">
            <legend className="block text-sm font-semibold text-foreground">Skill Level</legend>
            <input type="hidden" name="skill_level" value={skillLevel} />
            <div
              className={`grid grid-cols-2 gap-2 ${
                newIsPending ? "pointer-events-none opacity-50" : ""
              }`}
            >
              {SKILL_LEVELS.map((level) => {
                const colors = SKILL_COLORS[level.value];
                const isSelected = skillLevel === level.value;
                return (
                  <label
                    key={level.value}
                    className={`relative flex min-h-[56px] cursor-pointer flex-col justify-center
                                gap-0.5 rounded-lg border-2 px-3 py-2.5 transition-colors
                                ${isSelected ? colors.active : colors.idle}`}
                  >
                    <input
                      type="radio"
                      name="skill_level_radio"
                      value={level.value}
                      checked={isSelected}
                      onChange={() => setSkillLevel(level.value)}
                      disabled={newIsPending}
                      className="sr-only"
                    />
                    <span
                      className={`absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full ${colors.dot}`}
                      aria-hidden="true"
                    />
                    <span className="text-sm font-semibold leading-tight text-foreground">
                      {level.label}
                    </span>
                    <span className="text-xs leading-snug text-muted-foreground">
                      {colors.descriptor}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* ── 4-digit PIN ───────────────────────────────────── */}
          <div className="space-y-2 pt-3">
            <label htmlFor="pin" className="block text-sm font-semibold text-foreground">
              Choose a 4-Digit PIN
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
                disabled={newIsPending}
                placeholder="1 2 3 4"
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
                disabled={newIsPending}
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
              You&apos;ll use this PIN to rejoin if you lose your session. Pick something
              you&apos;ll remember.
            </p>
          </div>

          {/* Hidden session_id — routes redirect to /play/[id] after login */}
          {sessionId && <input type="hidden" name="session_id" value={sessionId} />}
          {/* Hidden club_slug — QR join: enroll in the club + route to /c/[slug]/play/[id] */}
          {clubSlug && <input type="hidden" name="club_slug" value={clubSlug} />}

          {/* ── Error ─────────────────────────────────────────── */}
          {newError && <ErrorBanner error={newError} onDismiss={() => setNewError(null)} />}

          {/* ── Submit ───────────────────────────────────────── */}
          <button
            type="submit"
            disabled={newIsPending}
            className="flex min-h-[52px] w-full cursor-pointer items-center justify-center
                       gap-2 rounded-lg bg-amber-500 px-4 py-4 text-base font-semibold
                       text-[#0E1C3A] transition-colors hover:bg-amber-600
                       disabled:cursor-not-allowed disabled:opacity-70"
          >
            {newIsPending && <Spinner />}
            {newIsPending ? "Joining…" : sessionId ? "Join Session" : "Join Queue"}
          </button>
        </form>
      )}

      {/* ── RETURNING panel ────────────────────────────────── */}
      {mode === "returning" && (
        <div
          id="panel-returning"
          role="tabpanel"
          aria-labelledby="tab-returning"
          className="space-y-5 animate-in fade-in duration-150"
        >
          {/* Heading copy — sets expectation for what happens next */}
          <div className="space-y-1 pt-1">
            <p className="text-base font-semibold text-foreground">Welcome back.</p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Enter the name and PIN you used when you first joined.
            </p>
          </div>

          {/* ── Name ─────────────────────────────────────────── */}
          <div className="space-y-2">
            <label htmlFor="reconnect_name" className="block text-sm font-semibold text-foreground">
              Your Name
            </label>
            <input
              id="reconnect_name"
              type="text"
              value={reconnectName}
              onChange={(e) => setReconnectName(e.target.value)}
              disabled={reconnectIsPending}
              autoFocus
              maxLength={30}
              placeholder="e.g. Miggy"
              autoComplete="nickname"
              className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                         placeholder:text-muted-foreground focus:outline-none focus:ring-2
                         focus:ring-ring focus:ring-offset-2 disabled:opacity-50"
            />
          </div>

          {/* ── PIN ──────────────────────────────────────────── */}
          <div className="space-y-2">
            <label htmlFor="reconnect_pin" className="block text-sm font-semibold text-foreground">
              Your PIN
            </label>
            <input
              id="reconnect_pin"
              type="tel"
              inputMode="numeric"
              maxLength={4}
              value={reconnectPin}
              onChange={(e) => setReconnectPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              disabled={reconnectIsPending}
              placeholder="1 2 3 4"
              autoComplete="off"
              className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                         tracking-[0.3em] text-center font-mono
                         placeholder:text-muted-foreground placeholder:tracking-normal
                         focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2
                         disabled:opacity-50"
            />
          </div>

          {/* ── Google sign-in hint — shown when PIN reconnect detects a Google-linked account */}
          {googleHint && (
            <div
              role="status"
              className="flex items-start gap-2.5 rounded-lg border border-sky-200 bg-sky-50/80
                         px-3 py-2.5 text-sm dark:border-sky-800/40 dark:bg-sky-950/30"
            >
              <svg
                className="mt-0.5 h-4 w-4 shrink-0 text-sky-500"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
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
              <p className="text-sky-700 dark:text-sky-300 leading-snug">
                This account uses Google sign-in.
                <br />
                Use <strong>Continue with Google</strong> above to sign back in.
              </p>
            </div>
          )}

          {/* ── Error ─────────────────────────────────────────── */}
          {reconnectError && !googleHint && (
            <ErrorBanner error={reconnectError} onDismiss={() => setReconnectError(null)} />
          )}

          {/* ── RECONNECT CTA ─────────────────────────────────── */}
          <button
            type="button"
            onClick={handleReconnect}
            disabled={reconnectIsPending || !reconnectName.trim() || reconnectPin.length !== 4}
            className="flex min-h-[52px] w-full cursor-pointer items-center justify-center
                       gap-2 rounded-lg bg-amber-500 px-4 py-4 text-base font-semibold
                       text-[#0E1C3A] transition-colors hover:bg-amber-600
                       disabled:cursor-not-allowed disabled:opacity-70"
          >
            {reconnectIsPending && <Spinner />}
            {reconnectIsPending ? "Reconnecting…" : "Reconnect"}
          </button>
        </div>
      )}
    </div>
  );
}
