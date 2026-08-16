"use client";

// ============================================================
// ScoreCorrectionRequest — player asks the organizer to fix a score
// ============================================================
// Session history only. Submits team_a_score / team_b_score. One
// pending request per match; looking at it does not resolve it.

import { useState, useTransition } from "react";
import { requestScoreCorrection } from "@/app/actions/notifications";
import { MAX_BADMINTON_SCORE } from "@/lib/constants";
import { isPendingCorrectionStatus } from "@/lib/session-notifications";
import type { SessionNotification } from "@/types/database";

interface ScoreCorrectionRequestProps {
  matchId: string;
  teamALabel: string;
  teamBLabel: string;
  initialScoreA: number;
  initialScoreB: number;
  sessionActive: boolean;
  pending: SessionNotification | undefined;
  onSubmitted?: () => void;
}

export function ScoreCorrectionRequest({
  matchId,
  teamALabel,
  teamBLabel,
  initialScoreA,
  initialScoreB,
  sessionActive,
  pending,
  onSubmitted,
}: ScoreCorrectionRequestProps) {
  const [open, setOpen] = useState(false);
  const [scoreA, setScoreA] = useState(String(initialScoreA));
  const [scoreB, setScoreB] = useState(String(initialScoreB));
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (pending && isPendingCorrectionStatus(pending.status)) {
    const a = pending.payload.proposedScoreA;
    const b = pending.payload.proposedScoreB;
    return (
      <p className="mt-3 text-center text-xs text-muted-foreground">
        Correction requested
        {a != null && b != null ? ` (${a}–${b})` : ""}. Waiting for an organizer.
      </p>
    );
  }

  if (!sessionActive) return null;

  return (
    <div className="mt-3">
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setScoreA(String(initialScoreA));
            setScoreB(String(initialScoreB));
            setMessage(null);
            setIsError(false);
            setOpen(true);
          }}
          className="mx-auto flex min-h-[44px] items-center justify-center rounded-xl px-3
                     text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Request score correction
        </button>
      ) : (
        <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
          <p className="text-center text-xs font-medium text-foreground">
            Propose the correct scores. An organizer will review them.
          </p>
          <div className="flex items-center gap-3">
            <label className="flex-1 space-y-1 text-center">
              <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                {teamALabel}
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_BADMINTON_SCORE}
                value={scoreA}
                onChange={(e) => setScoreA(e.target.value)}
                disabled={isPending}
                className="w-full rounded-xl border border-border bg-background px-3 py-2.5
                           text-center text-2xl font-black tabular-nums focus:outline-none
                           focus:ring-2 focus:ring-ring disabled:opacity-50"
              />
            </label>
            <span className="mt-5 text-sm font-bold text-muted-foreground/50">–</span>
            <label className="flex-1 space-y-1 text-center">
              <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                {teamBLabel}
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_BADMINTON_SCORE}
                value={scoreB}
                onChange={(e) => setScoreB(e.target.value)}
                disabled={isPending}
                className="w-full rounded-xl border border-border bg-background px-3 py-2.5
                           text-center text-2xl font-black tabular-nums focus:outline-none
                           focus:ring-2 focus:ring-ring disabled:opacity-50"
              />
            </label>
          </div>
          {message && (
            <p className={`text-center text-xs ${isError ? "text-red-600" : "text-emerald-600"}`}>
              {message}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() => setOpen(false)}
              className="min-h-[44px] flex-1 rounded-xl border border-border px-3 text-xs
                         font-semibold text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                const a = parseInt(scoreA, 10);
                const b = parseInt(scoreB, 10);
                if (Number.isNaN(a) || Number.isNaN(b)) {
                  setMessage("Enter valid scores for both teams.");
                  setIsError(true);
                  return;
                }
                startTransition(async () => {
                  const result = await requestScoreCorrection(matchId, a, b);
                  setMessage(result.message ?? result.error ?? null);
                  setIsError(!result.success);
                  if (result.success) {
                    setOpen(false);
                    onSubmitted?.();
                  }
                });
              }}
              className="min-h-[44px] flex-1 rounded-xl bg-primary px-3 text-xs font-bold
                         text-primary-foreground hover:brightness-110 disabled:opacity-50"
            >
              {isPending ? "Sending…" : "Send request"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
