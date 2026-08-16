"use client";

// ============================================================
// EditMatchDialog — Organizer score correction + revert to active
// ============================================================

import { Pencil, RotateCcw } from "lucide-react";
import { useEditMatch } from "@/hooks/use-edit-match";
import { MAX_BADMINTON_SCORE } from "@/lib/constants";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type EditMatchDialogProps = {
  matchId: string;
  initialScoreA: number;
  initialScoreB: number;
};

export function EditMatchDialog({ matchId, initialScoreA, initialScoreB }: EditMatchDialogProps) {
  const {
    open,
    scoreA,
    scoreB,
    setScoreA,
    setScoreB,
    message,
    isError,
    savedOnce,
    isPending,
    handleOpenChange,
    handleSaveScore,
    handleRevert,
  } = useEditMatch(matchId, initialScoreA, initialScoreB);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          className="flex items-center gap-1 rounded-lg px-3 py-2 min-h-[44px] text-[11px] font-medium
                     text-slate-400 hover:text-slate-700 hover:bg-slate-100
                     dark:text-muted-foreground dark:hover:text-foreground dark:hover:bg-muted
                     transition-colors"
          title="Edit scores or revert match"
          aria-label="Edit match scores"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>Edit Match Score</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* Score inputs */}
          <div className="flex items-center gap-3">
            <div className="flex-1 space-y-1 text-center">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
                Team A
              </p>
              {/* max is the server's real bound (scoreSchema in @/lib/schemas/match
                  rejects anything over MAX_BADMINTON_SCORE), not a round 99. The
                  attribute alone does not block typing 32 — useEditMatch does that
                  at submit time — but the stepper and the browser's own validity
                  UI should not advertise a ceiling the server will refuse. */}
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_BADMINTON_SCORE}
                value={scoreA}
                onChange={(e) => setScoreA(e.target.value)}
                disabled={isPending}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5
                           text-center text-2xl font-black tabular-nums text-slate-900
                           dark:border-border dark:bg-input dark:text-foreground
                           focus:outline-none focus:ring-2 focus:ring-ring
                           disabled:opacity-50"
              />
            </div>
            <span className="text-sm font-bold text-slate-300 dark:text-muted-foreground/50 mt-5">
              –
            </span>
            <div className="flex-1 space-y-1 text-center">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
                Team B
              </p>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_BADMINTON_SCORE}
                value={scoreB}
                onChange={(e) => setScoreB(e.target.value)}
                disabled={isPending}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5
                           text-center text-2xl font-black tabular-nums text-slate-900
                           dark:border-border dark:bg-input dark:text-foreground
                           focus:outline-none focus:ring-2 focus:ring-ring
                           disabled:opacity-50"
              />
            </div>
          </div>

          {/* Feedback message */}
          {message && (
            <p className={`text-center text-xs ${isError ? "text-red-600" : "text-emerald-600"}`}>
              {message}
            </p>
          )}

          {/* Save score. The dialog stays open after a successful save so the
              scores can be corrected again immediately — see useEditMatch. */}
          <button
            onClick={handleSaveScore}
            disabled={isPending}
            className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold
                       text-white hover:bg-slate-800 transition-colors
                       dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? "Saving…" : savedOnce ? "Save Again" : "Save Score"}
          </button>

          {savedOnce && !isPending && (
            <>
              <p className="text-center text-[10px] text-slate-400 dark:text-muted-foreground">
                Still not right? Change the numbers and save again — you can correct a score as many
                times as you need.
              </p>
              <DialogClose asChild>
                <button
                  className="w-full rounded-xl border border-slate-200 dark:border-border px-4 py-2
                             text-xs font-semibold text-slate-600 dark:text-muted-foreground
                             hover:bg-slate-50 dark:hover:bg-muted transition-colors"
                >
                  Done
                </button>
              </DialogClose>
            </>
          )}

          {/* Divider */}
          <div className="flex items-center gap-2">
            <div className="flex-1 border-t border-slate-100 dark:border-border" />
            <span className="text-[10px] text-slate-400 dark:text-muted-foreground uppercase tracking-widest">
              or
            </span>
            <div className="flex-1 border-t border-slate-100 dark:border-border" />
          </div>

          {/* Revert to active */}
          <button
            onClick={handleRevert}
            disabled={isPending}
            className="w-full flex items-center justify-center gap-2 rounded-xl border
                       border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold
                       text-amber-800 hover:bg-amber-100 transition-colors
                       dark:border-[hsl(var(--amber-accent-hsl))]/50 dark:bg-[hsl(var(--amber-accent-hsl))]/10
                       dark:text-[hsl(var(--amber-accent-hsl))] dark:hover:bg-[hsl(var(--amber-accent-hsl))]/20
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw className="h-4 w-4" />
            {isPending ? "Reverting…" : "Revert to Active Court"}
          </button>
          <p className="text-center text-[10px] text-slate-400 dark:text-muted-foreground">
            Use this if a score was submitted by accident. The match returns to the Active Courts
            view and players can re-submit.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
