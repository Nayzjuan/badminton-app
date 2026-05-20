"use client";

// ============================================================
// ScoreModal — Score input dialog for ending a match
// ============================================================
// Built on the Shadcn-style Dialog wrappers in @/components/ui/dialog,
// which use @radix-ui/react-dialog internally.
//
// Radix Dialog.Portal renders the overlay + content directly
// into <body>, completely escaping any parent stacking context,
// overflow:hidden, or transform — the previous createPortal
// approach with a mounted guard was fragile; this is not.
//
// Usage:
//   <ScoreModal
//     open={!!scoringMatch}
//     match={scoringMatch}
//     onClose={() => setScoringMatch(null)}
//     onSubmit={handleEndMatch}
//   />
// ============================================================

import { useEffect, useRef } from "react";
import { DIALOG_FOCUS_DELAY_MS, MAX_BADMINTON_SCORE } from "@/lib/constants";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useScoreForm } from "@/hooks/use-score-form";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";

interface ScoreModalProps {
  /** Controls whether the dialog is visible. */
  open: boolean;
  /** The match being scored. May be null when dialog is animating closed. */
  match: EnrichedMatch | null;
  onSubmit: (teamAScore: number, teamBScore: number) => Promise<{ error?: string }>;
  onClose: () => void;
}

export function ScoreModal({ open, match, onSubmit, onClose }: ScoreModalProps) {
  const {
    teamAScore,
    setTeamAScore,
    teamBScore,
    setTeamBScore,
    error,
    isPending,
    handleSubmit,
    clearError,
  } = useScoreForm(async (a, b) => {
    const result = await onSubmit(a, b);
    return { error: result.error };
  });
  const teamARef = useRef<HTMLInputElement>(null);

  // Reset form each time the dialog opens for a new match.
  // clearError ensures a stale validation message from a previous
  // submission doesn't bleed into the next time the modal is opened.
  useEffect(() => {
    if (open) {
      setTeamAScore("");
      setTeamBScore("");
      clearError();
      // Small delay so Radix has finished its focus-trap setup.
      const t = setTimeout(() => teamARef.current?.focus(), DIALOG_FOCUS_DELAY_MS);
      return () => clearTimeout(t);
    }
    // setTeamAScore, setTeamBScore, clearError are stable (from useState)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Derive display data — use cached values when match is null during
  // the close animation so the content doesn't vanish mid-transition.
  const teamAPlayers = match?.players.filter((p) => p.team === "a") ?? [];
  const teamBPlayers = match?.players.filter((p) => p.team === "b") ?? [];
  const teamALabel = teamAPlayers.map((p) => p.profile.display_name).join(" & ") || "Team A";
  const teamBLabel = teamBPlayers.map((p) => p.profile.display_name).join(" & ") || "Team B";
  const courtName = match?.court?.name ?? null;

  const aVal = parseInt(teamAScore, 10);
  const bVal = parseInt(teamBScore, 10);
  const canSubmit =
    !isPending &&
    teamAScore !== "" &&
    teamBScore !== "" &&
    !isNaN(aVal) &&
    !isNaN(bVal) &&
    aVal >= 0 &&
    bVal >= 0 &&
    aVal <= MAX_BADMINTON_SCORE &&
    bVal <= MAX_BADMINTON_SCORE &&
    aVal !== bVal;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        // When Radix closes the dialog (Escape, overlay click), tell parent.
        if (!isOpen) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        {/* ── Header ─────────────────────────────────────────── */}
        <DialogHeader>
          <DialogTitle>Input Final Scores</DialogTitle>
          {courtName && <DialogDescription>{courtName}</DialogDescription>}
        </DialogHeader>

        {/* ── Score inputs ────────────────────────────────────── */}
        <div className="px-6 pb-2 space-y-4">
          {/* Team A row */}
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-600 dark:text-indigo-400 mb-0.5">
                Team A
              </p>
              <p className="text-sm font-semibold text-foreground truncate">{teamALabel}</p>
            </div>
            <input
              ref={teamARef}
              type="number"
              inputMode="numeric"
              min="0"
              max="99"
              value={teamAScore}
              onChange={(e) => setTeamAScore(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && teamARef.current?.blur()}
              placeholder="0"
              className={[
                "w-20 shrink-0 rounded-xl border-2 px-2 py-3",
                "text-center text-3xl font-bold",
                "placeholder:text-muted-foreground/40",
                "focus:outline-none transition-colors",
                "bg-indigo-50 border-indigo-200 text-indigo-900",
                "focus:border-indigo-500 focus:bg-white",
                "dark:bg-indigo-950/30 dark:border-indigo-800 dark:text-indigo-100 dark:focus:bg-indigo-950/50",
                // Hide browser spin buttons.
                "[appearance:textfield]",
                "[&::-webkit-outer-spin-button]:appearance-none",
                "[&::-webkit-inner-spin-button]:appearance-none",
              ].join(" ")}
            />
          </div>

          {/* Divider with VS */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs font-black text-muted-foreground tracking-widest px-1">
              VS
            </span>
            <div className="flex-1 h-px bg-border" />
          </div>

          {/* Team B row */}
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-600 mb-0.5">
                Team B
              </p>
              <p className="text-sm font-semibold text-foreground truncate">{teamBLabel}</p>
            </div>
            <input
              type="number"
              inputMode="numeric"
              min="0"
              max="99"
              value={teamBScore}
              onChange={(e) => setTeamBScore(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder="0"
              className={[
                "w-20 shrink-0 rounded-xl border-2 px-2 py-3",
                "text-center text-3xl font-bold",
                "placeholder:text-muted-foreground/40",
                "focus:outline-none transition-colors",
                "bg-emerald-50 border-emerald-200 text-emerald-900",
                "focus:border-emerald-500 focus:bg-white",
                "[appearance:textfield]",
                "[&::-webkit-outer-spin-button]:appearance-none",
                "[&::-webkit-inner-spin-button]:appearance-none",
              ].join(" ")}
            />
          </div>

          {/* Live winner preview — only shown when canSubmit (which requires aVal !== bVal) */}
          {canSubmit && (
            <p className="text-center text-xs text-muted-foreground pt-1">
              {aVal > bVal ? `Team A wins · ${aVal} – ${bVal}` : `Team B wins · ${aVal} – ${bVal}`}
            </p>
          )}

          {/* Error */}
          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-center text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        {/* ── Footer actions ──────────────────────────────────── */}
        <DialogFooter>
          <button
            onClick={onClose}
            disabled={isPending}
            className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium
                       text-foreground hover:bg-muted disabled:opacity-50
                       disabled:cursor-not-allowed transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-2.5
                       text-sm font-semibold text-white hover:bg-indigo-700
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors shadow-sm"
          >
            {isPending ? (
              <>
                <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Saving…
              </>
            ) : (
              "End Match"
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
