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
// ============================================================

import { useState } from "react";
import { Plus, Trophy, XCircle, Swords } from "lucide-react";
import { ScoreModal } from "./score-modal";
import { SkillBadge } from "@/components/ui/skill-badge";
import type { Court } from "@/types/database";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";
import type { MatchmakingResult } from "@/app/actions/matchmaking";

// ─── Prop types ───────────────────────────────────────────────

interface ActiveCourtsProps {
  courts: Court[];
  activeMatches: EnrichedMatch[];
  onAddCourt: (name: string) => Promise<{ error?: string }>;
  onUpdateCourtStatus: (
    courtId: string,
    status: Court["status"]
  ) => Promise<{ error?: string }>;
  onRemoveCourt: (courtId: string) => Promise<{ error?: string }>;
  onCallNextMatch: (courtId: string) => Promise<MatchmakingResult>;
  onEndMatch: (
    matchId: string,
    teamAScore: number,
    teamBScore: number
  ) => Promise<{ error?: string }>;
  onCancelMatch: (matchId: string) => Promise<{ error?: string }>;
}

interface Toast {
  type: "success" | "error";
  title: string;
  body: string;
}

// ─── CourtCard ────────────────────────────────────────────────

interface CourtCardProps {
  court: Court;
  match: EnrichedMatch | undefined;
  isMatchmaking: boolean;
  isConfirmingCancel: boolean;
  isCancelling: boolean;
  error: string | undefined;
  onCallNextMatch: () => void;
  onInputScore: () => void;
  onCancelRequest: () => void;
  onCancelConfirm: () => void;
  onCancelDismiss: () => void;
  onUpdateStatus: (s: Court["status"]) => void;
  onRemove: () => void;
}

function CourtCard({
  court,
  match,
  isMatchmaking,
  isConfirmingCancel,
  isCancelling,
  error,
  onCallNextMatch,
  onInputScore,
  onCancelRequest,
  onCancelConfirm,
  onCancelDismiss,
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

  // Status badge config per state
  const badgeCfg: Record<CardState, { cls: string; label: string }> = {
    matchmaking: { cls: "bg-amber-100 text-amber-800 border-amber-300", label: "Finding Match…" },
    in_progress: { cls: "bg-violet-100 text-violet-800 border-violet-300", label: "In Progress" },
    available:   { cls: "bg-emerald-100 text-emerald-800 border-emerald-300", label: "Available" },
    closed:      { cls: "bg-gray-100 text-gray-600 border-gray-200", label: "Closed" },
  };

  return (
    <div
      className={`flex flex-col rounded-2xl bg-white shadow-md overflow-hidden transition-all
                  ${cardState === "matchmaking" ? "animate-pulse" : ""}`}
    >
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 pt-4 pb-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-base font-bold truncate text-gray-900">{court.name}</h3>
          {match?.is_mixed_level && (
            <span className="shrink-0 rounded-full bg-amber-100 border border-amber-300 px-2 py-0.5
                            text-[10px] font-bold uppercase tracking-wider text-amber-800">
              Mixed Level
            </span>
          )}
        </div>
        <span
          className={`ml-2 shrink-0 rounded-full border px-2.5 py-0.5
                      text-[10px] font-bold uppercase tracking-widest
                      ${badgeCfg[cardState].cls}`}
        >
          {badgeCfg[cardState].label}
        </span>
      </div>

      {/* ── Body ───────────────────────────────────────────── */}
      <div className="flex-1 px-4 pb-3">

        {/* IN PROGRESS — team matchup */}
        {hasActiveMatch && (
          <div className="flex items-stretch gap-3 py-1">

            {/* Team A */}
            <div className="flex-1 rounded-xl bg-blue-50 p-4 text-center">
              <p className="mb-3 text-xs font-black tracking-wider text-slate-500 uppercase">
                Team A
              </p>
              {teamA.map((p) => (
                <div key={p.player_id} className="mb-2 last:mb-0">
                  <p className="text-lg font-bold leading-snug text-slate-900">
                    {p.profile.display_name}
                  </p>
                  <SkillBadge level={p.profile.skill_level} className="mt-0.5" />
                </div>
              ))}
            </div>

            {/* VS */}
            <div className="flex shrink-0 items-center justify-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full
                              bg-slate-800 text-sm font-bold text-white shadow-sm">
                VS
              </div>
            </div>

            {/* Team B */}
            <div className="flex-1 rounded-xl bg-rose-50 p-4 text-center">
              <p className="mb-3 text-xs font-black tracking-wider text-slate-500 uppercase">
                Team B
              </p>
              {teamB.map((p) => (
                <div key={p.player_id} className="mb-2 last:mb-0">
                  <p className="text-lg font-bold leading-snug text-slate-900">
                    {p.profile.display_name}
                  </p>
                  <SkillBadge level={p.profile.skill_level} className="mt-0.5" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* MATCHMAKING — spinner */}
        {isMatchmaking && !hasActiveMatch && (
          <div className="flex flex-col items-center justify-center gap-2 py-6">
            <div className="h-7 w-7 rounded-full border-[3px] border-amber-200 border-t-amber-600 animate-spin" />
            <p className="text-sm font-medium text-amber-700">Running algorithm…</p>
          </div>
        )}

        {/* AVAILABLE — dashed placeholder with icon */}
        {!hasActiveMatch && !isMatchmaking && cardState === "available" && (
          <div className="flex flex-col items-center justify-center gap-2 py-6">
            <div className="rounded-full bg-emerald-50 border border-emerald-200 p-2.5">
              <Swords className="h-5 w-5 text-emerald-400" />
            </div>
            <p className="text-sm font-medium text-emerald-600">Ready for next match</p>
          </div>
        )}

        {/* CLOSED — placeholder */}
        {!hasActiveMatch && cardState === "closed" && (
          <div className="flex items-center justify-center py-6">
            <p className="text-sm text-muted-foreground">Court is closed</p>
          </div>
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────── */}
      <div className="px-4 pb-4 space-y-2">
        {/* Inline error */}
        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
            {error}
          </p>
        )}

        {/* IN PROGRESS actions */}
        {hasActiveMatch && match && (
          <>
            {isConfirmingCancel ? (
              /* Two-step cancel confirmation */
              <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
                <p className="text-center text-xs font-semibold text-red-800">
                  Cancel this match? Players return to queue.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={onCancelConfirm}
                    disabled={isCancelling}
                    className="flex-1 rounded-lg bg-red-600 py-2 text-xs font-semibold
                               text-white hover:bg-red-700 disabled:opacity-50
                               disabled:cursor-not-allowed transition-colors"
                  >
                    {isCancelling ? "Cancelling…" : "Yes, Cancel"}
                  </button>
                  <button
                    onClick={onCancelDismiss}
                    disabled={isCancelling}
                    className="flex-1 rounded-lg border border-gray-200 bg-white py-2 text-xs
                               font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50
                               disabled:cursor-not-allowed transition-colors"
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
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2
                             text-xs font-medium text-slate-500 hover:bg-slate-100
                             disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Cancel
                </button>
                <button
                  onClick={onInputScore}
                  disabled={isCancelling}
                  className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2
                             text-xs font-semibold text-white hover:bg-slate-800
                             disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                >
                  <Trophy className="h-3.5 w-3.5" />
                  Input Score &amp; End
                </button>
              </div>
            )}
          </>
        )}

        {/* AVAILABLE action */}
        {!hasActiveMatch && !isMatchmaking && cardState === "available" && (
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={onCallNextMatch}
              className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-500
                         to-emerald-600 px-4 py-2.5 text-sm font-semibold text-white
                         hover:from-emerald-600 hover:to-emerald-700
                         transition-all shadow-sm hover:shadow-md"
            >
              <Plus className="h-4 w-4" />
              Call Next Match
            </button>
            <button
              onClick={() => onUpdateStatus("closed")}
              className="rounded-xl border border-gray-200 px-3 py-2.5 text-xs
                         text-gray-500 hover:bg-gray-50 transition-colors"
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
              className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-xs font-semibold
                         text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Reopen Court
            </button>
            <button
              onClick={onRemove}
              className="rounded-xl border border-destructive/30 px-3 py-2.5 text-xs
                         text-destructive hover:bg-destructive/10 transition-colors"
            >
              Remove
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ActiveCourts (page-level container) ─────────────────────

export function ActiveCourts({
  courts,
  activeMatches,
  onAddCourt,
  onUpdateCourtStatus,
  onRemoveCourt,
  onCallNextMatch,
  onEndMatch,
  onCancelMatch,
}: ActiveCourtsProps) {
  // ── Add-court form ──────────────────────────────────────────
  const [newCourtName, setNewCourtName] = useState("");
  const [adding, setAdding] = useState(false);

  // ── Per-court async states ──────────────────────────────────
  const [matchmakingCourt, setMatchmakingCourt] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState<Set<string>>(new Set());
  const [cancellingCourt, setCancellingCourt] = useState<Set<string>>(new Set());
  const [courtErrors, setCourtErrors] = useState<Record<string, string>>({});

  // ── Score modal state ───────────────────────────────────────
  const [scoringMatchId, setScoringMatchId] = useState<string | null>(null);
  const scoringMatch =
    scoringMatchId !== null
      ? (activeMatches.find((m) => m.id === scoringMatchId) ?? null)
      : null;

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
    return activeMatches.find(
      (m) => m.court_id === courtId && m.status === "in_progress"
    );
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
                      ${toast.type === "success"
                        ? "border-emerald-400 bg-emerald-50"
                        : "border-red-400 bg-red-50"}`}
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-xl">
              {toast.type === "success" ? "✅" : "⚠️"}
            </span>
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-semibold
                  ${toast.type === "success" ? "text-emerald-900" : "text-red-900"}`}>
                {toast.title}
              </p>
              <p className={`mt-0.5 text-xs
                  ${toast.type === "success" ? "text-emerald-700" : "text-red-700"}`}>
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
      <div className="flex gap-3">
        <input
          type="text"
          value={newCourtName}
          onChange={(e) => setNewCourtName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAddCourt()}
          placeholder="Court name (e.g. Court 3)"
          className="flex-1 rounded-xl border border-input bg-white px-4 py-2.5
                     text-sm placeholder:text-muted-foreground focus:outline-none
                     focus:ring-2 focus:ring-ring shadow-sm"
        />
        <button
          onClick={handleAddCourt}
          disabled={adding || !newCourtName.trim()}
          className="whitespace-nowrap rounded-xl bg-primary px-5 py-2.5 text-sm
                     font-semibold text-primary-foreground hover:bg-primary/90
                     disabled:cursor-not-allowed disabled:opacity-50 transition-colors shadow-sm"
        >
          {adding ? "Adding…" : "+ Add Court"}
        </button>
      </div>

      {/* ── Courts grid ────────────────────────────────────────── */}
      {courts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white/60 py-16 text-center shadow-sm">
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-full bg-gray-100 p-4">
              <Swords className="h-6 w-6 text-gray-400" />
            </div>
            <div>
              <p className="font-semibold text-gray-700">No courts yet</p>
              <p className="mt-0.5 text-sm text-gray-400">
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
                isMatchmaking={matchmakingCourt === court.id}
                isConfirmingCancel={confirmingCancel.has(court.id)}
                isCancelling={cancellingCourt.has(court.id)}
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
