"use client";

// ============================================================
// OnDeckPanel — drag-to-reprioritize on-deck match queue
// ============================================================
// Wrapped in React.memo so that opening/closing the SwapSheet
// (swapContext state in OrganizerDashboard) never causes the
// entire dnd board to re-render. The memo only re-renders when
// the matches array or swapContext actually changes.
//
// Tap-to-Swap v2 — two-tap direct interaction model:
//   First tap  → enter "picking" mode (amber ring on selected pill)
//   Second tap → execute direct match↔match swap (no sheet needed)
//   "Pick from Bench" in floating bar → promotes to "sheet" mode
//   Tap same player again / Esc → cancel picking mode
//
// SwapContext mode:
//   "picking"  — first tap registered, waiting for second target
//   "sheet"    — legacy bench-swap sheet opened (tap "Pick from Bench")
//
// Draft Mode:
//   Engine-generated matches start as is_published=false (drafts).
//   Drafts are visible ONLY to the organizer in this panel.
//   Players and the TV see nothing until the organizer publishes.
//   Two sections render independently:
//     - Drafts section  — dashed slate border cards + Publish button
//     - On Deck section — solid teal border cards (published)
//   Both sections share the same DnD context and sort_order so the
//   organizer can freely reorder across draft/published boundaries.
// ============================================================

import { memo, useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { Clock, EyeOff, PauseCircle } from "lucide-react";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";
import type { CapSaturationPayload } from "@/lib/broadcast";
import type { SkillLevel } from "@/types/database";
import { SortableCard, OverlayCard, CapSaturationNotice } from "./sortable-card";
import {
  DND_ACTIVATION_DISTANCE_PX,
  DND_TOUCH_DELAY_MS,
  DND_TOUCH_TOLERANCE_PX,
  PLAYERS_PER_MATCH,
} from "@/lib/constants";
import { getDynamicDraftCap } from "@/lib/matchmaking-core";

// ── DraftCapNotice ────────────────────────────────────────────
// Shown when auto-matchmaking is ON, there are enough waiting players,
// and all draft slots are filled with unreviewed matches. Explains to
// the organizer WHY the engine has stopped generating new drafts.
// Returns null when the cap hasn't been reached — callers need no guard.

function DraftCapNotice({
  draftCount,
  cap,
  onPublishAll,
  isPublishing,
}: {
  draftCount: number;
  cap: number;
  /** Called when the inline Publish All button is clicked. */
  onPublishAll?: () => void;
  isPublishing?: boolean;
}) {
  if (draftCount < cap) return null;
  return (
    <div
      role="alert"
      aria-label="Draft cap reached — auto-generation paused"
      className="clip-cut-sm border border-cc-amber/35 bg-cc-amber-dim animate-in slide-in-from-top-1 fade-in duration-200"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <PauseCircle className="h-4 w-4 shrink-0 text-cc-amber" />
        <div className="min-w-0 flex-1">
          <p className="font-command text-[9.5px] uppercase tracking-[0.13em] text-cc-amber">
            Auto-generation paused
          </p>
          <p className="text-[11.5px] mt-0.5 leading-relaxed text-cc-t2">
            {draftCount}/{cap} draft slots filled — publish the drafts below to resume.
          </p>
        </div>
        {onPublishAll && (
          <button
            onClick={onPublishAll}
            disabled={isPublishing}
            aria-label="Publish all draft matches"
            className="shrink-0 flex items-center gap-1.5 clip-cut-sm
                       bg-cc-amber hover:bg-cc-amber/90
                       border border-cc-amber/50
                       transition-colors px-3 min-h-[44px] font-command text-[9px] uppercase tracking-[0.12em] text-cc-btn-on-accent
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPublishing ? "Publishing…" : "Publish All"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── SwapContext ───────────────────────────────────────────────
// Exported so OrganizerDashboard and SwapSheet can share the
// same type without a separate types file.
//
// mode: "picking" — organizer tapped a player, floating bar shows,
//                   waiting for a second tap to complete the swap.
// mode: "sheet"   — legacy path: picking a replacement from the bench.
//                   The SwapSheet drawer is open.

export type SwapContext = {
  /** Determines which UI is shown. */
  mode: "picking" | "sheet";
  matchId: string;
  sessionId: string;
  outPlayerId: string;
  outTeam: "a" | "b";
  outPlayerName: string;
  outPlayerSkill: SkillLevel;
  /**
   * All current players in this match (including outgoing player).
   * Used by SwapSheet for skill-mismatch detection.
   */
  currentPlayers: Array<{
    player_id: string;
    skill_level: SkillLevel;
    display_name: string;
  }>;
};

// ── Types ────────────────────────────────────────────────────

interface OnDeckPanelProps {
  matches: EnrichedMatch[];
  /** Current swap state from OrganizerDashboard. Drives visual selection. */
  swapContext: SwapContext | null;
  onClearOnDeckMatch: (matchId: string) => Promise<{ error?: string }>;
  onReorderMatches: (orderedMatchIds: string[]) => Promise<{ error?: string }>;
  /** Called when a player badge is tapped — drives both picking and sheet modes. */
  onPlayerTap: (ctx: Omit<SwapContext, "mode">) => void;
  /** Draft Mode: publish a single draft match. */
  onPublishMatch: (matchId: string) => Promise<{ error?: string }>;
  /** Draft Mode: publish all draft matches for this session. */
  onPublishAllDrafts: () => Promise<{ error?: string; publishedCount?: number }>;
  /**
   * Non-null when the partner-pair cap blocked the last match attempt.
   * Renders a dismissable notice above the draft banner.
   */
  capSaturation?: CapSaturationPayload | null;
  /** Dismiss handler — clears the capSaturation notice from the hook state. */
  onDismissCapSaturation?: () => void;
  /**
   * Whether auto-matchmaking is currently ON. Used to show the draft-cap-blocked
   * notice only when the organizer expects automatic generation.
   */
  isAutoMatchmakingOn?: boolean;
  /**
   * Whether auto-publish mode is ON. In auto mode the engine never produces
   * unpublished drafts, so the draft section, divider, and "Publish All" banner
   * are hidden — the published On-Deck section is the whole view (D2/D5).
   */
  autoPublishIsOn?: boolean;
  /**
   * Number of players currently in waiting status. Used to compute the dynamic
   * draft cap threshold so the notice appears at the right fill level.
   */
  waitingCount?: number;
  /**
   * True for ~3 s after unpublished drafts first appear from zero. Drives a
   * transient "NEW" badge on the Publish All banner so the organizer knows a
   * fresh draft was just generated.
   */
  hasNewDraft?: boolean;
}

// ── Main panel ────────────────────────────────────────────────

function OnDeckPanelInner({
  matches,
  swapContext,
  onClearOnDeckMatch,
  onReorderMatches,
  onPlayerTap,
  onPublishMatch,
  onPublishAllDrafts,
  capSaturation = null,
  onDismissCapSaturation,
  isAutoMatchmakingOn,
  autoPublishIsOn = false,
  waitingCount,
  hasNewDraft,
}: OnDeckPanelProps) {
  const [clearingIds, setClearingIds] = useState<Set<string>>(new Set());
  const [publishingIds, setPublishingIds] = useState<Set<string>>(new Set());
  // Optimistic set: matchIds that have been published client-side
  // before the server round-trip completes. Used for transition animation.
  const [optimisticPublishedIds, setOptimisticPublishedIds] = useState<Set<string>>(new Set());
  const [isPublishingAll, setIsPublishingAll] = useState(false);
  const [publishAllError, setPublishAllError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Suppress real-time prop updates during an active drag.
  const isDraggingRef = useRef(false);
  const [orderedMatches, setOrderedMatches] = useState<EnrichedMatch[]>(matches);

  useEffect(() => {
    if (isDraggingRef.current) return;

    const incomingIds = new Set(matches.map((m) => m.id));
    const currentIds = new Set(orderedMatches.map((m) => m.id));
    const setsEqual =
      incomingIds.size === currentIds.size && [...incomingIds].every((id) => currentIds.has(id));

    if (!setsEqual) {
      setOrderedMatches(matches);
      // Clear optimistic state for any matches that were removed
      setOptimisticPublishedIds((prev) => {
        const next = new Set(prev);
        [...prev].forEach((id) => {
          if (!incomingIds.has(id)) next.delete(id);
        });
        return next;
      });
      // Clear any stale Publish All error — the draft set has changed so
      // the previous failure no longer applies to the new batch.
      setPublishAllError(null);
    } else {
      setOrderedMatches((prev) => prev.map((old) => matches.find((m) => m.id === old.id) ?? old));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  // ── Drag state ──────────────────────────────────────────────
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeMatch = activeId ? (orderedMatches.find((m) => m.id === activeId) ?? null) : null;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: DND_ACTIVATION_DISTANCE_PX } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: DND_TOUCH_DELAY_MS, tolerance: DND_TOUCH_TOLERANCE_PX },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragStart({ active }: DragStartEvent) {
    isDraggingRef.current = true;
    setActiveId(active.id as string);
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    isDraggingRef.current = false;
    setActiveId(null);

    if (!over || active.id === over.id) return;

    const oldIndex = orderedMatches.findIndex((m) => m.id === active.id);
    const newIndex = orderedMatches.findIndex((m) => m.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(orderedMatches, oldIndex, newIndex);
    setOrderedMatches(reordered);
    onReorderMatches(reordered.map((m) => m.id));
  }

  function handleDragCancel() {
    isDraggingRef.current = false;
    setActiveId(null);
  }

  // ── Clear handler ─────────────────────────────────────────

  async function handleClear(matchId: string) {
    setClearingIds((prev) => new Set(prev).add(matchId));
    setErrors((prev) => {
      const e = { ...prev };
      delete e[matchId];
      return e;
    });

    const result = await onClearOnDeckMatch(matchId);

    setClearingIds((prev) => {
      const s = new Set(prev);
      s.delete(matchId);
      return s;
    });

    if (result.error) {
      setErrors((prev) => ({ ...prev, [matchId]: result.error! }));
    }
  }

  // ── Publish handler ────────────────────────────────────────

  async function handlePublish(matchId: string) {
    setPublishingIds((prev) => new Set(prev).add(matchId));
    // Optimistic: immediately animate the card to published state
    setOptimisticPublishedIds((prev) => new Set(prev).add(matchId));
    setErrors((prev) => {
      const e = { ...prev };
      delete e[matchId];
      return e;
    });

    const result = await onPublishMatch(matchId);

    setPublishingIds((prev) => {
      const s = new Set(prev);
      s.delete(matchId);
      return s;
    });

    if (result.error) {
      // Revert optimistic state on failure
      setOptimisticPublishedIds((prev) => {
        const s = new Set(prev);
        s.delete(matchId);
        return s;
      });
      setErrors((prev) => ({ ...prev, [matchId]: result.error! }));
    }
    // On success the realtime subscription will update the match's
    // is_published flag and the optimistic entry will be cleared
    // naturally by the useEffect above.
  }

  // ── Derived section lists ──────────────────────────────────
  // Both sections reference orderedMatches so drag across the
  // draft/published boundary preserves the global sort order.
  // Memoised: filters run only when orderedMatches or optimisticPublishedIds
  // change — not on every loading-state update (clearingIds, publishingIds, etc.).
  // Declared before handlePublishAll so the callback can close over draftMatches
  // without a temporal dead zone error.
  const draftMatches = useMemo(
    () => orderedMatches.filter((m) => !m.is_published && !optimisticPublishedIds.has(m.id)),
    [orderedMatches, optimisticPublishedIds]
  );
  const publishedMatches = useMemo(
    () => orderedMatches.filter((m) => m.is_published || optimisticPublishedIds.has(m.id)),
    [orderedMatches, optimisticPublishedIds]
  );
  const draftCount = draftMatches.length;

  // Draft cap notice: visible when all draft slots are full, auto-matchmaking
  // is ON, and there are enough players waiting — explains to the organizer
  // why the engine has stopped generating new matches.
  // Suppressed in auto-publish mode: there is no review step, and unpublished
  // held drafts (is_published=false) would otherwise inflate draftCount and fire
  // a "publish the drafts below" notice for cards that aren't shown.
  const waiting = waitingCount ?? 0;
  const dynamicCap = getDynamicDraftCap(waiting);
  const isDraftCapBlocked =
    isAutoMatchmakingOn === true &&
    !autoPublishIsOn &&
    waiting >= PLAYERS_PER_MATCH &&
    draftCount >= dynamicCap;

  // Stable identity for SortableContext — recreated only when the match
  // set changes, not on every loading-state update inside the component.
  const sortableIds = useMemo(() => orderedMatches.map((m) => m.id), [orderedMatches]);

  // ── Publish All handler ────────────────────────────────────

  const handlePublishAll = useCallback(async () => {
    setIsPublishingAll(true);
    setPublishAllError(null);
    // draftMatches is already memoised to (!is_published && !optimisticPublished),
    // so we read it directly — no duplicate filter needed.
    // This prevents a failing Publish All from reverting a separate in-flight
    // individual publish that happened to overlap.
    const draftIds = draftMatches.map((m) => m.id);
    setOptimisticPublishedIds((prev) => {
      const next = new Set(prev);
      draftIds.forEach((id) => next.add(id));
      return next;
    });

    const result = await onPublishAllDrafts();
    setIsPublishingAll(false);

    if (result.error) {
      // Revert all optimistic entries for drafts that failed to publish
      setOptimisticPublishedIds((prev) => {
        const next = new Set(prev);
        draftIds.forEach((id) => next.delete(id));
        return next;
      });
      // Surface error on the banner — no per-card context available.
      setPublishAllError(result.error);
    }
    // On success, realtime will resolve final is_published=true state;
    // optimistic IDs will be cleaned up naturally by the useEffect above.
  }, [draftMatches, onPublishAllDrafts]);

  // ── Empty state ──────────────────────────────────────────────
  // NOTE: still wraps in space-y-4 so the cap saturation notice can
  // appear alongside the empty state — the most common scenario for
  // cap_saturation firing is when no on-deck matches exist at all.

  if (orderedMatches.length === 0) {
    return (
      <div className="space-y-4">
        <CapSaturationNotice capSaturation={capSaturation} onDismiss={onDismissCapSaturation} />
        <div className="rounded-xl border border-dashed border-border bg-slate-50/60 dark:bg-card/50 px-6 py-8 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Clock className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium text-foreground">No matches on deck</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The engine fills this automatically, or create one manually in Queue &amp; Match
            Control.
          </p>
        </div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* ── Cap saturation notice ── error (highest urgency) — shown first ── */}
      <CapSaturationNotice capSaturation={capSaturation} onDismiss={onDismissCapSaturation} />
      {/* ── Draft cap notice ── engine status (informational) — shown second ── */}
      {isDraftCapBlocked && (
        <DraftCapNotice
          draftCount={draftCount}
          cap={dynamicCap}
          onPublishAll={handlePublishAll}
          isPublishing={isPublishingAll}
        />
      )}

      {/* ── Publish All banner ── shown when there are drafts ── */}
      {/* Publish All banner suppressed when DraftCapNotice is shown — it already has an inline button. */}
      {/* Hidden entirely in auto-publish mode: there is no review step. */}
      {draftCount > 0 && !isDraftCapBlocked && !autoPublishIsOn && (
        <div
          role="status"
          aria-label={`${draftCount} on-deck match${draftCount !== 1 ? "es" : ""} waiting for approval`}
          className="rounded-xl border border-cc-accent/25
                     bg-cc-accent-dim
                     animate-in slide-in-from-top-1 fade-in duration-200"
        >
          <div className="flex items-center justify-between gap-3 px-4 py-2">
            <div className="flex items-center gap-2 text-sm text-cc-accent-text min-w-0">
              <EyeOff className="h-4 w-4 shrink-0 text-cc-t2" />
              <span className="font-medium">
                <span className="font-bold">{draftCount}</span> on-deck match
                {draftCount !== 1 ? "es" : ""} waiting for approval
              </span>
              {hasNewDraft && (
                <span
                  aria-label="New draft just generated"
                  className="inline-flex items-center gap-1 font-command text-[8.5px] uppercase tracking-[0.1em]
                             text-cc-accent border border-cc-accent/40 bg-cc-accent-dim px-1.5 py-0.5
                             animate-in fade-in slide-in-from-left-1 duration-200"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-cc-accent animate-ping inline-block" />
                  New
                </span>
              )}
            </div>
            <button
              onClick={handlePublishAll}
              disabled={isPublishingAll}
              className="shrink-0 flex items-center gap-1.5 clip-cut-sm
                         bg-cc-accent hover:bg-cc-accent/90
                         border border-cc-accent/50
                         transition-colors px-4 min-h-[44px] font-command text-[10px] uppercase tracking-[0.12em] text-cc-btn-on-accent
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPublishingAll ? "Publishing…" : "Publish All"}
            </button>
          </div>
          {publishAllError && (
            <p role="alert" className="px-4 pb-2 text-xs text-cc-red">
              {publishAllError}
            </p>
          )}
        </div>
      )}

      {/* ── Shared DnD context — drafts and published in one zone ── */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
          {/* ── Drafts section ─────────────────────────────── */}
          {/* Hidden in auto-publish mode (no unpublished drafts exist). */}
          {draftMatches.length > 0 && !autoPublishIsOn && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  Drafts
                </span>
                <span className="text-xs text-muted-foreground">— hidden from players</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {draftMatches.map((match, idx) => (
                  <SortableCard
                    key={match.id}
                    match={match}
                    sectionIndex={idx}
                    isDraft={true}
                    isClearing={clearingIds.has(match.id)}
                    isPublishing={publishingIds.has(match.id)}
                    isOptimisticPublished={optimisticPublishedIds.has(match.id)}
                    error={errors[match.id]}
                    swapContext={swapContext}
                    onClear={handleClear}
                    onPublish={handlePublish}
                    onPlayerTap={onPlayerTap}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── Section divider ─────────────────────────────── */}
          {draftMatches.length > 0 && publishedMatches.length > 0 && !autoPublishIsOn && (
            <div className="pointer-events-none flex items-center gap-3 py-1">
              <div className="flex-1 border-t border-dashed border-slate-200 dark:border-slate-700" />
              <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500 whitespace-nowrap">
                ↑ Hidden from players · ↓ Visible on deck
              </span>
              <div className="flex-1 border-t border-dashed border-slate-200 dark:border-slate-700" />
            </div>
          )}

          {/* ── Published / On Deck section ────────────────── */}
          {publishedMatches.length > 0 && (
            <div className="space-y-3">
              {/* Section header — always shown for published matches */}
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cc-accent opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cc-accent" />
                </span>
                <span className="text-xs font-bold uppercase tracking-wider text-cc-t1">
                  On Deck
                </span>
                <span className="rounded-full px-2 py-0.5 text-xs font-bold bg-cc-accent-dim text-cc-accent-text ring-1 ring-cc-accent/40">
                  {publishedMatches.length} match{publishedMatches.length !== 1 ? "es" : ""} ready
                </span>
                {publishedMatches.length > 1 && draftMatches.length === 0 && (
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    — drag to reprioritize
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {publishedMatches.map((match, idx) => (
                  <SortableCard
                    key={match.id}
                    match={match}
                    sectionIndex={idx}
                    isDraft={false}
                    isClearing={clearingIds.has(match.id)}
                    isPublishing={publishingIds.has(match.id)}
                    isOptimisticPublished={false}
                    error={errors[match.id]}
                    swapContext={swapContext}
                    onClear={handleClear}
                    onPublish={handlePublish}
                    onPlayerTap={onPlayerTap}
                  />
                ))}
              </div>
            </div>
          )}
        </SortableContext>

        <DragOverlay dropAnimation={{ duration: 200, easing: "ease" }}>
          {activeMatch
            ? (() => {
                const isDraft =
                  !activeMatch.is_published && !optimisticPublishedIds.has(activeMatch.id);
                const sectionMatches = isDraft ? draftMatches : publishedMatches;
                const sectionIndex = sectionMatches.findIndex((m) => m.id === activeMatch.id);
                return (
                  <OverlayCard
                    match={activeMatch}
                    sectionIndex={sectionIndex >= 0 ? sectionIndex : 0}
                    isDraft={isDraft}
                  />
                );
              })()
            : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// Export the memoised version. OrganizerDashboard stabilises
// onPlayerTap with useCallback (ref pattern) so this memo is
// effective — the board never re-renders when the swap sheet
// opens/closes or toasts appear.
export const OnDeckPanel = memo(OnDeckPanelInner);
