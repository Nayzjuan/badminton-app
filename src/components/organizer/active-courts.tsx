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

import { useMemo, useState } from "react";
import { TOAST_DISMISS_MS } from "@/lib/constants";
import { Swords } from "lucide-react";
import { toast } from "sonner";
import { ScoreModal } from "./score-modal";
import { LiveSwapSheet } from "./live-swap-sheet";
import { CourtTimePopover } from "@/components/ui/court-time-popover";
import { useLiveMatchSwap } from "@/hooks/use-live-match-swap";
import type { Court, QueueFullWithWaitTime } from "@/types/database";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";
import type { MatchmakingResult } from "@/app/actions/matchmaking";
import type { RosterPlayer } from "@/components/organizer/match-roster";
import { CourtCard } from "./court-card";

// ─── Prop types ───────────────────────────────────────────────

interface ActiveCourtsProps {
  courts: Court[];
  activeMatches: EnrichedMatch[];
  /** Published on-deck (pending) matches — used as swap candidate source. */
  onDeckMatches: EnrichedMatch[];
  /** Full session queue — filtered internally to waiting players. */
  queuePlayers: QueueFullWithWaitTime[];
  /** Current session ID — required for live swap server actions. */
  sessionId: string;
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

type Toast = {
  type: "success" | "error" | "warning";
  title: string;
  body: string;
};

// ─── ActiveCourts (page-level container) ─────────────────────

export function ActiveCourts({
  courts,
  activeMatches,
  onDeckMatches,
  queuePlayers,
  sessionId,
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
  const [updatingStatusCourt, setUpdatingStatusCourt] = useState<Set<string>>(new Set());
  const [removingCourt, setRemovingCourt] = useState<Set<string>>(new Set());
  const [courtErrors, setCourtErrors] = useState<Record<string, string>>({});

  // ── Score modal state ───────────────────────────────────────
  const [scoringMatchId, setScoringMatchId] = useState<string | null>(null);
  const scoringMatch =
    scoringMatchId !== null ? (activeMatches.find((m) => m.id === scoringMatchId) ?? null) : null;

  // ── Live swap state ─────────────────────────────────────────
  // Set of all player IDs currently in ANY in_progress match —
  // used to exclude them from swap candidate lists.
  const activePlayerIds = useMemo<Set<string>>(() => {
    const ids = new Set<string>();
    for (const m of activeMatches) {
      if (m.status === "in_progress") {
        for (const p of m.players) ids.add(p.player_id);
      }
    }
    return ids;
  }, [activeMatches]);

  const liveSwap = useLiveMatchSwap({
    sessionId,
    onSuccess: (undoCtx) => {
      const description =
        undoCtx.type === "team_swap"
          ? `${undoCtx.playerAName} ↔ ${undoCtx.playerBName} switched teams`
          : undoCtx.type === "queue_replacement"
            ? `${undoCtx.outPlayerName} → queue · ${undoCtx.inPlayerName} → court`
            : `${undoCtx.outPlayerName} → queue · ${undoCtx.onDeckPlayerName} → court`;

      toast.success("Swap complete", {
        description,
        duration: 3000,
        action: {
          label: "Undo",
          onClick: () => liveSwap.undo(undoCtx),
        },
      });
    },
  });

  function handleLongPressPlayer(courtMatch: EnrichedMatch, player: RosterPlayer, team: "a" | "b") {
    liveSwap.open(player, team, courtMatch);
  }

  // ── Local banner toast (distinct from Sonner's `toast` import) ──
  const [banner, setBanner] = useState<Toast | null>(null);

  function showToast(t: Toast) {
    setBanner(t);
    setTimeout(() => setBanner(null), TOAST_DISMISS_MS);
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

  async function handleUpdateCourtStatus(courtId: string, status: Court["status"]) {
    setUpdatingStatusCourt((prev) => new Set(prev).add(courtId));
    setCourtError(courtId, null);
    const result = await onUpdateCourtStatus(courtId, status);
    setUpdatingStatusCourt((prev) => {
      const next = new Set(prev);
      next.delete(courtId);
      return next;
    });
    if (result.error) {
      setCourtError(courtId, result.error);
      showToast({ type: "error", title: "Court Update Failed", body: result.error });
    }
  }

  async function handleRemoveCourt(courtId: string) {
    setRemovingCourt((prev) => new Set(prev).add(courtId));
    setCourtError(courtId, null);
    const result = await onRemoveCourt(courtId);
    setRemovingCourt((prev) => {
      const next = new Set(prev);
      next.delete(courtId);
      return next;
    });
    if (result.error) {
      setCourtError(courtId, result.error);
      showToast({ type: "error", title: "Remove Court Failed", body: result.error });
    }
  }

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* ── Banner toast (local inline — distinct from Sonner toasts) ── */}
      {banner && (
        <div
          className={`fixed right-4 top-4 z-[150] max-w-sm rounded-xl border-2 p-4
                      shadow-xl animate-in slide-in-from-top-2 fade-in duration-300
                      ${
                        banner.type === "success"
                          ? "border-emerald-400 bg-emerald-50 dark:border-emerald-500/60 dark:bg-emerald-950/40"
                          : banner.type === "warning"
                            ? "border-amber-400 bg-amber-50 dark:border-amber-500/60 dark:bg-amber-950/40"
                            : "border-red-400 bg-red-50 dark:border-red-500/60 dark:bg-red-950/40"
                      }`}
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-xl">
              {banner.type === "success" ? "✅" : banner.type === "warning" ? "🟡" : "⚠️"}
            </span>
            <div className="flex-1 min-w-0">
              <p
                className={`text-sm font-semibold
                    ${
                      banner.type === "success"
                        ? "text-emerald-900 dark:text-emerald-300"
                        : banner.type === "warning"
                          ? "text-amber-900 dark:text-amber-300"
                          : "text-red-900 dark:text-red-300"
                    }`}
              >
                {banner.title}
              </p>
              <p
                className={`mt-0.5 text-xs
                    ${
                      banner.type === "success"
                        ? "text-emerald-700 dark:text-emerald-400"
                        : banner.type === "warning"
                          ? "text-amber-700 dark:text-amber-400"
                          : "text-red-700 dark:text-red-400"
                    }`}
              >
                {banner.body}
              </p>
            </div>
            <button
              onClick={() => setBanner(null)}
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
                isUpdatingStatus={updatingStatusCourt.has(court.id)}
                isRemoving={removingCourt.has(court.id)}
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
                onUpdateStatus={(s) => handleUpdateCourtStatus(court.id, s)}
                onRemove={() => handleRemoveCourt(court.id)}
                onLongPressPlayer={
                  match ? (player, team) => handleLongPressPlayer(match, player, team) : undefined
                }
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

      {/* ── Live Swap Sheet ─────────────────────────────────────
          Rendered at this level (outside the grid) so the Sheet
          portal never interacts with card-level overflow/clip-path.
          The sheet is driven by liveSwap state from the hook.
      ─────────────────────────────────────────────────────── */}
      <LiveSwapSheet
        state={liveSwap.state}
        onDeckMatches={onDeckMatches}
        queuePlayers={queuePlayers}
        activePlayerIds={activePlayerIds}
        isSubmitting={liveSwap.isSubmitting}
        canConfirm={liveSwap.canConfirm}
        onSelectReplacement={liveSwap.selectReplacement}
        onSelectFill={liveSwap.selectFill}
        onConfirm={liveSwap.confirm}
        onClose={liveSwap.close}
      />
    </div>
  );
}
