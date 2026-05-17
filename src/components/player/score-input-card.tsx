"use client";

// ============================================================
// ScoreInputCard — lets any player in the match submit the score
// ============================================================

import { CheckCircle2, BarChart2 } from "lucide-react";
import { submitMatchScore } from "@/app/actions/match-lifecycle";
import { sanitizeScore } from "@/lib/score-input";
import { useScoreForm } from "@/hooks/use-score-form";

interface ScoreInputCardProps {
  matchId: string;
  myTeam: "a" | "b";
}

export function ScoreInputCard({ matchId, myTeam }: ScoreInputCardProps) {
  const {
    teamAScore,
    setTeamAScore,
    teamBScore,
    setTeamBScore,
    error,
    submitted,
    isPending,
    handleSubmit,
  } = useScoreForm(async (a, b) => {
    const result = await submitMatchScore(matchId, a, b);
    return { error: result.success ? undefined : (result.message ?? "Failed to submit score.") };
  });

  const myScoreLabel = myTeam === "a" ? "Your Team" : "Opponents";
  const theirScoreLabel = myTeam === "a" ? "Opponents" : "Your Team";
  const myScoreValue = myTeam === "a" ? teamAScore : teamBScore;
  const theirScoreValue = myTeam === "a" ? teamBScore : teamAScore;

  // Sanitize-only (no clamping). The previous clamp made editing impossible:
  // a user with "30" who wanted "29" couldn't lower it — every intermediate
  // value above 30 re-clamped back to "30", trapping the field. We now allow
  // any 0–999 input; range validation runs only at submit time.
  function handleMyScore(val: string) {
    const clean = sanitizeScore(val);
    if (myTeam === "a") setTeamAScore(clean);
    else setTeamBScore(clean);
  }
  function handleTheirScore(val: string) {
    const clean = sanitizeScore(val);
    if (myTeam === "a") setTeamBScore(clean);
    else setTeamAScore(clean);
  }

  if (submitted) {
    return (
      <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 px-5 py-4 text-center">
        <div className="flex items-center justify-center gap-2 text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <p className="text-sm font-semibold">Score submitted! Returning you to queue…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="border-b border-slate-100 dark:border-border bg-slate-50 dark:bg-muted px-4 py-3">
        <div className="flex items-center gap-2">
          <BarChart2
            className="h-3.5 w-3.5 text-slate-400 dark:text-muted-foreground"
            aria-hidden="true"
          />
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
            Submit Final Score
          </p>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4">
        {/* Score inputs */}
        <div className="flex items-center gap-3">
          {/* My team score */}
          <div className="flex-1 text-center space-y-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              {myScoreLabel}
            </p>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={3}
              value={myScoreValue}
              onChange={(e) => handleMyScore(e.target.value)}
              disabled={isPending}
              placeholder="0"
              aria-label={`${myScoreLabel} score`}
              className="w-full rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-background px-3 py-3
                         text-center text-2xl font-black tabular-nums text-slate-900 dark:text-foreground
                         focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:focus:ring-emerald-500
                         disabled:opacity-50"
            />
          </div>

          <span className="text-lg font-bold text-slate-300 dark:text-muted-foreground mt-5">
            –
          </span>

          {/* Their team score */}
          <div className="flex-1 text-center space-y-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
              {theirScoreLabel}
            </p>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={3}
              value={theirScoreValue}
              onChange={(e) => handleTheirScore(e.target.value)}
              disabled={isPending}
              placeholder="0"
              aria-label={`${theirScoreLabel} score`}
              className="w-full rounded-xl border border-slate-200 dark:border-border bg-white dark:bg-background px-3 py-3
                         text-center text-2xl font-black tabular-nums text-slate-900 dark:text-foreground
                         focus:outline-none focus:ring-2 focus:ring-slate-400 dark:focus:ring-slate-500
                         disabled:opacity-50"
            />
          </div>
        </div>

        {/* Error */}
        {error && <p className="text-center text-xs text-red-600 dark:text-red-400">{error}</p>}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={isPending || !teamAScore || !teamBScore}
          className="w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold
                     text-white hover:bg-slate-800 transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed
                     flex items-center justify-center gap-2"
        >
          {isPending ? (
            <>
              <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
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
              Submitting…
            </>
          ) : (
            "Submit Final Score"
          )}
        </button>

        <p className="text-center text-[10px] text-muted-foreground">
          Any player in the match can submit. This ends the match for everyone.
        </p>
      </div>
    </div>
  );
}
