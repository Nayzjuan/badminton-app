"use client";

// ============================================================
// Queue & Match Control Center
// ============================================================
// Live-updating queue list with checkbox selection for manual
// match creation. Organizer selects exactly 4 players, picks
// a court, and creates a custom match.
// Skill levels are editable inline via dropdown.
//
// SELECTION IS FOUR POSITIONAL SLOTS — [A1, A2, B1, B2] — not an
// insertion-ordered Set. Deselecting frees THAT slot and leaves the other
// three on their teams; the next tap fills the first free slot. With a Set,
// deselecting pick #2 silently promoted a Team-B player into Team A, which
// made both the team preview and the repeat warnings lie. A derived Set is
// still handed to the child renderers so their prop contract is unchanged.
//
// REPEAT-PAIRING WARNING (advisory, never blocking): when the picks would
// re-create a pairing the engine itself has stopped making, the sticky bar
// headlines it and the bench rows get markers. It never disables a row it
// warns about, never disables the CTA, and never rejects creation — see
// use-repeat-pairing.ts for the avoidability gate that keeps it quiet when
// the organizer has no better option.
// ============================================================

import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { LogOut, PauseCircle, PlayCircle } from "lucide-react";
import { PLAYERS_PER_MATCH } from "@/lib/constants";
import { VipTag } from "@/components/ui/vip-tag";
import { SKILL_LEVELS } from "@/types/database";
import { QueueSkillGroups } from "@/components/organizer/queue-skill-groups";
import { ManualMatchBar } from "@/components/organizer/manual-match-bar";
import { RepeatPairDetails } from "@/components/organizer/repeat-pair-details";
import { RepeatMarker, RepeatMarkerLegend } from "@/components/organizer/repeat-marker";
import { usePairCounts } from "@/hooks/use-pair-counts";
import { useRepeatPairing } from "@/hooks/use-repeat-pairing";
import { deriveTeams, EMPTY_SLOTS, filledCount, type Slots } from "@/lib/repeat-pairing";
import {
  updatePlayerSkill,
  getPlayerPin,
  resetPlayerPin,
  updatePlayerPin,
} from "@/app/actions/profile";
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
  /**
   * Monotonic counter from useOrganizerData — ticks on every matches /
   * match_players realtime event and after each committed-match mutation.
   * Drives the repeat-pairing counts refetch WITHOUT a sixth realtime channel.
   */
  matchesRevision?: number;
  /**
   * True while the engine's partner-pair cap-saturation notice is showing.
   * That notice already instructs the organizer to override manually, so the
   * repeat warning is suppressed entirely for its duration.
   */
  capSaturationActive?: boolean;
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
  matchesRevision = 0,
  capSaturationActive = false,
}: QueueControlProps) {
  // Four positional slots: [A1, A2, B1, B2]. null = free.
  const [slots, setSlots] = useState<Slots>(EMPTY_SLOTS);
  // Bumped ONLY by user-initiated selection changes, so the live region can
  // stay silent when a background counts refetch changes the derived text.
  const [selectionEpoch, setSelectionEpoch] = useState(0);
  // Which queue lens is showing. Always opens on "list"; not persisted.
  const [view, setView] = useState<"list" | "skill">("list");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joiningQueue, setJoiningQueue] = useState(false);
  const [pausingPlayers, setPausingPlayers] = useState<Set<string>>(new Set());
  const [removingPlayer, setRemovingPlayer] = useState<string | null>(null);

  // Derived Set — QueueSkillGroups and the table rows keep their existing
  // `selected` contract; only this component knows about slots.
  const selected = useMemo(() => new Set(slots.filter((x): x is string => !!x)), [slots]);
  const filled = filledCount(slots);
  const isFull = filled >= REQUIRED_PLAYERS;

  function togglePlayer(playerId: string) {
    setSelectionEpoch((n) => n + 1);
    setSlots((prev) => {
      const occupied = prev.indexOf(playerId);
      if (occupied !== -1) {
        // Free THAT slot. The other three keep their teams.
        const next = [...prev];
        next[occupied] = null;
        return next;
      }
      const free = prev.indexOf(null);
      if (free === -1) return prev; // full — rows are non-interactive here
      const next = [...prev];
      next[free] = playerId;
      return next;
    });
  }

  function clearSelection() {
    setSelectionEpoch((n) => n + 1);
    setSlots(EMPTY_SLOTS);
  }

  /**
   * Move the player in `slotIndex` across the net. This is the REMEDY that
   * makes a teammate warning actionable — most of them are resolved by
   * moving one player rather than by re-picking the whole match.
   *
   * Prefers a free slot on the far side; otherwise swaps with the mirror
   * slot (0<->2, 1<->3) so no one is silently dropped.
   */
  function moveAcrossNet(slotIndex: number) {
    setSelectionEpoch((n) => n + 1);
    setSlots((prev) => {
      const player = prev[slotIndex];
      if (!player) return prev;
      const farSide = slotIndex < 2 ? [2, 3] : [0, 1];
      const next = [...prev];
      const free = farSide.find((i) => next[i] === null);
      if (free !== undefined) {
        next[free] = player;
        next[slotIndex] = null;
        return next;
      }
      const mirror = slotIndex < 2 ? slotIndex + 2 : slotIndex - 2;
      next[slotIndex] = next[mirror];
      next[mirror] = player;
      return next;
    });
  }

  // Track which player is currently being updated to show loading state.
  const [updatingSkill, setUpdatingSkill] = useState<string | null>(null);

  // PIN management state.
  const [visiblePins, setVisiblePins] = useState<Map<string, string>>(new Map());
  const [loadingPin, setLoadingPin] = useState<string | null>(null);
  // Edit PIN inline state: tracks which player is being edited + their draft + any error.
  const [editingPinFor, setEditingPinFor] = useState<string | null>(null);
  const [editPinDraft, setEditPinDraft] = useState("");
  const [editPinError, setEditPinError] = useState<string | null>(null);

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

  function handleEditPin(playerId: string) {
    setEditingPinFor(playerId);
    setEditPinDraft(visiblePins.get(playerId) ?? "");
    setEditPinError(null);
  }

  function handleEditPinCancel() {
    setEditingPinFor(null);
    setEditPinDraft("");
    setEditPinError(null);
  }

  async function handleEditPinSubmit(playerId: string) {
    // Client-side validation: must be exactly 4 digits, not "0000".
    if (!/^\d{4}$/.test(editPinDraft)) {
      setEditPinError("PIN must be exactly 4 digits.");
      return;
    }
    if (editPinDraft === "0000") {
      setEditPinError("PIN cannot be 0000.");
      return;
    }
    setLoadingPin(playerId);
    const result = await updatePlayerPin(sessionId, playerId, editPinDraft);
    setLoadingPin(null);
    if (result.success && result.pin) {
      setVisiblePins((prev) => new Map(prev).set(playerId, result.pin!));
      setEditingPinFor(null);
      setEditPinDraft("");
      setEditPinError(null);
    } else {
      setEditPinError(result.message ?? "Failed to update PIN.");
    }
  }

  async function handleCreateMatch() {
    if (filled !== REQUIRED_PLAYERS) return;

    setCreating(true);
    setError(null);

    // Teams come from the SLOTS, never from Set iteration order — the
    // preview the organizer just read is the contract.
    const { teamA, teamB } = deriveTeams(slots);

    const result = await onCreateManualMatch(teamA, teamB);
    if (result.error) {
      setError(result.error);
    } else {
      setSlots(EMPTY_SLOTS);
      setSelectionEpoch((n) => n + 1);
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

  // ── Repeat-pairing warning ──────────────────────────────────
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of queue) map.set(entry.player_id, entry.display_name);
    return map;
  }, [queue]);
  const nameOf = useMemo(
    () => (playerId: string) => nameById.get(playerId) ?? "Unknown",
    [nameById]
  );

  /**
   * The pool a marker can legitimately apply to: waiting, not paused, not
   * already selected. Excluding on_deck/drafted matters twice over — those
   * rows aren't tappable, and including them would let `hasCleanAlternative`
   * find a "clean" option the organizer can't actually take.
   */
  const candidateIds = useMemo(
    () =>
      queue
        .filter((q) => q.status === "waiting" && !q.is_paused && !selected.has(q.player_id))
        .map((q) => q.player_id),
    [queue, selected]
  );

  const liveCounts = usePairCounts(sessionId, matchesRevision);
  const { warnings, markers, headline, announcement, markerContext } = useRepeatPairing({
    slots,
    candidateIds,
    liveCounts,
    selectionEpoch,
    suppressed: capSaturationActive,
    nameOf,
  });

  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Fold the disclosure when the build ends, so the next build starts from
  // the compact bar rather than inheriting an expanded panel. Adjusted during
  // render (converges in one pass) rather than in an effect, which would
  // paint one frame of a stale open panel.
  if (detailsOpen && filled === 0) setDetailsOpen(false);
  const showDetails = detailsOpen && warnings.length > 0;

  return (
    <div className="space-y-5">
      {/* ── Live region ─────────────────────────────────────────
          PERMANENTLY MOUNTED and separate from the visible headline. A
          live region that enters the DOM already carrying its text is
          usually not announced, and giving the visible headline live
          semantics would re-announce it on every unrelated re-render.
          The text is written on a trailing debounce, gated on
          user-initiated selection changes — see useRepeatPairing. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <ManualMatchBar
        slots={slots}
        requiredPlayers={REQUIRED_PLAYERS}
        nameOf={nameOf}
        creating={creating}
        onCreate={handleCreateMatch}
        onClear={clearSelection}
        onMoveAcrossNet={moveAcrossNet}
        headline={headline}
        warningCount={warnings.length}
        detailsOpen={showDetails}
        onToggleDetails={() => setDetailsOpen((o) => !o)}
        detailsId={detailsId}
      />

      {/* Creation errors live BELOW the sticky bar: the bar is height-capped
          so it can never eat the queue, and clipping an error is worse than
          scrolling to one. Visually this is the same spot as before — the
          bar sits at the top of the tab. */}
      {error && (
        <p role="alert" className="text-sm text-cc-red">
          {error}
        </p>
      )}

      {/* Non-sticky half of the warning — full pair rows + the actual prior
          matches behind each count. Scrolls normally. */}
      {showDetails && (
        <RepeatPairDetails
          id={detailsId}
          sessionId={sessionId}
          warnings={warnings}
          nameOf={nameOf}
        />
      )}

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
        <>
          {/* View toggle — flat List vs grouped By Skill. Shared selection +
              handlers, so switching lenses never loses an in-progress pick. */}
          <div className="flex items-center gap-3">
            <div
              className="clip-cut-sm inline-flex gap-1 border border-cc-border bg-cc-bg-2 p-1"
              role="group"
              aria-label="Queue view"
            >
              {(["list", "skill"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={`clip-cut-badge min-h-[44px] px-4 py-2 font-command text-[10px] uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cc-accent ${
                    view === v
                      ? "border border-cc-accent/45 bg-cc-accent-dim text-cc-accent"
                      : "border border-transparent text-cc-t3 hover:text-cc-t1"
                  }`}
                >
                  {v === "list" ? "List" : "By Skill"}
                </button>
              ))}
            </div>
          </div>

          {/* Resolves what the row markers refer to. The relevant partner is
              whichever slot the next tap fills, so without this line the
              glyphs are unanchored ("a repeat with whom?"). */}
          {markerContext && (
            <RepeatMarkerLegend
              team={markerContext.team}
              partnerId={markerContext.partnerId}
              opponentIds={markerContext.opponentIds}
              nameOf={nameOf}
            />
          )}

          {view === "skill" ? (
            <QueueSkillGroups
              queue={queue}
              profiles={profiles}
              selected={selected}
              onToggleSelect={togglePlayer}
              isFull={isFull}
              markers={markers}
              nameOf={nameOf}
              onSkillChange={handleSkillChange}
              updatingSkill={updatingSkill}
              onPausePlayer={handlePausePlayer}
              pausingPlayers={pausingPlayers}
              onRemoveFromQueue={handleRemoveFromQueue}
              removingPlayer={removingPlayer}
            />
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
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                        Player
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                        Skill
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                        Wait
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                        Games
                      </th>
                      <th className="px-4 py-3 text-center font-medium text-muted-foreground hidden lg:table-cell">
                        PIN
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground w-16"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedQueue.map((entry, index) => {
                      const isSelected = selected.has(entry.player_id);
                      const waitMin = Math.floor(entry.wait_minutes);
                      const isPaused = entry.is_paused;
                      // on_deck / drafted rows are visible but not selectable for manual matches.
                      const isLocked = entry.status === "on_deck" || entry.status === "drafted";
                      // At 4 selected an unselected row used to stay clickable while
                      // togglePlayer no-op'd — a dead tap landing exactly when the
                      // warning says "reconsider". The checkbox was already disabled
                      // in that state; the row now matches it.
                      const isSelectable = !isPaused && !isLocked && (isSelected || !isFull);
                      const marker = markers.get(entry.player_id);

                      return (
                        <tr
                          key={entry.id}
                          tabIndex={isSelectable ? 0 : -1}
                          role="row"
                          aria-selected={isSelected}
                          aria-disabled={isSelectable ? undefined : "true"}
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
                                        : isFull
                                          ? "cursor-default"
                                          : "hover:bg-muted/30 cursor-pointer"
                                }
                                ${!isPaused && !isLocked && entry.is_bottleneck ? "!bg-red-50 dark:!bg-red-950/25" : ""}`}
                          onClick={() => isSelectable && togglePlayer(entry.player_id)}
                          onKeyDown={(e) => {
                            if (isSelectable && (e.key === " " || e.key === "Enter")) {
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
                              {/* Inline, immediately after the name: this table is
                                  min-w-[640px] inside overflow-x-auto, so a
                                  right-aligned marker is off-screen on a phone. */}
                              {marker && <RepeatMarker marker={marker} nameOf={nameOf} />}
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
                                entry.is_bottleneck
                                  ? "text-red-600 dark:text-red-400 font-bold"
                                  : ""
                              }
                            >
                              {waitMin}m
                            </span>
                          </td>
                          {/* Games */}
                          <td className="px-4 py-3 text-right tabular-nums">
                            {entry.games_played}
                          </td>
                          {/* PIN — hidden on narrow viewports, visible lg+ */}
                          <td
                            className="px-4 py-3 text-center hidden lg:table-cell"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-center gap-1">
                              {loadingPin === entry.player_id ? (
                                <span className="text-xs text-muted-foreground animate-pulse">
                                  ...
                                </span>
                              ) : editingPinFor === entry.player_id ? (
                                /* ── Inline PIN edit input ─────────────────── */
                                <div className="flex flex-col items-center gap-1">
                                  <div className="flex items-center gap-1">
                                    <input
                                      aria-label="New PIN"
                                      type="text"
                                      inputMode="numeric"
                                      maxLength={4}
                                      value={editPinDraft}
                                      onChange={(e) => {
                                        setEditPinDraft(e.target.value);
                                        setEditPinError(null);
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter")
                                          void handleEditPinSubmit(entry.player_id);
                                        if (e.key === "Escape") handleEditPinCancel();
                                      }}
                                      autoFocus
                                      className="w-14 text-center font-mono text-xs border border-border
                                             rounded px-1 py-0.5 bg-background focus:outline-none
                                             focus:ring-1 focus:ring-ring"
                                    />
                                    <button
                                      onClick={() => void handleEditPinSubmit(entry.player_id)}
                                      aria-label="Save PIN"
                                      className="min-w-[32px] min-h-[32px] flex items-center justify-center
                                             text-emerald-600 hover:text-emerald-700 transition-colors rounded"
                                    >
                                      ✓
                                    </button>
                                    <button
                                      onClick={handleEditPinCancel}
                                      aria-label="Cancel PIN edit"
                                      className="min-w-[32px] min-h-[32px] flex items-center justify-center
                                             text-muted-foreground hover:text-foreground transition-colors rounded"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                  {editPinError && (
                                    <p className="text-[10px] text-destructive">{editPinError}</p>
                                  )}
                                </div>
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
                                  {/* Edit PIN — opens inline input */}
                                  <button
                                    onClick={() => handleEditPin(entry.player_id)}
                                    className="min-w-[44px] min-h-[44px] flex items-center justify-center
                                         text-muted-foreground hover:text-blue-600 transition-colors
                                         rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    title="Edit PIN"
                                    aria-label="Edit PIN"
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
                                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
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
                                        This will remove them from the queue. If they are currently
                                        in a match, the match will not be affected. They can rejoin
                                        later using their name and PIN.
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
                                        {removingPlayer === entry.player_id
                                          ? "Removing…"
                                          : "Checkout"}
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
        </>
      )}
    </div>
  );
}
