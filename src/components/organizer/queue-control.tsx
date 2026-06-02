"use client";

// ============================================================
// Queue & Match Control Center
// ============================================================
// Live-updating queue list with checkbox selection for manual
// match creation. Organizer selects exactly 4 players, picks
// a court, and creates a custom match.
// Skill levels are editable inline via dropdown.
// ============================================================

import { useState } from "react";
import { toast } from "sonner";
import { LogOut, PauseCircle, PlayCircle } from "lucide-react";
import { PLAYERS_PER_MATCH } from "@/lib/constants";
import { VipTag } from "@/components/ui/vip-tag";
import { SKILL_LEVELS } from "@/types/database";
import { updatePlayerSkill, getPlayerPin, resetPlayerPin } from "@/app/actions/profile";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { QueueFullWithWaitTime, SkillLevel, Profile } from "@/types/database";

// Re-export constant for clarity in this file.
const REQUIRED_PLAYERS = PLAYERS_PER_MATCH; // 4

interface QueueControlProps {
  /** Session ID used to verify organizer status before profile mutations. */
  sessionId: string;
  queue: QueueFullWithWaitTime[];
  /** Full profiles map (from useOrganizerData) for VIP tag lookup. */
  profiles?: Map<string, Profile>;
  onCreateManualMatch: (teamA: string[], teamB: string[]) => Promise<{ error?: string }>;
  onRemoveFromQueue: (playerId: string) => Promise<{ error?: string }>;
  onPausePlayer: (playerId: string, isPaused: boolean) => Promise<{ error?: string }>;
  /**
   * The organizer's own player_id. When provided, a "Join Queue" nudge is
   * shown whenever the organizer is not already in the queue. Lets the
   * organizer play in their own session without switching devices.
   */
  organizerPlayerId?: string;
  /** Called when the organizer clicks "Join Queue". */
  onJoinQueue?: () => Promise<void>;
}

export function QueueControl({
  sessionId,
  queue,
  profiles,
  onCreateManualMatch,
  onRemoveFromQueue,
  onPausePlayer,
  organizerPlayerId,
  onJoinQueue,
}: QueueControlProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joiningQueue, setJoiningQueue] = useState(false);
  const [pausingPlayers, setPausingPlayers] = useState<Set<string>>(new Set());
  const [removingPlayer, setRemovingPlayer] = useState<string | null>(null);

  function togglePlayer(playerId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else {
        if (next.size >= REQUIRED_PLAYERS) return prev; // cap at 4
        next.add(playerId);
      }
      return next;
    });
  }

  // Track which player is currently being updated to show loading state.
  const [updatingSkill, setUpdatingSkill] = useState<string | null>(null);

  // PIN management state.
  const [visiblePins, setVisiblePins] = useState<Map<string, string>>(new Map());
  const [loadingPin, setLoadingPin] = useState<string | null>(null);

  async function handleSkillChange(playerId: string, newSkill: SkillLevel) {
    setUpdatingSkill(playerId);
    await updatePlayerSkill(sessionId, playerId, newSkill);
    setUpdatingSkill(null);
  }

  async function handleRevealPin(playerId: string) {
    if (visiblePins.has(playerId)) {
      // Toggle off.
      setVisiblePins((prev) => {
        const next = new Map(prev);
        next.delete(playerId);
        return next;
      });
      return;
    }
    setLoadingPin(playerId);
    const result = await getPlayerPin(sessionId, playerId);
    setLoadingPin(null);
    if (result.success && result.pin) {
      setVisiblePins((prev) => new Map(prev).set(playerId, result.pin!));
    }
  }

  async function handleResetPin(playerId: string) {
    setLoadingPin(playerId);
    const result = await resetPlayerPin(sessionId, playerId);
    setLoadingPin(null);
    if (result.success && result.pin) {
      setVisiblePins((prev) => new Map(prev).set(playerId, result.pin!));
    }
  }

  async function handleCreateMatch() {
    if (selected.size !== REQUIRED_PLAYERS) return;

    setCreating(true);
    setError(null);

    // Split into teams: first 2 selected = Team A, last 2 = Team B.
    const playerIds = Array.from(selected);
    const teamA = playerIds.slice(0, 2);
    const teamB = playerIds.slice(2, 4);

    const result = await onCreateManualMatch(teamA, teamB);
    if (result.error) {
      setError(result.error);
    } else {
      setSelected(new Set());
    }
    setCreating(false);
  }

  async function handleJoinQueue() {
    if (!onJoinQueue) return;
    setJoiningQueue(true);
    await onJoinQueue();
    setJoiningQueue(false);
  }

  async function handlePausePlayer(playerId: string, isPaused: boolean) {
    setPausingPlayers((prev) => new Set(prev).add(playerId));
    const result = await onPausePlayer(playerId, isPaused);
    setPausingPlayers((prev) => {
      const next = new Set(prev);
      next.delete(playerId);
      return next;
    });
    if (result?.error) toast.error(result.error);
  }

  async function handleRemoveFromQueue(playerId: string) {
    setRemovingPlayer(playerId);
    const result = await onRemoveFromQueue(playerId);
    setRemovingPlayer(null);
    if (result?.error) toast.error(result.error);
  }

  // Is the organizer already in the queue (any status)?
  const organizerInQueue =
    !!organizerPlayerId && queue.some((q) => q.player_id === organizerPlayerId);

  // Sort: locked (on_deck/drafted) always float to the top; paused waiting
  // players sink to the bottom; everything else preserves view order.
  const sortedQueue = [...queue].sort((a, b) => {
    if (a.status_priority !== b.status_priority) return a.status_priority - b.status_priority;
    if (a.is_paused && !b.is_paused) return 1;
    if (!a.is_paused && b.is_paused) return -1;
    return 0;
  });

  return (
    <div className="space-y-5">
      {/* Manual Match Bar */}
      <div
        className={`rounded-xl border-2 p-4 transition-colors ${
          selected.size === REQUIRED_PLAYERS
            ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-500/60"
            : selected.size > 0
              ? "border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-500/60"
              : "border-border bg-card"
        }`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {selected.size === 0
                ? "Select 4 players to create a manual match"
                : `${selected.size} of ${REQUIRED_PLAYERS} players selected`}
            </p>
            {selected.size > 0 && selected.size < REQUIRED_PLAYERS && (
              <p className="text-xs text-muted-foreground">
                Select {REQUIRED_PLAYERS - selected.size} more
              </p>
            )}
          </div>

          {selected.size === REQUIRED_PLAYERS && (
            <button
              onClick={handleCreateMatch}
              disabled={creating}
              className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white
                         hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed
                         whitespace-nowrap transition-colors"
            >
              {creating ? "Adding..." : "Add to On Deck"}
            </button>
          )}

          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Clear
            </button>
          )}
        </div>

        {error && <p className="text-sm text-destructive mt-2">{error}</p>}
      </div>

      {/* Organizer self-join nudge ─────────────────────────────
          Shown only when: organizerPlayerId is provided AND the
          organizer is not already in the queue.
          Lets the organizer play in their own session from the
          same device without needing to navigate to the player view. */}
      {organizerPlayerId && onJoinQueue && !organizerInQueue && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800/40 dark:bg-amber-950/20">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              You&apos;re not in the queue
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Join to play in your own session
            </p>
          </div>
          <button
            onClick={handleJoinQueue}
            disabled={joiningQueue}
            className="shrink-0 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold
                       text-[#0E1C3A] transition-colors hover:bg-amber-600
                       disabled:cursor-not-allowed disabled:opacity-50
                       min-h-[44px] flex items-center"
          >
            {joiningQueue ? "Joining…" : "Join Queue"}
          </button>
        </div>
      )}

      {/* Queue Table */}
      {queue.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <p className="text-muted-foreground">Queue is empty. Waiting for players to join.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          {/* overflow-x-auto lets the table scroll horizontally on narrow viewports
              instead of squishing the 8 columns into unreadable widths. */}
          <div className="overflow-x-auto -mx-px">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="px-4 py-3 text-left w-12"></th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">#</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Player</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Skill</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Wait</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Games</th>
                  <th className="px-4 py-3 text-center font-medium text-muted-foreground hidden lg:table-cell">
                    PIN
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground w-16"></th>
                </tr>
              </thead>
              <tbody>
                {sortedQueue.map((entry, index) => {
                  const isSelected = selected.has(entry.player_id);
                  const isFull = selected.size >= REQUIRED_PLAYERS;
                  const waitMin = Math.floor(entry.wait_minutes);
                  const isPaused = entry.is_paused;
                  // on_deck / drafted rows are visible but not selectable for manual matches.
                  const isLocked = entry.status === "on_deck" || entry.status === "drafted";

                  return (
                    <tr
                      key={entry.id}
                      tabIndex={isPaused || isLocked ? -1 : 0}
                      role="row"
                      aria-selected={isSelected}
                      aria-disabled={isPaused || isLocked ? "true" : undefined}
                      className={`border-b border-border last:border-b-0 transition-colors
                                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset
                                ${
                                  isLocked
                                    ? entry.status === "on_deck"
                                      ? "bg-amber-50/60 dark:bg-amber-950/20 cursor-default"
                                      : "bg-slate-50 dark:bg-muted/20 cursor-default"
                                    : isPaused
                                      ? "opacity-50 bg-slate-50 dark:bg-muted/20 cursor-default"
                                      : isSelected
                                        ? "bg-emerald-50 dark:bg-emerald-950/30 cursor-pointer"
                                        : "hover:bg-muted/30 cursor-pointer"
                                }
                                ${!isPaused && !isLocked && entry.is_bottleneck ? "!bg-red-50 dark:!bg-red-950/25" : ""}`}
                      onClick={() => !isPaused && !isLocked && togglePlayer(entry.player_id)}
                      onKeyDown={(e) => {
                        if (!isPaused && !isLocked && (e.key === " " || e.key === "Enter")) {
                          e.preventDefault();
                          togglePlayer(entry.player_id);
                        }
                      }}
                    >
                      {/* Checkbox — omitted for locked rows (on_deck / drafted) */}
                      <td className="px-4 py-3">
                        {isLocked ? null : (
                          /*
                           * Hit-area container: z-10 ensures this cell sits above any
                           * adjacent td overflow; stopPropagation here is the PRIMARY
                           * isolation point that prevents clicks from reaching the <tr>
                           * onClick and causing a double-toggle.
                           */
                          <div
                            className="relative z-10 flex items-center justify-center"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <label
                              htmlFor={`select-${entry.player_id}`}
                              className="relative flex h-5 w-5 cursor-pointer"
                            >
                              <input
                                id={`select-${entry.player_id}`}
                                type="checkbox"
                                className="sr-only"
                                checked={isSelected}
                                disabled={!isSelected && isFull}
                                onChange={() => togglePlayer(entry.player_id)}
                                /*
                                 * Belt-and-suspenders: the outer div already stops the
                                 * original click, but the browser fires a second synthetic
                                 * click directly on this input (label → input activation).
                                 * Stopping it here prevents that synthetic click from
                                 * bubbling past this cell and reaching the <tr>.
                                 */
                                onClick={(e) => e.stopPropagation()}
                                aria-label={`Select ${entry.display_name}`}
                              />
                              {/* Visual checkbox — aria-hidden so the native input owns semantics */}
                              <div
                                aria-hidden="true"
                                className={`h-5 w-5 rounded border-2 flex items-center justify-center transition-colors
                                          ${
                                            isSelected
                                              ? "bg-emerald-600 border-emerald-600"
                                              : isFull
                                                ? "border-muted bg-muted/50 cursor-not-allowed"
                                                : "border-border hover:border-primary"
                                          }`}
                              >
                                {isSelected && (
                                  <svg
                                    className="h-3 w-3 text-white"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={3}
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      d="M5 13l4 4L19 7"
                                    />
                                  </svg>
                                )}
                              </div>
                            </label>
                          </div>
                        )}
                      </td>
                      {/* Position */}
                      <td className="px-4 py-3 text-muted-foreground">{index + 1}</td>
                      {/* Name */}
                      <td className="px-4 py-3 font-medium">
                        <span className="flex items-center gap-2">
                          {entry.display_name}
                          {(() => {
                            const p = profiles?.get(entry.player_id);
                            return p?.vip_tag && p?.vip_theme ? (
                              <VipTag tag={p.vip_tag} theme={p.vip_theme} />
                            ) : null;
                          })()}
                          {entry.status === "on_deck" && (
                            <span
                              className="rounded-full bg-amber-100 dark:bg-amber-900/50 px-2 py-0.5
                                         text-[10px] font-bold uppercase tracking-wide
                                         text-amber-700 dark:text-amber-300"
                            >
                              On Deck
                            </span>
                          )}
                          {entry.status === "drafted" && (
                            <span
                              className="rounded-full bg-slate-200 dark:bg-slate-700 px-2 py-0.5
                                         text-[10px] font-bold uppercase tracking-wide
                                         text-slate-500 dark:text-slate-400"
                            >
                              Drafted
                            </span>
                          )}
                          {isPaused && (
                            <span
                              className="rounded-full bg-slate-200 dark:bg-slate-700 px-2 py-0.5
                                         text-[10px] font-bold uppercase tracking-wide
                                         text-slate-500 dark:text-slate-400"
                            >
                              Paused
                            </span>
                          )}
                        </span>
                      </td>
                      {/* Skill — editable dropdown */}
                      <td className="px-4 py-3">
                        <select
                          value={entry.skill_level}
                          onChange={(e) => {
                            e.stopPropagation();
                            handleSkillChange(entry.player_id, e.target.value as SkillLevel);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          disabled={updatingSkill === entry.player_id}
                          className={`rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs
                                    font-medium text-slate-700 cursor-pointer
                                    dark:border-border dark:bg-input dark:text-foreground
                                    focus:outline-none focus:ring-2 focus:ring-ring
                                    disabled:opacity-50 disabled:cursor-wait
                                    ${updatingSkill === entry.player_id ? "animate-pulse" : ""}`}
                        >
                          {SKILL_LEVELS.map((sl) => (
                            <option key={sl.value} value={sl.value}>
                              {sl.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      {/* Wait time */}
                      <td className="px-4 py-3 text-right tabular-nums">
                        <span
                          className={
                            entry.is_bottleneck ? "text-red-600 dark:text-red-400 font-bold" : ""
                          }
                        >
                          {waitMin}m
                        </span>
                      </td>
                      {/* Games */}
                      <td className="px-4 py-3 text-right tabular-nums">{entry.games_played}</td>
                      {/* PIN — hidden on narrow viewports, visible lg+ */}
                      <td
                        className="px-4 py-3 text-center hidden lg:table-cell"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-center gap-1">
                          {loadingPin === entry.player_id ? (
                            <span className="text-xs text-muted-foreground animate-pulse">...</span>
                          ) : visiblePins.has(entry.player_id) ? (
                            <>
                              <span className="font-mono text-xs font-medium">
                                {visiblePins.get(entry.player_id)}
                              </span>
                              <button
                                onClick={() => handleRevealPin(entry.player_id)}
                                className="min-w-[44px] min-h-[44px] flex items-center justify-center
                                         text-muted-foreground hover:text-foreground transition-colors
                                         rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                title="Hide PIN"
                                aria-label="Hide PIN"
                              >
                                <svg
                                  className="h-3.5 w-3.5"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                  strokeWidth={2}
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                                  />
                                </svg>
                              </button>
                              <button
                                onClick={() => handleResetPin(entry.player_id)}
                                className="min-w-[44px] min-h-[44px] flex items-center justify-center
                                         text-muted-foreground hover:text-amber-600 transition-colors
                                         rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                title="Reset PIN"
                                aria-label="Reset PIN"
                              >
                                <svg
                                  className="h-3.5 w-3.5"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                  strokeWidth={2}
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                                  />
                                </svg>
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => handleRevealPin(entry.player_id)}
                              className="min-w-[44px] min-h-[44px] flex items-center justify-center
                                       text-muted-foreground hover:text-foreground transition-colors
                                       rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              title="Reveal PIN"
                              aria-label="Reveal PIN"
                            >
                              <svg
                                className="h-3.5 w-3.5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                                />
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                                />
                              </svg>
                            </button>
                          )}
                        </div>
                      </td>
                      {/* Pause + Checkout actions */}
                      <td className="px-2 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-0.5">
                          {/* ── Pause / Resume toggle ────────────────────────────
                            Soft-pause: player stays visible but is removed from
                            matchmaking eligibility. joined_at + games_played are
                            never touched — queue position is fully preserved.
                            No confirmation dialog needed — it's instantly reversible. */}
                          <button
                            onClick={() => handlePausePlayer(entry.player_id, !isPaused)}
                            disabled={pausingPlayers.has(entry.player_id)}
                            className="min-w-[44px] min-h-[44px] flex items-center justify-center
                                     transition-colors rounded
                                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                                     text-muted-foreground hover:text-amber-500
                                     disabled:opacity-50 disabled:cursor-not-allowed"
                            title={
                              isPaused
                                ? `Resume ${entry.display_name}`
                                : `Pause ${entry.display_name}`
                            }
                            aria-label={
                              isPaused
                                ? `Resume ${entry.display_name}`
                                : `Pause ${entry.display_name}`
                            }
                          >
                            {isPaused ? (
                              <PlayCircle className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                              <PauseCircle className="h-3.5 w-3.5" />
                            )}
                          </button>

                          {/* ── Checkout (permanent) — hidden for on_deck/drafted rows.
                              Cancel the on-deck match first before checking out. */}
                          {!isLocked && (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <button
                                  className="min-w-[44px] min-h-[44px] flex items-center justify-center
                                         text-muted-foreground hover:text-red-600 transition-colors
                                         rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  title="Checkout — player has left the gym"
                                  aria-label={`Checkout ${entry.display_name}`}
                                >
                                  <LogOut className="h-3.5 w-3.5" />
                                </button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    Checkout {entry.display_name}?
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This will remove them from the queue. If they are currently in a
                                    match, the match will not be affected. They can rejoin later
                                    using their name and PIN.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => handleRemoveFromQueue(entry.player_id)}
                                    disabled={removingPlayer === entry.player_id}
                                    className="bg-red-600 hover:bg-red-700 focus:ring-red-600
                                               disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    {removingPlayer === entry.player_id ? "Removing…" : "Checkout"}
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* /overflow-x-auto */}
        </div>
      )}
    </div>
  );
}
