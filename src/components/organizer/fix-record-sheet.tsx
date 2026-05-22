"use client";

// ============================================================
// FixRecordSheet — Historical Player Roster Correction
// ============================================================
// Opened via the "Fix" amber button on each completed match card.
// Lets the organiser correct a player roster error in a completed
// match (wrong player recorded, or injury substitution).
//
// Two-step sequential flow:
//   Step 1 — "Who was recorded incorrectly?"
//     Shows the 4 match players grouped by team. Tap to select outgoing.
//   Step 2 — "Who actually played?"
//     Section A: "SWITCH WITHIN THIS MATCH" (other 3 players — team flip)
//     Section B: "FROM OTHER SESSION MATCHES" (session completed players)
//     Tapping a candidate reveals the inline confirmation strip.
//   Confirmation strip — summary + [Cancel] [Confirm Fix →]
//
// Amber accent throughout (vs the live swap's teal) — visually signals
// this is a data-correction operation, not a live game action.
//
// Design tokens follow the command-centre cc-* palette used in the
// organiser dashboard (bg-cc-bg-2, border-cc-border, font-command, etc.)
// ============================================================

import { useState, useCallback } from "react";
import { ArrowLeftRight, ChevronRight, AlertCircle, Loader2 } from "lucide-react";
import { SkillBadge } from "@/components/ui/skill-badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useFixRecord } from "@/hooks/use-fix-record";
import { useSessionCompletedPlayers } from "@/hooks/use-session-completed-players";
import type { CompletedMatch } from "@/hooks/use-match-history";
import type { SkillLevel } from "@/types/database";

// ── Types ─────────────────────────────────────────────────────

interface FixRecordSheetProps {
  match: CompletedMatch;
  sessionId: string;
  onCorrected: () => void;
}

// ── Team chip ─────────────────────────────────────────────────

function TeamChip({ team }: { team: "a" | "b" }) {
  return (
    <span
      className="shrink-0 flex items-center justify-center w-5 h-5 rounded text-[10px]
                 font-command font-bold uppercase tracking-wide
                 bg-[var(--cc-amber-dim)] text-[var(--cc-amber)]
                 border border-[var(--cc-amber)]/30"
    >
      {team.toUpperCase()}
    </span>
  );
}

// ── Step 1: pick the outgoing player ─────────────────────────

function Step1({
  match,
  onSelect,
}: {
  match: CompletedMatch;
  onSelect: (p: {
    player_id: string;
    display_name: string;
    skill_level: SkillLevel;
    team: "a" | "b";
  }) => void;
}) {
  const teamA = match.players.filter((p) => p.team === "a");
  const teamB = match.players.filter((p) => p.team === "b");

  const scoreA = match.team_a_score ?? 0;
  const scoreB = match.team_b_score ?? 0;
  const aWon = scoreA > scoreB;

  return (
    <div className="flex flex-col gap-4">
      {/* Prompt */}
      <p className="text-sm text-cc-t2 leading-snug">
        Select the player whose record needs correcting.
      </p>

      {/* Match score reference */}
      <div className="flex items-center gap-2 rounded-lg px-3 py-2 border border-cc-border bg-cc-bg-2">
        <span className="font-command text-[9px] uppercase tracking-widest text-cc-t3">Match</span>
        <span className="font-command text-[9px] text-cc-t3 font-bold tabular-nums">
          {scoreA} – {scoreB}
        </span>
        <span
          className="ml-1 font-command text-[9px] uppercase tracking-wider"
          style={{ color: "var(--cc-amber)" }}
        >
          {aWon ? "Team A won" : "Team B won"}
        </span>
      </div>

      {/* Team A group */}
      <div className="flex flex-col gap-1">
        <p className="font-command text-[9px] uppercase tracking-[0.18em] text-cc-t3 px-1">
          Team A
        </p>
        <div className="rounded-xl border border-cc-border overflow-hidden">
          {teamA.map((p, i) => (
            <button
              key={p.player_id}
              onClick={() =>
                onSelect({
                  player_id: p.player_id,
                  display_name: p.profile.display_name,
                  skill_level: p.profile.skill_level,
                  team: "a",
                })
              }
              className={[
                "w-full flex items-center gap-3 px-3 py-3 text-left min-h-[48px]",
                "transition-colors hover:bg-cc-bg-3 active:bg-[var(--cc-amber-dim)]",
                i > 0 ? "border-t border-cc-border" : "",
              ].join(" ")}
            >
              <TeamChip team="a" />
              <span className="flex-1 text-sm font-semibold text-cc-t1 truncate">
                {p.profile.display_name}
              </span>
              <SkillBadge level={p.profile.skill_level} />
              <ChevronRight className="h-4 w-4 text-cc-t3 shrink-0" />
            </button>
          ))}
        </div>
      </div>

      {/* Team B group */}
      <div className="flex flex-col gap-1">
        <p className="font-command text-[9px] uppercase tracking-[0.18em] text-cc-t3 px-1">
          Team B
        </p>
        <div className="rounded-xl border border-cc-border overflow-hidden">
          {teamB.map((p, i) => (
            <button
              key={p.player_id}
              onClick={() =>
                onSelect({
                  player_id: p.player_id,
                  display_name: p.profile.display_name,
                  skill_level: p.profile.skill_level,
                  team: "b",
                })
              }
              className={[
                "w-full flex items-center gap-3 px-3 py-3 text-left min-h-[48px]",
                "transition-colors hover:bg-cc-bg-3 active:bg-[var(--cc-amber-dim)]",
                i > 0 ? "border-t border-cc-border" : "",
              ].join(" ")}
            >
              <TeamChip team="b" />
              <span className="flex-1 text-sm font-semibold text-cc-t1 truncate">
                {p.profile.display_name}
              </span>
              <SkillBadge level={p.profile.skill_level} />
              <ChevronRight className="h-4 w-4 text-cc-t3 shrink-0" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Step 2: pick the replacement (owns the session players hook) ──

function Step2({
  match,
  outPlayer,
  sessionId,
  selectedInId,
  onSelect,
}: {
  match: CompletedMatch;
  outPlayer: { player_id: string; display_name: string; skill_level: SkillLevel; team: "a" | "b" };
  sessionId: string;
  selectedInId: string | null;
  onSelect: (p: {
    player_id: string;
    display_name: string;
    skill_level: SkillLevel;
    team: "a" | "b";
  }) => void;
}) {
  const { players: sessionPlayers, loading: sessionLoading } = useSessionCompletedPlayers(
    sessionId,
    match.id
  );

  // "Switch within this match" candidates: all players except outPlayer
  const sameMatchCandidates = match.players
    .filter((p) => p.player_id !== outPlayer.player_id)
    .map((p) => ({
      player_id: p.player_id,
      display_name: p.profile.display_name,
      skill_level: p.profile.skill_level,
      team: p.team,
    }));

  // "From other session matches" candidates: exclude all current match players
  const matchPlayerIds = new Set(match.players.map((p) => p.player_id));
  const otherSessionCandidates = sessionPlayers.filter((p) => !matchPlayerIds.has(p.player_id));

  function CandidateRow({
    playerId,
    displayName,
    skillLevel,
    team,
    stats,
  }: {
    playerId: string;
    displayName: string;
    skillLevel: SkillLevel;
    team?: "a" | "b";
    stats?: { games_played: number; wins: number; losses: number };
  }) {
    const isSelected = selectedInId === playerId;
    return (
      <button
        onClick={() =>
          onSelect({
            player_id: playerId,
            display_name: displayName,
            skill_level: skillLevel,
            team: team ?? outPlayer.team,
          })
        }
        className={[
          "w-full flex items-center gap-3 px-3 py-3 text-left min-h-[48px] transition-colors",
          isSelected ? "bg-[var(--cc-amber-dim)] border-l-0" : "hover:bg-cc-bg-3",
        ].join(" ")}
      >
        {team && <TeamChip team={team} />}
        <span className="flex-1 text-sm font-semibold text-cc-t1 truncate">{displayName}</span>
        <SkillBadge level={skillLevel} />
        {stats && (
          <span className="font-command text-[9px] text-cc-t3 tabular-nums shrink-0">
            {stats.games_played}G · {stats.wins}W {stats.losses}L
          </span>
        )}
        {isSelected && (
          <span
            className="shrink-0 w-2 h-2 rounded-full"
            style={{ background: "var(--cc-amber)" }}
          />
        )}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Outgoing player reference */}
      <div
        className="flex items-center gap-2 rounded-lg px-3 py-2.5 border"
        style={{
          borderColor: "var(--cc-amber)",
          background: "var(--cc-amber-dim)",
        }}
      >
        <TeamChip team={outPlayer.team} />
        <span className="flex-1 text-sm font-semibold text-cc-t1 truncate line-through opacity-60">
          {outPlayer.display_name}
        </span>
        <span
          className="font-command text-[9px] uppercase tracking-wider shrink-0"
          style={{ color: "var(--cc-amber)" }}
        >
          Removing
        </span>
      </div>

      {/* Prompt */}
      <p className="text-sm text-cc-t2 leading-snug">Who actually played in this slot?</p>

      {/* Section A: within this match */}
      {sameMatchCandidates.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="font-command text-[9px] uppercase tracking-[0.18em] text-cc-t3 px-1">
            Switch within this match
          </p>
          <div className="rounded-xl border border-cc-border overflow-hidden">
            {sameMatchCandidates.map((p, i) => (
              <div key={p.player_id} className={i > 0 ? "border-t border-cc-border" : ""}>
                <CandidateRow
                  playerId={p.player_id}
                  displayName={p.display_name}
                  skillLevel={p.skill_level}
                  team={p.team}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section B: from other session matches */}
      <div className="flex flex-col gap-1">
        <p className="font-command text-[9px] uppercase tracking-[0.18em] text-cc-t3 px-1">
          From other session matches
        </p>
        {sessionLoading ? (
          <div className="flex items-center justify-center py-6 gap-2 text-cc-t3">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="font-command text-[10px] uppercase tracking-wider">Loading…</span>
          </div>
        ) : otherSessionCandidates.length === 0 ? (
          <div className="rounded-xl border border-cc-border px-4 py-6 text-center">
            <p className="font-command text-[10px] uppercase tracking-wider text-cc-t3">
              No other session players
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-cc-border overflow-hidden">
            {otherSessionCandidates.map((p, i) => (
              <div key={p.player_id} className={i > 0 ? "border-t border-cc-border" : ""}>
                <CandidateRow
                  playerId={p.player_id}
                  displayName={p.display_name}
                  skillLevel={p.skill_level}
                  stats={{ games_played: p.games_played, wins: p.wins, losses: p.losses }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main sheet component ──────────────────────────────────────

export function FixRecordSheet({ match, sessionId, onCorrected }: FixRecordSheetProps) {
  const [open, setOpen] = useState(false);

  const handleSuccess = useCallback(() => {
    setOpen(false);
    onCorrected();
  }, [onCorrected]);

  const {
    step,
    outPlayer,
    inPlayer,
    errorMessage,
    isPending,
    isTeamFlip,
    selectOut,
    selectIn,
    goBack,
    cancelConfirm,
    confirm,
    reset,
  } = useFixRecord({ match, sessionId, onSuccess: handleSuccess });

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) reset();
    setOpen(nextOpen);
  }

  const scoreA = match.team_a_score ?? 0;
  const scoreB = match.team_b_score ?? 0;
  const matchLabel = match.id.slice(1, 5).toLowerCase();

  const isStep1 = step === "selecting_out";
  const isStep2 = step === "selecting_in" || step === "confirming" || step === "submitting";
  const isConfirming = step === "confirming" || step === "submitting";

  return (
    <>
      {/* ── Trigger button ─────────────────────────────────── */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-lg px-3 py-2 min-h-[44px] text-[11px] font-medium
                   transition-colors
                   text-amber-500 hover:text-amber-600 hover:bg-amber-50
                   dark:text-amber-400 dark:hover:text-amber-300 dark:hover:bg-amber-900/20"
        title="Fix player record"
        aria-label="Fix player record"
      >
        <ArrowLeftRight className="h-3 w-3" />
        Fix
      </button>

      {/* ── Sheet ──────────────────────────────────────────── */}
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent showClose className="bg-cc-bg-2 border-cc-border flex flex-col">
          {/* Header */}
          <SheetHeader className="pr-10 shrink-0">
            <div className="flex items-center gap-2.5">
              <span
                className="flex items-center justify-center w-7 h-7 rounded-lg shrink-0"
                style={{
                  background: "var(--cc-amber-dim)",
                  border: "1px solid color-mix(in oklab, var(--cc-amber) 40%, transparent)",
                }}
              >
                <ArrowLeftRight className="h-3.5 w-3.5" style={{ color: "var(--cc-amber)" }} />
              </span>
              <SheetTitle className="font-command text-sm font-bold uppercase tracking-[0.12em] text-cc-t1">
                Fix Player Record
              </SheetTitle>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="font-command text-[9px] uppercase tracking-widest text-cc-t3">
                #{matchLabel}
              </span>
              <span className="font-command text-[9px] text-cc-t3 tabular-nums font-bold">
                {scoreA} – {scoreB}
              </span>
            </div>
          </SheetHeader>

          {/* Step breadcrumb */}
          <div className="flex items-center gap-2 py-2 shrink-0">
            {/* Step 1 crumb — tappable back button when in Step 2 */}
            <button
              onClick={isStep2 && !isPending ? goBack : undefined}
              disabled={!isStep2 || isPending}
              className={[
                "font-command text-[9px] uppercase tracking-wider",
                isStep1 ? "font-bold" : "text-cc-t3 line-through",
                isStep2 && !isPending
                  ? "cursor-pointer hover:opacity-80 transition-opacity"
                  : "cursor-default",
              ].join(" ")}
              style={isStep1 ? { color: "var(--cc-amber)" } : undefined}
              aria-label={isStep2 ? "Back to player selection" : undefined}
            >
              Select player
            </button>

            <span className="text-cc-t3 text-[10px]">›</span>

            {/* Step 2 crumb */}
            <span
              className={[
                "font-command text-[9px] uppercase tracking-wider",
                isStep2 ? "font-bold" : "text-cc-t3",
              ].join(" ")}
              style={isStep2 ? { color: "var(--cc-amber)" } : undefined}
            >
              Pick replacement
            </span>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto -mx-6 px-6 py-1">
            {isStep1 && <Step1 match={match} onSelect={selectOut} />}

            {isStep2 && outPlayer && (
              <Step2
                match={match}
                outPlayer={outPlayer}
                sessionId={sessionId}
                selectedInId={inPlayer?.player_id ?? null}
                onSelect={selectIn}
              />
            )}
          </div>

          {/* Confirmation strip (appears after selecting in_player) */}
          {isConfirming && outPlayer && inPlayer && (
            <div
              className="shrink-0 rounded-xl border p-4 mt-2 flex flex-col gap-3 animate-in slide-in-from-bottom-2 fade-in duration-200"
              style={{
                borderColor: "var(--cc-amber)",
                background: "var(--cc-amber-dim)",
              }}
            >
              {/* Summary */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-command text-[10px] uppercase tracking-widest text-cc-t3">
                  Replacing
                </span>
                <span className="font-command text-[11px] font-bold uppercase tracking-wide line-through opacity-60 text-cc-t1">
                  {outPlayer.display_name}
                </span>
                <span className="font-command text-[10px] text-cc-t3">→</span>
                <span
                  className="font-command text-[11px] font-bold uppercase tracking-wide text-cc-t1"
                  style={{ color: "var(--cc-amber)" }}
                >
                  {inPlayer.display_name}
                </span>
                <span
                  className="font-command text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-md"
                  style={{
                    background: "color-mix(in oklab, var(--cc-amber) 15%, transparent)",
                    color: "var(--cc-amber)",
                    border: "1px solid color-mix(in oklab, var(--cc-amber) 30%, transparent)",
                  }}
                >
                  {isTeamFlip ? "Team switch" : `Team ${outPlayer.team.toUpperCase()}`}
                </span>
              </div>
              <p className="text-[11px] text-cc-t3 leading-snug">
                Win/loss records and partnership history will update automatically.
              </p>

              {/* Error */}
              {errorMessage && (
                <div className="flex items-start gap-2 rounded-lg border border-cc-red/40 bg-cc-red-dim px-3 py-2">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-cc-red" />
                  <p className="text-[11px] text-cc-red leading-snug">{errorMessage}</p>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  onClick={cancelConfirm}
                  disabled={isPending}
                  className="flex-1 rounded-lg px-3 py-2.5 font-command text-[10px] font-bold
                             uppercase tracking-[0.12em] text-cc-t2 border border-cc-border
                             hover:bg-cc-bg-3 transition-colors disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={confirm}
                  disabled={isPending}
                  className="flex-1 rounded-lg px-3 py-2.5 font-command text-[10px] font-bold
                             uppercase tracking-[0.12em] transition-colors
                             disabled:opacity-40 flex items-center justify-center gap-1.5"
                  style={{
                    background: isPending
                      ? "color-mix(in oklab, var(--cc-amber) 60%, transparent)"
                      : "var(--cc-amber)",
                    color: "oklch(0.1 0.02 62)",
                  }}
                >
                  {isPending ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    "Confirm Fix →"
                  )}
                </button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
