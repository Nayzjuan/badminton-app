"use client";

// ============================================================
// Login Form — Name + Skill Level entry for anonymous auth
// ============================================================

import { useState } from "react";
import { signInAnonymously } from "@/app/actions/auth";
import { SKILL_LEVELS, type SkillLevel } from "@/types/database";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError(null);
    const result = await signInAnonymously(formData);
    if (result?.error) {
      setError(result.error);
      setLoading(false);
    }
    // On success, the server action redirects to /play.
  }

  return (
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
          placeholder="e.g. Miggy"
          className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                     placeholder:text-muted-foreground focus:outline-none focus:ring-2
                     focus:ring-ring focus:ring-offset-2"
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
          defaultValue="beginner"
          className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base
                     text-foreground focus:outline-none focus:ring-2 focus:ring-ring
                     focus:ring-offset-2 appearance-none"
        >
          {SKILL_LEVELS.map((level) => (
            <option key={level.value} value={level.value}>
              {level.label}
            </option>
          ))}
        </select>
      </div>

      {/* Error Display */}
      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-primary px-4 py-3 text-base font-semibold
                   text-primary-foreground transition-colors hover:bg-primary/90
                   disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? "Joining..." : "Enter"}
      </button>
    </form>
  );
}
