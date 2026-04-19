"use client";

// ============================================================
// OnDeckPanel — drag-to-reprioritize on-deck match queue
// ============================================================
// Wrapped in React.memo so that opening/closing the SwapSheet
// (swapContext state in OrganizerDashboard) never causes the
// entire dnd board to re-render. The memo only re-renders when
// the matches array actually changes.
// ============================================================

import { memo, useState, useEffect, useRef, useCallback } from "react";
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
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Clock, GripVertical, Trash2 } from "lucide-react";
import { BadmintonCourt } from "@/components/ui/badminton-court";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";
import type { SkillLevel } from "@/types/database";

// ── SwapContext ───────────────────────────────────────────────
// Exported so organizer-dashboard and swap-sheet can share the
// same type definition without a separate types file.

export type SwapContext = {
  matchId: string;
  sessionId: string;
  outPlayerId: string;
  outTeam: "a" | "b";
  outPlayerName: string;
  outPlayerSkill: SkillLevel;
  /**
   * All current players in this match (including outgoing player).
   * Used by SwapSheet for skill-mismatch detection on replacement selection.
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
  onClearOnDeckMatch: (matchId: string) => Promise<{ error?: string }>;
  onReorderMatches: (orderedMatchIds: string[]) => Promise<{ error?: string }>;
  /** Called when a player badge is tapped — opens the SwapSheet. */
  onOpenSwap: (ctx: SwapContext) => void;
}

// ── Helpers ──────────────────────────────────────────────────

function getTeams(match: EnrichedMatch) {
  return {
    teamA: match.players
      .filter((p) => p.team === "a")
      .map((p) => ({
        player_id: p.player_id,
        display_name: p.profile.display_name,
        skill_level: p.profile.skill_level,
      })),
    teamB: match.players
      .filter((p) => p.team === "b")
      .map((p) => ({
        player_id: p.player_id,
        display_name: p.profile.display_name,
        skill_level: p.profile.skill_level,
      })),
  };
}

function minutesSince(dateStr: string) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 60_000);
}

// ── SortableCard ─────────────────────────────────────────────
// ALL dnd-kit wiring lives here — no prop drilling, no child
// component boundaries for refs or listeners.

interface SortableCardProps {
  match: EnrichedMatch;
  index: number;
  isClearing: boolean;
  error?: string;
  onClear: (id: string) => void;
  onOpenSwap: (ctx: SwapContext) => void;
}

function SortableCard({
  match,
  index,
  isClearing,
  error,
  onClear,
  onOpenSwap,
}: SortableCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: match.id });

  const { teamA, teamB } = getTeams(match);
  const mins = minutesSince(match.created_at);

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
    zIndex: isDragging ? 50 : 1,
  };

  // Build SwapContext from a player badge tap.
  // All profile data is pre-fetched in EnrichedMatch — no extra calls needed.
  function handlePlayerClick(
    player: { player_id: string; display_name: string; skill_level: SkillLevel },
    team: "a" | "b"
  ) {
    onOpenSwap({
      matchId: match.id,
      sessionId: match.session_id,
      outPlayerId: player.player_id,
      outTeam: team,
      outPlayerName: player.display_name,
      outPlayerSkill: player.skill_level,
      currentPlayers: match.players.map((p) => ({
        player_id: p.player_id,
        skill_level: p.profile.skill_level,
        display_name: p.profile.display_name,
      })),
    });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative rounded-2xl border border-amber-100 dark:border-amber-900/40 bg-white dark:bg-card shadow-sm overflow-hidden"
    >
      {/* ── Card header row ────────────────────────────────── */}
      <div className="flex items-center gap-1
                      bg-amber-50/70 dark:bg-amber-900/20
                      px-2 py-2.5 border-b border-amber-100 dark:border-amber-900/40">

        {/* DRAG HANDLE — only the grip icon, no text children */}
        <div
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="touch-none select-none cursor-grab active:cursor-grabbing
                     flex items-center justify-center p-1 rounded
                     hover:bg-amber-100/60 dark:hover:bg-amber-800/30 transition-colors"
        >
          <GripVertical className="h-5 w-5 text-amber-400 dark:text-amber-500 shrink-0" />
        </div>

        {/* NON-DRAGGABLE label + badge */}
        <div className="pointer-events-none select-none flex flex-1 items-center justify-between min-w-0 pl-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-bold text-amber-900 dark:text-amber-300">
              On Deck #{index + 1}
            </span>
            {match.is_mixed_level && (
              <span
                className="rounded-full border px-2 py-0.5
                            text-[10px] font-bold uppercase tracking-wider
                            bg-amber-100 border-amber-300 text-amber-800
                            dark:bg-[hsl(var(--amber-accent-hsl))]/20
                            dark:border-[hsl(var(--amber-accent-hsl))]/50
                            dark:text-[hsl(var(--amber-accent-hsl))]"
              >
                Mixed Level
              </span>
            )}
          </div>
          <span className="text-xs text-amber-600 dark:text-amber-400 font-medium shrink-0">
            {mins === 0 ? "Just formed" : `${mins}m ago`}
          </span>
        </div>

      </div>

      {/* ── Court graphic with tappable player pills ────────── */}
      <div className="p-2">
        <BadmintonCourt
          teamA={teamA}
          teamB={teamB}
          isOnDeck
          onPlayerClick={handlePlayerClick}
        />
      </div>

      {/* ── Footer — Clear button ──────────────────────────── */}
      <div className="px-4 py-2.5 bg-slate-50 dark:bg-muted/50 border-t border-slate-100 dark:border-border flex items-center justify-between gap-3">
        <p className="text-xs text-slate-400 dark:text-muted-foreground">
          Tap a player name to swap them out
        </p>
        <button
          onClick={() => onClear(match.id)}
          disabled={isClearing}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-200
                     bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700
                     hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40
                     dark:text-red-400 dark:hover:bg-red-950/60
                     disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Trash2 className="h-3 w-3" />
          {isClearing ? "Clearing…" : "Clear"}
        </button>
      </div>

      {/* ── Inline error ───────────────────────────────────── */}
      {error && (
        <p className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

// ── OverlayCard — pure visual, NO dnd hooks ──────────────────
// Rendered inside <DragOverlay>. Never calls useSortable.

function OverlayCard({ match, index }: { match: EnrichedMatch; index: number }) {
  const { teamA, teamB } = getTeams(match);
  const mins = minutesSince(match.created_at);

  return (
    <div className="rounded-2xl border border-amber-100 dark:border-amber-900/40 bg-white dark:bg-card shadow-2xl overflow-hidden rotate-1">
      <div className="flex items-center gap-1 bg-amber-50/70 dark:bg-amber-900/20 px-2 py-2.5 border-b border-amber-100 dark:border-amber-900/40">
        <div className="touch-none select-none cursor-grabbing flex items-center justify-center p-1 rounded">
          <GripVertical className="h-5 w-5 text-amber-400 dark:text-amber-500 shrink-0" />
        </div>
        <div className="pointer-events-none select-none flex flex-1 items-center justify-between min-w-0 pl-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-bold text-amber-900 dark:text-amber-300">
              On Deck #{index + 1}
            </span>
            {match.is_mixed_level && (
              <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-amber-100 border-amber-300 text-amber-800 dark:bg-[hsl(var(--amber-accent-hsl))]/20 dark:border-[hsl(var(--amber-accent-hsl))]/50 dark:text-[hsl(var(--amber-accent-hsl))]">
                Mixed Level
              </span>
            )}
          </div>
          <span className="text-xs text-amber-600 dark:text-amber-400 font-medium shrink-0">
            {mins === 0 ? "Just formed" : `${mins}m ago`}
          </span>
        </div>
      </div>
      <div className="p-2">
        {/* No onPlayerClick on overlay — purely visual during drag */}
        <BadmintonCourt teamA={teamA} teamB={teamB} isOnDeck />
      </div>
      <div className="px-4 py-2.5 bg-slate-50 dark:bg-muted/50 border-t border-slate-100 dark:border-border flex items-center justify-between gap-3">
        <p className="text-xs text-slate-400 dark:text-muted-foreground">
          Tap a player name to swap them out
        </p>
        <button disabled className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400 opacity-50 cursor-not-allowed">
          <Trash2 className="h-3 w-3" />
          Clear
        </button>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────
// Wrapped in React.memo: swapContext state lives in
// OrganizerDashboard. Since onOpenSwap is stabilised with
// useCallback there, this component never re-renders just
// because the swap sheet opens or closes.

function OnDeckPanelInner({
  matches,
  onClearOnDeckMatch,
  onReorderMatches,
  onOpenSwap,
}: OnDeckPanelProps) {
  const [clearingIds, setClearingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Suppress real-time prop updates during an active drag to avoid
  // disrupting dnd-kit's internal rect measurements.
  const isDraggingRef = useRef(false);
  const [orderedMatches, setOrderedMatches] = useState<EnrichedMatch[]>(matches);

  useEffect(() => {
    if (isDraggingRef.current) return;

    const incomingIds = new Set(matches.map((m) => m.id));
    const currentIds = new Set(orderedMatches.map((m) => m.id));
    const setsEqual =
      incomingIds.size === currentIds.size &&
      [...incomingIds].every((id) => currentIds.has(id));

    if (!setsEqual) {
      setOrderedMatches(matches);
    } else {
      setOrderedMatches((prev) =>
        prev.map((old) => matches.find((m) => m.id === old.id) ?? old)
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  // ── Drag state ──────────────────────────────────────────────
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeMatch = activeId
    ? orderedMatches.find((m) => m.id === activeId) ?? null
    : null;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 3 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
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
    setErrors((prev) => { const e = { ...prev }; delete e[matchId]; return e; });

    const result = await onClearOnDeckMatch(matchId);

    setClearingIds((prev) => { const s = new Set(prev); s.delete(matchId); return s; });

    if (result.error) {
      setErrors((prev) => ({ ...prev, [matchId]: result.error! }));
    }
  }

  // ── Empty state ──────────────────────────────────────────────

  if (orderedMatches.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 dark:border-border bg-slate-50/60 dark:bg-card/50 px-6 py-8 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-muted">
          <Clock className="h-5 w-5 text-slate-400 dark:text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-slate-600 dark:text-foreground">
          No matches on deck
        </p>
        <p className="mt-1 text-xs text-slate-400 dark:text-muted-foreground">
          The engine fills this automatically, or create one manually in Queue &amp; Match Control.
        </p>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Section header */}
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
        </span>
        <h2 className="text-sm font-bold text-slate-700 dark:text-foreground uppercase tracking-wider">
          On Deck
        </h2>
        <span className="rounded-full px-2 py-0.5 text-xs font-bold bg-amber-100 text-amber-800 dark:bg-[hsl(var(--amber-accent-hsl))]/20 dark:text-[hsl(var(--amber-accent-hsl))] dark:ring-1 dark:ring-[hsl(var(--amber-accent-hsl))]/50">
          {orderedMatches.length} match{orderedMatches.length !== 1 ? "es" : ""} ready
        </span>
        {orderedMatches.length > 1 && (
          <span className="text-xs text-slate-400 dark:text-muted-foreground hidden sm:block">
            — drag to reprioritize
          </span>
        )}
      </div>

      {/* Sortable grid */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={orderedMatches.map((m) => m.id)}
          strategy={rectSortingStrategy}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {orderedMatches.map((match, idx) => (
              <SortableCard
                key={match.id}
                match={match}
                index={idx}
                isClearing={clearingIds.has(match.id)}
                error={errors[match.id]}
                onClear={handleClear}
                onOpenSwap={onOpenSwap}
              />
            ))}
          </div>
        </SortableContext>

        <DragOverlay dropAnimation={{ duration: 200, easing: "ease" }}>
          {activeMatch ? (
            <OverlayCard
              match={activeMatch}
              index={orderedMatches.findIndex((m) => m.id === activeMatch.id)}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// Export the memoised version. OrganizerDashboard stabilises
// onOpenSwap with useCallback so this memo is effective —
// the board never re-renders when the swap sheet opens/closes.
export const OnDeckPanel = memo(OnDeckPanelInner);
