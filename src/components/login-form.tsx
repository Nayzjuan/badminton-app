"use client";

// ============================================================
// Login Form — Name + Skill Level entry for anonymous auth
// ============================================================
// Uses useTransition for non-blocking form submission with
// immediate loading feedback. Prefetches /play on mount so
// the post-login navigation is near-instant.
// ============================================================

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signInAnonymously } from "@/app/actions/auth";
import { SKILL_LEVELS } from "@/types/database";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Prefetch /play so the redirect after login is instant.
  useEffect(() => {
    router.prefetch("/play");
  }, [router]);

  // Auto-dismiss error toast after 5 seconds.
  useEffect(() => {
    if (error) {
      const id = setTimeout(() => setError(null), 5000);
      errorTimeoutRef.current = id;
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
      // On success, the server action redirects to /play.
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
            placeholder="e.g. Miggy"
            className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                       placeholder:text-muted-foreground focus:outline-none focus:ring-2
                       focus:ring-ring focus:ring-offset-2 disabled:opacity-50"
          />
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

        {/* Submit */}
        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded-lg bg-primary px-4 py-3 text-base font-semibold
                     text-primary-foreground transition-colors hover:bg-primary/90
                     disabled:opacity-70 disabled:cursor-not-allowed
                     flex items-center justify-center gap-2"
        >
          {isPending && (
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
          )}
          {isPending ? "Joining..." : "Enter"}
        </button>
      </form>

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
