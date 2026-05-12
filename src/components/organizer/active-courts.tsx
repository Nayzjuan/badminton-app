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
            className="flex-1 clip-cut border border-cc-border bg-cc-bg-2 px-4 py-2.5
                       font-command text-sm text-cc-t1 placeholder:text-cc-t3
                       focus:outline-none focus:border-cc-accent transition-colors"
          />
          <button
            onClick={handleAddCourt}
            disabled={adding || !newCourtName.trim()}
            className="whitespace-nowrap clip-cut-sm bg-cc-accent hover:brightness-110 px-5 py-2.5
                       font-command text-[10px] uppercase tracking-[0.12em] text-cc-btn-on-accent
                       disabled:cursor-not-allowed disabled:opacity-50 transition-all"
          >
            {adding ? "Adding…" : "+ Add Court"}
          </button>
        </div>
        {/* Time limit picker */}
        <div className="flex items-center gap-2">
          <span className="font-command text-[10px] uppercase tracking-[0.18em] text-cc-t3">
            Court time limit:
          </span>
          <CourtTimePopover timeLimitMinutes={timeLimitMinutes} onSave={onUpdateTimeLimit} />
        </div>
      </div>

      {/* ── Section header — amber bar matches preview .section-label.amber-bar ── */}
      <div className="flex items-center gap-3.5">
        <span className="flex items-center gap-2.5 font-command text-[9px] uppercase tracking-[0.24em] text-cc-t3 shrink-0">
          <span
            className="block w-[3px] h-[14px] rounded-[1px] bg-cc-amber
                       shadow-[0_0_8px_var(--cc-amber-dim)]"
          />
          Active Courts
        </span>
        <div className="flex-1 h-px bg-cc-border" />
      </div>

      {/* ── Courts grid ────────────────────────────────────────── */}
      {courts.length === 0 ? (
        <div className="clip-cut border border-dashed border-cc-border bg-cc-bg-2 py-16 text-center">
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-full bg-cc-bg-3 p-4">
              <Swords className="h-6 w-6 text-cc-t3" />
            </div>
            <div>
              <p className="font-command text-sm font-bold uppercase tracking-[0.12em] text-cc-t1">
                No courts yet
              </p>
              <p className="mt-0.5 font-command text-[10px] uppercase tracking-[0.14em] text-cc-t3">
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
