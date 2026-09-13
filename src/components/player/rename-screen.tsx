"use client";

// ============================================================
// RenameScreen — duplicate force-rename OR Google name confirm
// ============================================================
// mode="force": flagged duplicate. Prefill stem + space, R1 forbids
//   keeping collidedName, suffix chips.
// mode="confirm": first-run / backfilled Google. Prefill the assigned
//   name; keeping it is valid. Always shows the field so they can change
//   it, plus a skill picker (Google users default to beginner).
// ============================================================

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Loader2, RotateCcw, UserPen } from "lucide-react";
import { displayNameSchema } from "@/lib/schemas/auth";
import { normalizeName } from "@/lib/normalize-name";
import { evaluateRenameSync } from "@/lib/rename-decision";
import { checkNameAvailable, renamePlayer } from "@/app/actions/rename";
import { SkillLevelPicker } from "@/components/player/skill-level-picker";
import type { SkillLevel } from "@/types/database";

type Phase = "reused" | "invalid" | "checking" | "taken" | "ok";

interface CheckState {
  phase: Phase;
  message?: string;
}

export interface RenameScreenProps {
  mode: "force" | "confirm";
  currentName: string;
  next: string;
  currentSkill: SkillLevel;
}

export function RenameScreen({ mode, currentName, next, currentSkill }: RenameScreenProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const isConfirm = mode === "confirm";

  const initialValue = isConfirm ? currentName : `${currentName} `;
  const [value, setValue] = useState(initialValue);
  const [skill, setSkill] = useState<SkillLevel>(currentSkill);

  function evaluateSync(raw: string): CheckState | "async" {
    return evaluateRenameSync(raw, { mode, currentName });
  }

  const [check, setCheck] = useState<CheckState>(() => {
    const sync = evaluateSync(initialValue);
    return sync === "async" ? { phase: "checking" } : sync;
  });
  const [submitError, setSubmitError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
    if (isConfirm) {
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) el.setSelectionRange(0, el.value.length);
      });
    }
    if (isConfirm && evaluateSync(initialValue) === "async") {
      runChecks(initialValue);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // first paint only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function runChecks(raw: string) {
    setSubmitError(null);
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
      if (seq !== seqRef.current) return;
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
    const v = `${currentName} ${suffix}`;
    setValue(v);
    runChecks(v);
    inputRef.current?.focus();
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (check.phase !== "ok" || isPending) return;
    startTransition(async () => {
      const result = await renamePlayer(value, isConfirm ? skill : undefined);
      if (result.success) {
        router.push(next);
        router.refresh();
        return;
      }
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
  const keepingSame =
    isConfirm && normalizeName(value) === normalizeName(currentName) && check.phase === "ok";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#FAFAF7] px-6 py-12 dark:bg-background">
      <div className="w-full max-w-sm space-y-7">
        <div className="space-y-3 text-center">
          <span className="mx-auto inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">
            <UserPen className="h-3.5 w-3.5" aria-hidden="true" />
            {isConfirm ? "Your court name" : "Quick setup"}
          </span>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-black tracking-tight text-foreground outline-none"
          >
            {isConfirm ? "This is how you'll appear" : "Make your name yours"}
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {isConfirm ? (
              <>
                This is the name the queue, TV, and leaderboard will show. Keep it or change it —
                and confirm your skill level.
              </>
            ) : (
              <>
                Another player also uses{" "}
                <span className="font-semibold text-foreground">&ldquo;{currentName}&rdquo;</span>.
                Pick a unique name so your stats, leaderboard, and head-to-head records stay yours.
              </>
            )}
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="rename-input" className="block text-sm font-medium text-foreground">
              {isConfirm ? "Display name" : "Your new name"}
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

            {!isConfirm && (
              <div className="flex flex-wrap gap-2 pt-1">
                {["L", "2", "B"].map((suffix) => (
                  <button
                    key={suffix}
                    type="button"
                    onClick={() => applyChip(suffix)}
                    aria-label={`Use ${currentName} ${suffix}`}
                    className="min-h-[44px] rounded-full border border-input bg-background px-3 py-1 text-sm text-muted-foreground transition hover:border-amber-500 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  >
                    {currentName} {suffix}
                  </button>
                ))}
              </div>
            )}

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
                {check.phase === "ok" &&
                  (keepingSame
                    ? "This name is yours — continue or change it."
                    : "Looks good — that name is free.")}
                {(check.phase === "reused" ||
                  check.phase === "invalid" ||
                  check.phase === "taken") &&
                  check.message}
              </span>
            </p>
          </div>

          {isConfirm && <SkillLevelPicker value={skill} onChange={setSkill} disabled={isPending} />}

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
            ) : keepingSame ? (
              `Continue as ${currentName}`
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
