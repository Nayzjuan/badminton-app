"use client";

// ============================================================
// ChangeDisplayName — self-serve name (and skill) editor
// ============================================================
// Used on My Status and the session-picker greeting. Same validation
// ladder as /rename confirm: Zod → uniqueness (self excluded) →
// renamePlayer (audit reason self_chosen when no flags are set).
// ============================================================

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Loader2, UserPen } from "lucide-react";
import { displayNameSchema } from "@/lib/schemas/auth";
import { checkNameAvailable, renamePlayer } from "@/app/actions/rename";
import { SkillLevelPicker } from "@/components/player/skill-level-picker";
import type { SkillLevel } from "@/types/database";

interface ChangeDisplayNameProps {
  currentName: string;
  currentSkill: SkillLevel;
  compact?: boolean;
}

type Phase = "invalid" | "checking" | "taken" | "ok";

export function ChangeDisplayName({
  currentName,
  currentSkill,
  compact = false,
}: ChangeDisplayNameProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentName);
  const [skill, setSkill] = useState<SkillLevel>(currentSkill);
  const [phase, setPhase] = useState<Phase>("ok");
  const [message, setMessage] = useState<string | undefined>();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function openEditor() {
    setValue(currentName);
    setSkill(currentSkill);
    setPhase("ok");
    setMessage(undefined);
    setSubmitError(null);
    setOpen(true);
  }

  function runChecks(raw: string) {
    setSubmitError(null);
    seqRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
    const parsed = displayNameSchema.safeParse(raw);
    if (!parsed.success) {
      setPhase("invalid");
      setMessage(parsed.error.issues[0].message);
      return;
    }
    setPhase("checking");
    const seq = seqRef.current;
    timerRef.current = setTimeout(async () => {
      const result = await checkNameAvailable(parsed.data);
      if (seq !== seqRef.current) return;
      if (result.available) {
        setPhase("ok");
        setMessage(undefined);
      } else {
        setPhase(result.code === "taken" ? "taken" : "invalid");
        setMessage(result.message);
      }
    }, 400);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (phase !== "ok" || isPending) return;
    startTransition(async () => {
      const result = await renamePlayer(value, skill);
      if (result.success) {
        setOpen(false);
        router.refresh();
        return;
      }
      if (result.code === "taken" || result.code === "invalid") {
        setPhase(result.code === "taken" ? "taken" : "invalid");
        setMessage(result.error);
      } else {
        setSubmitError(result.error);
      }
    });
  }

  const canSubmit = phase === "ok" && !isPending;
  const isError = phase === "invalid" || phase === "taken";

  if (!open) {
    return (
      <button
        type="button"
        onClick={openEditor}
        className={
          compact
            ? "text-xs font-semibold text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
            : "inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
        }
      >
        {!compact && <UserPen className="h-4 w-4" aria-hidden="true" />}
        Change display name
      </button>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-xl border border-border bg-card p-3"
      noValidate
    >
      <div className="space-y-1.5">
        <label htmlFor="change-name-input" className="block text-sm font-medium text-foreground">
          Display name
        </label>
        <input
          id="change-name-input"
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            runChecks(e.target.value);
          }}
          autoComplete="off"
          autoCapitalize="words"
          aria-invalid={isError}
          className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/40"
        />
        <p
          role="status"
          aria-live="polite"
          className={`flex min-h-[1.25rem] items-start gap-1.5 text-sm ${
            phase === "ok"
              ? "text-emerald-700 dark:text-emerald-400"
              : isError
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground"
          }`}
        >
          {isError && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
          {phase === "ok" && (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span>
            {phase === "checking" && "Checking if that name is free…"}
            {phase === "ok" && "Looks good."}
            {isError && message}
          </span>
        </p>
      </div>

      <SkillLevelPicker value={skill} onChange={setSkill} disabled={isPending} />

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-amber-500 px-3 text-sm font-semibold text-[#0E1C3A] disabled:opacity-50"
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setValue(currentName);
            setSkill(currentSkill);
            setPhase("ok");
            setSubmitError(null);
          }}
          className="min-h-[44px] rounded-xl border border-border px-3 text-sm text-muted-foreground"
        >
          Cancel
        </button>
      </div>
      {submitError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {submitError}
        </p>
      )}
    </form>
  );
}
