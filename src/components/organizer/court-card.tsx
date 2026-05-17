"use client";

// ============================================================
// CourtCard — single court tile for the ActiveCourts grid
// ============================================================

import { useState, useEffect } from "react";
import { Plus, Trophy, XCircle, Swords, Trash2 } from "lucide-react";
import { TeamsGrid } from "@/components/organizer/match-roster";
import { MatchTimer } from "@/components/ui/match-timer";
import { MatchOriginTag } from "@/components/organizer/match-origin-tag";
import type { Court } from "@/types/database";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";

// ─── Alert tier ──────────────────────────────────────────────

export type AlertTier = "normal" | "warning" | "critical";

// ─── Props ───────────────────────────────────────────────────

export interface CourtCardProps {
  court: Court;
  match: EnrichedMatch | undefined;
  timeLimitMinutes: number | null;
  isMatchmaking: boolean;
  isConfirmingCancel: boolean;
  isCancelling: boolean;
  isClearing: boolean;
  error: string | undefined;
  onCallNextMatch: () => void;
  onInputScore: () => void;
  onCancelRequest: () => void;
  onCancelConfirm: () => void;
  onCancelDismiss: () => void;
  onClearOnDeckMatch: () => void;
  onUpdateStatus: (s: Court["status"]) => void;
  onRemove: () => void;
}

// ─── Component ───────────────────────────────────────────────

export function CourtCard({
  court,
  match,
  timeLimitMinutes,
  isMatchmaking,
  isConfirmingCancel,
  isCancelling,
  isClearing,
  error,
  onCallNextMatch,
  onInputScore,
  onCancelRequest,
  onCancelConfirm,
  onCancelDismiss,
  onClearOnDeckMatch,
  onUpdateStatus,
  onRemove,
}: CourtCardProps) {
  const hasActiveMatch = !!match;
  const teamA = match?.players.filter((p) => p.team === "a") ?? [];
  const teamB = match?.players.filter((p) => p.team === "b") ?? [];

  type CardState = "matchmaking" | "in_progress" | "available" | "closed";
  const cardState: CardState = isMatchmaking
    ? "matchmaking"
    : hasActiveMatch
      ? "in_progress"
      : court.status === "closed"
        ? "closed"
        : "available";

  // When a match is live, the card flips to a dark navy surface.
  const isActive = cardState === "in_progress";

  // ── Court time alert tier ──────────────────────────────────
  // Recomputed every 30 s — only care about minute-level changes.
  // normal   → emerald glow (existing)
  // warning  → amber glow (at or past limit)
  // critical → red glow (limit + 10 min exceeded)
  const [alertTier, setAlertTier] = useState<AlertTier>("normal");

  useEffect(() => {
    function computeTier(): AlertTier {
      if (!isActive || !timeLimitMinutes || !match?.started_at) return "normal";
      const elapsed = (Date.now() - new Date(match.started_at).getTime()) / 60_000;
      if (elapsed >= timeLimitMinutes + 10) return "critical";
      if (elapsed >= timeLimitMinutes) return "warning";
      return "normal";
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAlertTier(computeTier());
    const id = setInterval(() => setAlertTier(computeTier()), 30_000);
    return () => clearInterval(id);
  }, [isActive, timeLimitMinutes, match?.started_at]);

  // Status badge config per state
  const badgeCfg: Record<CardState, { cls: string; label: string }> = {
    matchmaking: {
      cls: "bg-cc-badge-progress-bg border-cc-amber/40 text-cc-amber",
      label: "Finding Match…",
    },
    in_progress: {
      cls: "bg-cc-badge-progress-bg border-cc-amber/40 text-cc-amber",
      label: "In Progress",
    },
    available: {
      cls: "bg-cc-accent-dim border-cc-accent/35 text-cc-accent",
      label: "Available",
    },
    closed: {
      cls: "bg-cc-bg-3 border-cc-border text-cc-t3",
      label: "Closed",
    },
  };

  // Outer wrapper carries the filter (glow + 1px ring); inner div carries clip-path.
  // Keeping them separate means the drop-shadow is applied to the already-clipped
  // shape, producing a ring that follows the chamfered polygon rather than the box.
  // Colors reference --cc-* tokens via getComputedStyle (filter strings can't use
  // var() inside oklch directly across browsers, so we resolve once per render).
  const glowFilter = isActive
    ? alertTier === "critical"
      ? "drop-shadow(0 0 0 1px var(--cc-red)) drop-shadow(0 0 14px var(--cc-red-dim))"
      : alertTier === "warning"
        ? "drop-shadow(0 0 0 1px var(--cc-amber)) drop-shadow(0 0 14px var(--cc-amber-dim))"
        : "drop-shadow(0 0 0 1px var(--cc-deck-border)) drop-shadow(0 0 12px var(--cc-accent-glow))"
    : undefined;

  return (
    <div
      data-testid={`court-card-${court.id}`}
      data-alert-tier={alertTier}
      style={{ filter: glowFilter }}
    >
      <div
        className={[
          "flex flex-col clip-cut overflow-hidden transition-all cc-scan cc-scan-slow",
          isActive ? "bg-cc-bg-2" : "bg-cc-bg-2 border border-cc-border",
        ].join(" ")}
      >
      {/* ── Header ─────────────────────────────────────────── */}
      {/*
        Left group: court name (20px Chakra Petch) stacked above badges.
        Right group: flex-col (timer on top, status badge below).
        Both sides use min-w-0 / shrink-0 to prevent flex overflow.
      */}
      <div
        className={[
          "relative z-[1] flex items-center justify-between gap-2 px-5 pt-4 pb-3 border-b",
          isActive
            ? alertTier === "critical"
              ? "border-cc-red/30"
              : alertTier === "warning"
                ? "border-cc-amber/30"
                : "border-cc-accent/25"
            : "border-cc-border",
        ].join(" ")}
      >
        {/* Left group — court name + badges stacked vertically */}
        <div className="flex flex-col gap-1.5 min-w-0">
          <h3 className="truncate font-command text-[20px] font-bold uppercase tracking-[0.06em] leading-none text-cc-t1">
            {court.name}
          </h3>
          <div className="flex items-center gap-1.5 flex-wrap">
            {match?.is_mixed_level && (
              <span className="clip-cut-badge bg-cc-blue-dim text-cc-blue px-2 py-0.5
                               font-command text-[9px] uppercase tracking-[0.10em]">
                Mixed Level
              </span>
            )}
            {match && <MatchOriginTag origin={match.origin} />}
          </div>
        </div>
        {/* Right group — timer on top, status badge below (column) */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          {cardState === "in_progress" && match?.started_at && (
            <MatchTimer startedAt={match.started_at} variant="command" />
          )}
          <span
            className={`clip-cut-badge border px-2.5 py-0.5
                        font-command text-[9px] uppercase tracking-[0.12em] whitespace-nowrap
                        ${badgeCfg[cardState].cls}
                        ${cardState === "matchmaking" ? "animate-pulse" : ""}`}
          >
            {badgeCfg[cardState].label}
          </span>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────── */}

      {/* IN PROGRESS — dark roster grid (replaces BadmintonCourt) */}
      {hasActiveMatch && match && (
        <div className="flex-1">
          <TeamsGrid
            dark
            teamA={teamA.map((p) => ({
              player_id: p.player_id,
              display_name: p.profile.display_name,
              skill_level: p.profile.skill_level,
              vip_tag: p.profile.vip_tag,
              vip_theme: p.profile.vip_theme,
            }))}
            teamB={teamB.map((p) => ({
              player_id: p.player_id,
              display_name: p.profile.display_name,
              skill_level: p.profile.skill_level,
              vip_tag: p.profile.vip_tag,
              vip_theme: p.profile.vip_theme,
            }))}
            labelA="Team A"
            labelB="Team B"
          />
        </div>
      )}

      {/* Non-active states — keep original body layout */}
      {!hasActiveMatch && (
        <div className="relative z-[1] flex-1 px-4 pb-3">
          {/* MATCHMAKING — spinner */}
          {isMatchmaking && (
            <div className="flex flex-col items-center justify-center gap-2 py-6">
              <div className="h-7 w-7 rounded-full border-[3px] border-cc-amber-dim border-t-cc-amber animate-spin" />
              <p className="font-command text-[10px] uppercase tracking-[0.16em] text-cc-amber">
                Running algorithm…
              </p>
            </div>
          )}

          {/* AVAILABLE — placeholder with icon */}
          {!isMatchmaking && cardState === "available" && (
            <div className="flex flex-col items-center justify-center gap-2 py-6">
              <div className="rounded-full bg-cc-accent-dim border border-cc-accent/30 p-2.5">
                <Swords className="h-5 w-5 text-cc-accent" />
              </div>
              <p className="font-command text-[10px] uppercase tracking-[0.16em] text-cc-accent">
                Ready for next match
              </p>
            </div>
          )}

          {/* CLOSED — placeholder */}
          {cardState === "closed" && (
            <div className="flex items-center justify-center py-6">
              <p className="font-command text-[10px] uppercase tracking-[0.16em] text-cc-t3">
                Court is closed
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Footer ─────────────────────────────────────────── */}
      <div className="relative z-[1] px-4 pt-3 pb-4 space-y-2 border-t border-cc-border">
        {/* Inline error */}
        {error && (
          <p className="clip-cut-sm bg-cc-red-dim border border-cc-red/30 px-3 py-2 text-center
                        font-command text-[9px] uppercase tracking-[0.10em] text-cc-red">
            {error}
          </p>
        )}

        {/* Match actions — split by status */}
        {hasActiveMatch && match && (
          <>
            {/* ON DECK (pending) — red "Clear" button only */}
            {match.status === "pending" && (
              <div className="flex items-center justify-end">
                <button
                  onClick={onClearOnDeckMatch}
                  disabled={isClearing}
                  className="flex items-center gap-1.5 clip-cut-sm border border-cc-red/30
                             bg-cc-red-dim px-3 py-2
                             font-command text-[9px] uppercase tracking-[0.10em] text-cc-red
                             hover:bg-cc-red/15
                             disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {isClearing ? "Clearing…" : "Clear"}
                </button>
              </div>
            )}

            {/* IN PROGRESS — cancel + score actions */}
            {match.status === "in_progress" && (
              <>
                {isConfirmingCancel ? (
                  /* Two-step cancel confirmation */
                  <div className="space-y-2 clip-cut border border-cc-red/35 bg-cc-red-dim p-3">
                    <p className="text-center font-command text-[9px] uppercase tracking-[0.10em] text-cc-red">
                      Cancel this match? Players return to queue.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={onCancelConfirm}
                        disabled={isCancelling}
                        className="flex-1 clip-cut-sm bg-cc-red/25 py-2 border border-cc-red/50
                                   font-command text-[9px] uppercase tracking-[0.10em] text-cc-t1
                                   hover:bg-cc-red/35
                                   disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isCancelling ? "Cancelling…" : "Yes, Cancel"}
                      </button>
                      <button
                        onClick={onCancelDismiss}
                        disabled={isCancelling}
                        className="flex-1 clip-cut-sm border border-cc-border py-2 bg-cc-bg-3
                                   font-command text-[9px] uppercase tracking-[0.10em] text-cc-t2
                                   hover:bg-cc-border
                                   disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        Keep Playing
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Normal in-progress actions — grid 1fr 1.6fr per preview spec */
                  <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1.6fr" }}>
                    <button
                      onClick={onCancelRequest}
                      disabled={isCancelling}
                      className="flex items-center justify-center gap-1.5 clip-cut-sm px-3 py-2.5
                                 border border-cc-red/30 bg-cc-red-dim
                                 font-command text-[9px] uppercase tracking-[0.12em] text-cc-red
                                 hover:bg-cc-red/18
                                 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Cancel
                    </button>
                    <button
                      onClick={onInputScore}
                      disabled={isCancelling}
                      className="flex items-center justify-center gap-1.5 clip-cut-sm
                                 bg-cc-accent hover:brightness-110
                                 px-4 py-2.5 min-h-[44px]
                                 font-command text-[9px] uppercase tracking-[0.12em] text-cc-btn-on-accent
                                 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      <Trophy className="h-3.5 w-3.5" />
                      Input Score &amp; End
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* AVAILABLE action */}
        {!hasActiveMatch && !isMatchmaking && cardState === "available" && (
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={onCallNextMatch}
              className="flex items-center gap-1.5 clip-cut-sm
                         bg-cc-accent hover:brightness-110
                         px-4 py-2.5 min-h-[44px]
                         font-command text-[10px] uppercase tracking-[0.12em] text-cc-btn-on-accent
                         transition-all"
            >
              <Plus className="h-4 w-4" />
              Call Next Match
            </button>
            <button
              onClick={() => onUpdateStatus("closed")}
              className="clip-cut-sm border border-cc-border px-3 py-2.5
                         font-command text-[9px] uppercase tracking-[0.10em]
                         text-cc-t3 hover:bg-cc-bg-3
                         transition-colors"
            >
              Close
            </button>
          </div>
        )}

        {/* CLOSED actions */}
        {!hasActiveMatch && cardState === "closed" && (
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => onUpdateStatus("available")}
              className="flex-1 clip-cut-sm bg-cc-accent-dim border border-cc-accent/45
                         px-4 py-2.5 font-command text-[9px] uppercase tracking-[0.12em]
                         text-cc-accent hover:bg-cc-accent/28
                         transition-colors"
            >
              Reopen Court
            </button>
            <button
              onClick={onRemove}
              className="clip-cut-sm border border-cc-red/35 px-3 py-2.5
                         font-command text-[9px] uppercase tracking-[0.10em]
                         text-cc-red hover:bg-cc-red-dim
                         transition-colors"
            >
              Remove
            </button>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

