"use client";

// ============================================================
// ActiveCourts — container + CourtCard grid
// ============================================================
// State rules:
//   • hasActiveMatch (from activeMatches prop) is the absolute
//     lock. When true, the card shows the In-Progress UI and
//     the "Call Next Match" button cannot appear.
//   • scoringMatchId drives the ScoreModal open state. It is
//     set to the match ID when "Input Score & End" is clicked
//     and cleared when the modal is closed or submit succeeds.
//   • Cancel uses a two-step inline confirmation so the
//     organiser cannot accidentally abort a live game.
//
// In-Progress court cards:
//   When cardState === "in_progress", the card switches to a
//   dark navy surface (#0D1B2A) with an emerald glow ring,
//   replacing the old BadmintonCourt graphic with a CSS-grid
//   TeamsGrid roster (from match-roster.tsx).
// ============================================================

import { useState, useEffect } from "react";
import { Plus, Trophy, XCircle, Swords, Trash2 } from "lucide-react";
import { ScoreModal } from "./score-modal";
import { TeamsGrid } from "@/components/organizer/match-roster";
import { MatchTimer } from "@/components/ui/match-timer";
import { CourtTimePopover } from "@/components/ui/court-time-popover";
import type { Court } from "@/types/database";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";
import type { MatchmakingResult } from "@/app/actions/matchmaking";
import { MatchOriginTag } from "@/components/organizer/match-origin-tag";

// ─── Prop types ───────────────────────────────────────────────

interface ActiveCourtsProps {
  courts: Court[];
  activeMatches: EnrichedMatch[];
  /** Per-session court time limit in minutes; null = no limit. */
  timeLimitMinutes: number | null;
  onUpdateTimeLimit: (minutes: number | null) => Promise<{ error?: string }>;
  onAddCourt: (name: string) => Promise<{ error?: string }>;
  onUpdateCourtStatus: (courtId: string, status: Court["status"]) => Promise<{ error?: string }>;
  onRemoveCourt: (courtId: string) => Promise<{ error?: string }>;
  onCallNextMatch: (courtId: string) => Promise<MatchmakingResult>;
  onEndMatch: (
    matchId: string,
    teamAScore: number,
    teamBScore: number
  ) => Promise<{ error?: string }>;
  onCancelMatch: (matchId: string) => Promise<{ error?: string }>;
  onClearOnDeckMatch: (matchId: string) => Promise<{ error?: string }>;
}

interface Toast {
  type: "success" | "error" | "warning";
  title: string;
  body: string;
}

// ─── CourtCard ────────────────────────────────────────────────

type AlertTier = "normal" | "warning" | "critical";

interface CourtCardProps {
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

function CourtCard({
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
    setAlertTier(computeTier());
    const id = setInterval(() => setAlertTier(computeTier()), 30_000);
    return () => clearInterval(id);
  }, [isActive, timeLimitMinutes, match?.started_at]);

  // Status badge config per state
  const badgeCfg: Record<CardState, { cls: string; label: string }> = {
    matchmaking: {
      cls: "bg-[oklch(0.78_0.17_62/0.18)] border-[oklch(0.78_0.17_62/0.45)] text-[oklch(0.88_0.14_62)]",
      label: "Finding Match…",
    },
    in_progress: {
      cls: "bg-[oklch(0.78_0.17_62/0.14)] border-[oklch(0.78_0.17_62/0.40)] text-[oklch(0.88_0.14_62)]",
      label: "In Progress",
    },
    available: {
      cls: "bg-[oklch(0.76_0.17_155/0.12)] border-[oklch(0.76_0.17_155/0.35)] text-[oklch(0.76_0.17_155)]",
      label: "Available",
    },
    closed: {
      cls: "bg-[oklch(0.20_0.016_245)] border-[oklch(0.30_0.020_245)] text-[oklch(0.55_0.010_245)]",
      label: "Closed",
    },
  };

  // Outer wrapper carries the filter (glow + 1px ring); inner div carries clip-path.
  // Keeping them separate means the drop-shadow is applied to the already-clipped
  // shape, producing a ring that follows the chamfered polygon rather than the box.
  const glowFilter = isActive
    ? alertTier === "critical"
      ? "drop-shadow(0 0 0 1px oklch(0.65 0.22 22 / 0.55)) drop-shadow(0 0 14px oklch(0.65 0.22 22 / 0.35))"
      : alertTier === "warning"
        ? "drop-shadow(0 0 0 1px oklch(0.78 0.17 62 / 0.50)) drop-shadow(0 0 14px oklch(0.78 0.17 62 / 0.28))"
        : "drop-shadow(0 0 0 1px oklch(0.79 0.18 188 / 0.35)) drop-shadow(0 0 12px oklch(0.79 0.18 188 / 0.18))"
    : undefined;

  return (
    <div
      data-testid={`court-card-${court.id}`}
      data-alert-tier={alertTier}
      style={{ filter: glowFilter }}
    >
      <div
        className={[
          "flex flex-col clip-cut overflow-hidden transition-all",
          !isActive ? "bg-card border border-gray-200 dark:border-border" : "",
        ].join(" ")}
        style={isActive ? { background: "oklch(0.10 0.014 245)" } : undefined}
      >
      {/* ── Header ─────────────────────────────────────────── */}
      {/*
        Single-row layout: left group (name + mixed badge + origin tag) gets
        min-w-0 so the court name can truncate before the right group is
        pushed to a second line. The right group (timer + status badge) is
        always shrink-0 and stays in place. This eliminates the 30px height
        discrepancy that occurred when Mixed Level badge caused flex-wrap.
      */}
      <div
        className={[
          "flex items-center justify-between gap-2 px-5 pt-4 pb-3",
          isActive ? "border-b" : "border-b border-gray-200 dark:border-border",
        ].join(" ")}
        style={
          isActive
            ? {
                borderColor:
                  alertTier === "critical"
                    ? "oklch(0.65 0.22 22 / 0.28)"
                    : alertTier === "warning"
                      ? "oklch(0.78 0.17 62 / 0.28)"
                      : "oklch(0.79 0.18 188 / 0.22)", // teal command separator
              }
            : undefined
        }
      >
        {/* Left group — min-w-0 allows court name to truncate instead of wrapping */}
        <div className="flex items-center gap-2 min-w-0">
          <h3
            className={`truncate font-command text-base font-bold uppercase tracking-tight ${
              isActive ? "text-white" : "text-gray-900 dark:text-foreground"
            }`}
          >
            {court.name}
          </h3>
          {match?.is_mixed_level && (
            <span
              className="shrink-0 clip-cut-badge border px-2 py-0.5
                          font-command text-[9px] uppercase tracking-[0.10em]
                          bg-amber-100 border-amber-300 text-amber-800
                          dark:bg-amber-500/15 dark:border-amber-500/40 dark:text-amber-300"
            >
              Mixed Level
            </span>
          )}
          {match && <MatchOriginTag origin={match.origin} />}
        </div>
        {/* Right group — live timer + status badge; never shrinks or wraps internally */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Live match timer — only shown when in_progress */}
          {cardState === "in_progress" && match?.started_at && (
            <MatchTimer startedAt={match.started_at} variant="live" />
          )}
          {/* Pulse scoped to the badge only when matchmaking — not the whole card */}
          <span
            className={`shrink-0 clip-cut-badge border px-2.5 py-0.5
                        font-command text-[9px] uppercase tracking-[0.12em]
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
        <div className="flex-1 px-4 pb-3">
          {/* MATCHMAKING — spinner */}
          {isMatchmaking && (
            <div className="flex flex-col items-center justify-center gap-2 py-6">
              <div className="h-7 w-7 rounded-full border-[3px] border-amber-200 border-t-amber-600 animate-spin" />
              <p className="text-sm font-medium text-amber-700">Running algorithm…</p>
            </div>
          )}

          {/* AVAILABLE — dashed placeholder with icon */}
          {!isMatchmaking && cardState === "available" && (
            <div className="flex flex-col items-center justify-center gap-2 py-6">
              <div className="rounded-full bg-emerald-50 border border-emerald-200 p-2.5">
                <Swords className="h-5 w-5 text-emerald-400" />
              </div>
              <p className="text-sm font-medium text-emerald-600">Ready for next match</p>
            </div>
          )}

          {/* CLOSED — placeholder */}
          {cardState === "closed" && (
            <div className="flex items-center justify-center py-6">
              <p className="text-sm text-muted-foreground">Court is closed</p>
            </div>
          )}
        </div>
      )}

      {/* ── Footer ─────────────────────────────────────────── */}
      {/* pt-3 is uniform across all card states so buttons sit at the same
          depth in the grid row regardless of which state is active. */}
      <div
        className={`px-4 pt-3 pb-4 space-y-2 ${isActive ? "border-t" : ""}`}
        style={isActive ? { borderColor: "rgba(255,255,255,0.1)" } : undefined}
      >
        {/* Inline error */}
        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
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
                  className="flex items-center gap-1.5 clip-cut-sm border border-[oklch(0.65_0.22_22/0.40)]
                             bg-[oklch(0.65_0.22_22/0.10)] px-3 py-2
                             font-command text-[9px] uppercase tracking-[0.10em] text-[oklch(0.75_0.18_22)]
                             hover:bg-[oklch(0.65_0.22_22/0.18)]
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
                  <div className="space-y-2 clip-cut border border-[oklch(0.65_0.22_22/0.35)]
                                  bg-[oklch(0.65_0.22_22/0.08)] p-3">
                    <p className="text-center font-command text-[9px] uppercase tracking-[0.10em]
                                  text-[oklch(0.75_0.18_22)]">
                      Cancel this match? Players return to queue.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={onCancelConfirm}
                        disabled={isCancelling}
                        className="flex-1 clip-cut-sm bg-[oklch(0.65_0.22_22/0.25)] py-2
                                   border border-[oklch(0.65_0.22_22/0.50)]
                                   font-command text-[9px] uppercase tracking-[0.10em]
                                   text-[oklch(0.85_0.14_22)]
                                   hover:bg-[oklch(0.65_0.22_22/0.35)]
                                   disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isCancelling ? "Cancelling…" : "Yes, Cancel"}
                      </button>
                      <button
                        onClick={onCancelDismiss}
                        disabled={isCancelling}
                        className="flex-1 clip-cut-sm border border-[oklch(0.35_0.020_245)] py-2
                                   bg-[oklch(0.18_0.018_245)]
                                   font-command text-[9px] uppercase tracking-[0.10em]
                                   text-[oklch(0.65_0.012_245)]
                                   hover:bg-[oklch(0.22_0.018_245)]
                                   disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        Keep Playing
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Normal in-progress actions */
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={onCancelRequest}
                      disabled={isCancelling}
                      className="flex items-center gap-1.5 clip-cut-sm px-3 py-2
                                 border border-[oklch(0.65_0.22_22/0.30)]
                                 bg-[oklch(0.65_0.22_22/0.08)]
                                 font-command text-[9px] uppercase tracking-[0.10em]
                                 text-[oklch(0.75_0.18_22)]
                                 hover:bg-[oklch(0.65_0.22_22/0.15)]
                                 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Cancel
                    </button>
                    <button
                      onClick={onInputScore}
                      disabled={isCancelling}
                      className="flex items-center gap-1.5 clip-cut-sm
                                 bg-[oklch(0.16_0.018_245)] border border-[oklch(0.32_0.025_245)]
                                 px-4 py-2.5 min-h-[44px]
                                 font-command text-[9px] uppercase tracking-[0.10em]
                                 text-[oklch(0.85_0.010_245)]
                                 hover:bg-[oklch(0.20_0.018_245)]
                                 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
                         bg-[oklch(0.55_0.18_188)] hover:bg-[oklch(0.62_0.18_188)]
                         dark:bg-[oklch(0.79_0.18_188/0.20)] dark:hover:bg-[oklch(0.79_0.18_188/0.32)]
                         dark:text-[oklch(0.89_0.12_188)] dark:border dark:border-[oklch(0.79_0.18_188/0.45)]
                         px-4 py-2.5 min-h-[44px] font-command text-[10px] uppercase tracking-[0.10em] text-white
                         transition-colors"
            >
              <Plus className="h-4 w-4" />
              Call Next Match
            </button>
            <button
              onClick={() => onUpdateStatus("closed")}
              className="clip-cut-sm border border-[oklch(0.30_0.020_245)] px-3 py-2.5
                         font-command text-[9px] uppercase tracking-[0.10em]
                         text-[oklch(0.55_0.010_245)] hover:bg-[oklch(0.18_0.018_245)]
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
              className="flex-1 clip-cut-sm bg-[oklch(0.79_0.18_188/0.18)]
                         border border-[oklch(0.79_0.18_188/0.45)]
                         px-4 py-2.5 font-command text-[9px] uppercase tracking-[0.10em]
                         text-[oklch(0.89_0.12_188)] hover:bg-[oklch(0.79_0.18_188/0.28)]
                         transition-colors"
            >
              Reopen Court
            </button>
            <button
              onClick={onRemove}
              className="clip-cut-sm border border-[oklch(0.65_0.22_22/0.35)] px-3 py-2.5
                         font-command text-[9px] uppercase tracking-[0.10em]
                         text-[oklch(0.75_0.18_22)] hover:bg-[oklch(0.65_0.22_22/0.10)]
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

// ─── ActiveCourts (page-level container) ─────────────────────

export function ActiveCourts({
  courts,
  activeMatches,
  timeLimitMinutes,
  onUpdateTimeLimit,
  onAddCourt,
  onUpdateCourtStatus,
  onRemoveCourt,
  onCallNextMatch,
  onEndMatch,
  onCancelMatch,
  onClearOnDeckMatch,
}: ActiveCourtsProps) {
  // ── Add-court form ──────────────────────────────────────────
  const [newCourtName, setNewCourtName] = useState("");
  const [adding, setAdding] = useState(false);

  // ── Per-court async states ──────────────────────────────────
  const [matchmakingCourt, setMatchmakingCourt] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState<Set<string>>(new Set());
  const [cancellingCourt, setCancellingCourt] = useState<Set<string>>(new Set());
  const [clearingMatch, setClearingMatch] = useState<Set<string>>(new Set());
  const [courtErrors, setCourtErrors] = useState<Record<string, string>>({});

  // ── Score modal state ───────────────────────────────────────
  const [scoringMatchId, setScoringMatchId] = useState<string | null>(null);
  const scoringMatch =
    scoringMatchId !== null ? (activeMatches.find((m) => m.id === scoringMatchId) ?? null) : null;

  // ── Toast ───────────────────────────────────────────────────
  const [toast, setToast] = useState<Toast | null>(null);

  function showToast(t: Toast) {
    setToast(t);
    setTimeout(() => setToast(null), 5000);
  }

  // ── Helpers ─────────────────────────────────────────────────
  function setCourtError(courtId: string, msg: string | null) {
    setCourtErrors((prev) => {
      const next = { ...prev };
      if (msg === null) delete next[courtId];
      else next[courtId] = msg;
      return next;
    });
  }

  function getMatch(courtId: string): EnrichedMatch | undefined {
    // Only in_progress matches have a court_id — pending (on-deck) matches
    // have court_id=null and are displayed separately in OnDeckPanel.
    return activeMatches.find((m) => m.court_id === courtId && m.status === "in_progress");
  }

  // ── Handlers ────────────────────────────────────────────────
  async function handleAddCourt() {
    const name = newCourtName.trim();
    if (!name) return;
    setAdding(true);
    const result = await onAddCourt(name);
    if (!result.error) setNewCourtName("");
    setAdding(false);
  }

  async function handleCallNextMatch(courtId: string) {
    setMatchmakingCourt(courtId);
    setCourtError(courtId, null);
    const result = await onCallNextMatch(courtId);
    setMatchmakingCourt(null);
    if (result.success) {
      showToast({
        type: "success",
        title: "Match Created!",
        body: `${result.teamA?.join(" & ")} vs ${result.teamB?.join(" & ")}`,
      });
    } else if (result.hasDraftsBlocking) {
      // Draft Mode: no published on-deck match to promote — drafts are blocking.
      // Use amber warning (not red error) to distinguish a "needs action" state
      // from a true failure.
      showToast({
        type: "warning",
        title: "Drafts Waiting for Approval",
        body: result.message,
      });
    } else {
      showToast({ type: "error", title: "No Match Found", body: result.message });
    }
  }

  function handleCancelRequest(courtId: string) {
    setConfirmingCancel((prev) => new Set(prev).add(courtId));
  }

  async function handleCancelConfirm(courtId: string, matchId: string) {
    setConfirmingCancel((prev) => {
      const s = new Set(prev);
      s.delete(courtId);
      return s;
    });
    setCancellingCourt((prev) => new Set(prev).add(courtId));
    setCourtError(courtId, null);

    const result = await onCancelMatch(matchId);

    setCancellingCourt((prev) => {
      const s = new Set(prev);
      s.delete(courtId);
      return s;
    });

    if (result.error) {
      setCourtError(courtId, result.error);
    } else {
      showToast({ type: "success", title: "Match Cancelled", body: "Players returned to queue." });
    }
  }

  async function handleClearOnDeckMatch(courtId: string, matchId: string) {
    setClearingMatch((prev) => new Set(prev).add(matchId));
    setCourtError(courtId, null);

    const result = await onClearOnDeckMatch(matchId);

    setClearingMatch((prev) => {
      const s = new Set(prev);
      s.delete(matchId);
      return s;
    });

    if (result.error) {
      setCourtError(courtId, result.error);
    } else {
      showToast({ type: "success", title: "On-Deck Cleared", body: "Players returned to queue." });
    }
  }

  function handleCancelDismiss(courtId: string) {
    setConfirmingCancel((prev) => {
      const s = new Set(prev);
      s.delete(courtId);
      return s;
    });
  }

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* ── Toast ─────────────────────────────────────────────── */}
      {toast && (
        <div
          className={`fixed right-4 top-4 z-[150] max-w-sm rounded-xl border-2 p-4
                      shadow-xl animate-in slide-in-from-top-2 fade-in duration-300
                      ${
                        toast.type === "success"
                          ? "border-emerald-400 bg-emerald-50 dark:border-emerald-500/60 dark:bg-emerald-950/40"
                          : toast.type === "warning"
                            ? "border-amber-400 bg-amber-50 dark:border-amber-500/60 dark:bg-amber-950/40"
                            : "border-red-400 bg-red-50 dark:border-red-500/60 dark:bg-red-950/40"
                      }`}
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-xl">
              {toast.type === "success" ? "✅" : toast.type === "warning" ? "🟡" : "⚠️"}
            </span>
            <div className="flex-1 min-w-0">
              <p
                className={`text-sm font-semibold
                    ${
                      toast.type === "success"
                        ? "text-emerald-900 dark:text-emerald-300"
                        : toast.type === "warning"
                          ? "text-amber-900 dark:text-amber-300"
                          : "text-red-900 dark:text-red-300"
                    }`}
              >
                {toast.title}
              </p>
              <p
                className={`mt-0.5 text-xs
                    ${
                      toast.type === "success"
                        ? "text-emerald-700 dark:text-emerald-400"
                        : toast.type === "warning"
                          ? "text-amber-700 dark:text-amber-400"
                          : "text-red-700 dark:text-red-400"
                    }`}
              >
                {toast.body}
              </p>
            </div>
            <button
              onClick={() => setToast(null)}
              aria-label="Dismiss"
              className="text-xl leading-none text-muted-foreground hover:text-foreground"
            >
              &times;
            </button>
          </div>
        </div>
      )}

      {/* ── Add court bar ──────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-3">
          <input
            type="text"
            value={newCourtName}
            onChange={(e) => setNewCourtName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddCourt()}
            placeholder="Court name (e.g. Court 3)"
            maxLength={40}
            className="flex-1 clip-cut border border-[oklch(0.30_0.025_240)] bg-[oklch(0.14_0.018_238)] px-4 py-2.5
                       font-command text-sm text-foreground placeholder:text-muted-foreground
                       focus:outline-none focus:border-[oklch(0.79_0.18_188)] transition-colors"
          />
          <button
            onClick={handleAddCourt}
            disabled={adding || !newCourtName.trim()}
            className="whitespace-nowrap clip-cut-sm bg-[oklch(0.79_0.18_188)] px-5 py-2.5
                       font-command text-[10px] uppercase tracking-[0.10em] text-[oklch(0.07_0.012_245)]
                       hover:bg-[oklch(0.84_0.18_188)] disabled:cursor-not-allowed disabled:opacity-50
                       transition-colors"
          >
            {adding ? "Adding…" : "+ Add Court"}
          </button>
        </div>
        {/* Time limit picker */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Court time limit:</span>
          <CourtTimePopover timeLimitMinutes={timeLimitMinutes} onSave={onUpdateTimeLimit} />
        </div>
      </div>

      {/* ── Courts grid ────────────────────────────────────────── */}
      {courts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 dark:border-border bg-white/60 dark:bg-card/60 py-16 text-center shadow-sm">
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-full bg-gray-100 dark:bg-muted p-4">
              <Swords className="h-6 w-6 text-gray-400 dark:text-muted-foreground" />
            </div>
            <div>
              <p className="font-semibold text-gray-700 dark:text-foreground">No courts yet</p>
              <p className="mt-0.5 text-sm text-gray-400 dark:text-muted-foreground">
                Add a court above to get started.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {courts.map((court) => {
            const match = getMatch(court.id);
            return (
              <CourtCard
                key={court.id}
                court={court}
                match={match}
                timeLimitMinutes={timeLimitMinutes}
                isMatchmaking={matchmakingCourt === court.id}
                isConfirmingCancel={confirmingCancel.has(court.id)}
                isCancelling={cancellingCourt.has(court.id)}
                isClearing={match ? clearingMatch.has(match.id) : false}
                error={courtErrors[court.id]}
                onCallNextMatch={() => handleCallNextMatch(court.id)}
                onInputScore={() => {
                  if (match) setScoringMatchId(match.id);
                }}
                onCancelRequest={() => handleCancelRequest(court.id)}
                onCancelConfirm={() => {
                  if (match) handleCancelConfirm(court.id, match.id);
                }}
                onCancelDismiss={() => handleCancelDismiss(court.id)}
                onClearOnDeckMatch={() => {
                  if (match) handleClearOnDeckMatch(court.id, match.id);
                }}
                onUpdateStatus={(s) => onUpdateCourtStatus(court.id, s)}
                onRemove={() => onRemoveCourt(court.id)}
              />
            );
          })}
        </div>
      )}

      {/* ── Score Modal ─────────────────────────────────────────
          Rendered once at this level so it is always outside
          the grid and never affected by card-level styles.
      ─────────────────────────────────────────────────────── */}
      <ScoreModal
        open={scoringMatchId !== null}
        match={scoringMatch}
        onClose={() => setScoringMatchId(null)}
        onSubmit={async (teamAScore, teamBScore) => {
          if (!scoringMatchId) return { error: "No match selected." };
          const result = await onEndMatch(scoringMatchId, teamAScore, teamBScore);
          if (!result.error) {
            setScoringMatchId(null);
            showToast({
              type: "success",
              title: "Match Ended",
              body: `Score: ${teamAScore} – ${teamBScore}. Players back in queue.`,
            });
          }
          return result;
        }}
      />
    </div>
  );
}
