"use client";

// ============================================================
// RenameScreen — forced duplicate-name resolution (player view)
// ============================================================
// Full-screen, non-dismissible step. A flagged player picks a unique
// name before continuing. Validation ladder, mirrored from the server:
//   shape (Zod) → R1 (can't reuse the duplicated name, per keystroke,
//   amber guidance) → R2 (global uniqueness, debounced async, red error).
// The partial UNIQUE index is the real authority at submit time.
//
// a11y: real <label>, visible focus rings, aria-invalid + aria-describedby,
// aria-live feedback, focus starts on the heading (so the "why" is announced
// first), every state cue is icon + text (never colour-only), 44px targets.
// Concurrency: a monotonic seqRef invalidates stale async checks (the
// fetchSeq guardrail), so a slow earlier response can't overwrite a newer one.
// ============================================================

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Loader2, RotateCcw, UserPen } from "lucide-react";
import { displayNameSchema } from "@/lib/schemas/auth";
import { normalizeName } from "@/lib/normalize-name";
import { checkNameAvailable, renamePlayer } from "@/app/actions/rename";

type Phase = "reused" | "invalid" | "checking" | "taken" | "ok";

interface CheckState {
  phase: Phase;
  message?: string;
}

interface RenameScreenProps {
  /** The duplicated name being disambiguated (R1 forbids reusing it). */
  collidedName: string;
  /** Internal path to navigate to once the rename succeeds. */
  next: string;
}

export function RenameScreen({ collidedName, next }: RenameScreenProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Prefill with the stem + trailing space so the player just appends.
  const initialValue = `${collidedName} `;
  const [value, setValue] = useState(initialValue);

  // Sync evaluation: shape → R1. Returns "async" when R2 (DB) is needed.
  function evaluateSync(raw: string): CheckState | "async" {
    const parsed = displayNameSchema.safeParse(raw);
    if (!parsed.success) {
      return { phase: "invalid", message: parsed.error.issues[0].message };
    }
    if (normalizeName(parsed.data) === normalizeName(collidedName)) {
      return {
        phase: "reused",
        message: `That's the name we need to change. Add an initial or number — e.g. "${collidedName} L".`,
      };
    }
    return "async";
  }

  // The prefilled value IS the duplicated name → starts in the R1 "reused"
  // state with the guidance visible from first paint (a11y: the disabled
  // submit always has an announced reason).
  const [check, setCheck] = useState<CheckState>(() => {
    const sync = evaluateSync(initialValue);
    return sync === "async" ? { phase: "checking" } : sync;
  });
  const [submitError, setSubmitError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Announce the "why" first: focus the heading on mount.
  useEffect(() => {
    headingRef.current?.focus();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function runChecks(raw: string) {
    setSubmitError(null);
    // Invalidate any in-flight async check immediately.
    seqRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);

    const sync = evaluateSync(raw);
    if (sync !== "async") {
      setCheck(sync);
      return;
    }

    setCheck({ phase: "checking" });
    const seq = seqRef.current;
    timerRef.current = setTimeout(async () => {
      const parsed = displayNameSchema.safeParse(raw);
      if (!parsed.success) return;
      const result = await checkNameAvailable(parsed.data);
      if (seq !== seqRef.current) return; // stale — a newer keystroke superseded this
      if (result.available) {
        setCheck({ phase: "ok" });
      } else {
        setCheck({
          phase:
            result.code === "taken" ? "taken" : result.code === "reused" ? "reused" : "invalid",
          message: result.message,
        });
      }
    }, 400);
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setValue(v);
    runChecks(v);
  }

  function applyChip(suffix: string) {
    const v = `${collidedName} ${suffix}`;
    setValue(v);
    runChecks(v);
    inputRef.current?.focus();
    // Move caret to end.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (check.phase !== "ok" || isPending) return;
    startTransition(async () => {
      const result = await renamePlayer(value);
      if (result.success) {
        router.push(next);
        router.refresh();
        return;
      }
      // Keep the typed value; surface a recoverable error and refocus.
      if (result.code === "taken" || result.code === "reused" || result.code === "invalid") {
        setCheck({
          phase: result.code === "invalid" ? "invalid" : result.code,
          message: result.error,
        });
      } else {
        setSubmitError(result.error);
      }
      inputRef.current?.focus();
    });
  }

  const canSubmit = check.phase === "ok" && !isPending;
  const isError = check.phase === "invalid" || check.phase === "taken";
  const feedbackId = "rename-feedback";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#FAFAF7] px-6 py-12 dark:bg-background">
      <div className="w-full max-w-sm space-y-7">
        {/* Explainer */}
        <div className="space-y-3 text-center">
          <span className="mx-auto inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">
            <UserPen className="h-3.5 w-3.5" aria-hidden="true" />
            Quick setup
          </span>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-black tracking-tight text-foreground outline-none"
          >
            Make your name yours
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Another player also uses{" "}
            <span className="font-semibold text-foreground">&ldquo;{collidedName}&rdquo;</span>.
            Pick a unique name so your stats, leaderboard, and head-to-head records stay yours.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="rename-input" className="block text-sm font-medium text-foreground">
              Your new name
            </label>
            <div className="relative">
              <input
                id="rename-input"
                ref={inputRef}
                type="text"
                value={value}
                onChange={onChange}
                autoComplete="off"
                autoCapitalize="words"
                aria-invalid={isError || check.phase === "reused"}
                aria-busy={check.phase === "checking"}
                aria-describedby={feedbackId}
                className="w-full rounded-xl border border-input bg-background px-4 py-3 text-base text-foreground shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/40"
              />
              {check.phase === "checking" && (
                <Loader2
                  className="absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 animate-spin text-muted-foreground motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              {check.phase === "ok" && (
                <CheckCircle2
                  className="absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
              )}
            </div>

            {/* Quick suggestion chips */}
            <div className="flex flex-wrap gap-2 pt-1">
              {["L", "2", "B"].map((suffix) => (
                <button
                  key={suffix}
                  type="button"
                  onClick={() => applyChip(suffix)}
                  aria-label={`Use ${collidedName} ${suffix}`}
                  className="min-h-[44px] rounded-full border border-input bg-background px-3 py-1 text-sm text-muted-foreground transition hover:border-amber-500 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                >
                  {collidedName} {suffix}
                </button>
              ))}
            </div>

            {/* Feedback — always rendered for a stable aria-live region */}
            <p
              id={feedbackId}
              role="status"
              aria-live="polite"
              className={`flex min-h-[1.25rem] items-start gap-1.5 pt-1 text-sm ${
                check.phase === "ok"
                  ? "text-emerald-700 dark:text-emerald-400"
                  : check.phase === "reused"
                    ? "text-amber-700 dark:text-amber-400"
                    : isError
                      ? "text-red-600 dark:text-red-400"
                      : "text-muted-foreground"
              }`}
            >
              {check.phase === "reused" && (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              {isError && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
              {check.phase === "ok" && (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>
                {check.phase === "checking" && "Checking if that name is free…"}
                {check.phase === "ok" && "Looks good — that name is free."}
                {(check.phase === "reused" ||
                  check.phase === "invalid" ||
                  check.phase === "taken") &&
                  check.message}
              </span>
            </p>
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            aria-describedby={feedbackId}
            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-3 text-base font-semibold text-[#0E1C3A] shadow-sm transition hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-500/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? (
              <>
                <Loader2
                  className="h-5 w-5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Saving…
              </>
            ) : (
              "Save name"
            )}
          </button>

          {submitError && (
            <p
              role="alert"
              aria-live="assertive"
              className="flex items-center justify-center gap-2 text-sm text-red-600 dark:text-red-400"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {submitError}
            </p>
          )}
        </form>
      </div>
    </main>
  );
}
