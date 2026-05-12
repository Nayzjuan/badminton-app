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
import { AlertTriangle, CheckCircle, Clock, EyeOff, GripVertical, Trash2, X } from "lucide-react";
import { TeamsGrid, type RosterPlayer } from "@/components/organizer/match-roster";
import { H2HStrip } from "@/components/organizer/h2h-strip";
import { MatchOriginTag } from "@/components/organizer/match-origin-tag";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";
import type { CapSaturationPayload } from "@/lib/broadcast";
import { MAX_PARTNERSHIP_REPEATS } from "@/lib/constants";
import type { SkillLevel } from "@/types/database";

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
}

// ── Helpers ──────────────────────────────────────────────────

function getTeams(match: EnrichedMatch): {
  teamA: RosterPlayer[];
  teamB: RosterPlayer[];
} {
  return {
    teamA: match.players
      .filter((p) => p.team === "a")
      .map((p) => ({
        player_id: p.player_id,
        display_name: p.profile.display_name,
        skill_level: p.profile.skill_level,
        vip_tag: p.profile.vip_tag,
        vip_theme: p.profile.vip_theme,
      })),
    teamB: match.players
      .filter((p) => p.team === "b")
      .map((p) => ({
        player_id: p.player_id,
        display_name: p.profile.display_name,
        skill_level: p.profile.skill_level,
        vip_tag: p.profile.vip_tag,
        vip_theme: p.profile.vip_theme,
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
  /** Position label within its own section (draft or published). */
  sectionIndex: number;
  isDraft: boolean;
  isClearing: boolean;
  isPublishing: boolean;
  /** Optimistic: true while the publish animation is in-flight. */
  isOptimisticPublished: boolean;
  error?: string;
  swapContext: SwapContext | null;
  onClear: (id: string) => void;
  onPublish: (id: string) => void;
  onPlayerTap: (ctx: Omit<SwapContext, "mode">) => void;
}

function SortableCard({
  match,
  sectionIndex,
  isDraft,
  isClearing,
  isPublishing,
  isOptimisticPublished,
  error,
  swapContext,
  onClear,
  onPublish,
  onPlayerTap,
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

  // ── Derive swap visual state for this card ─────────────────
  const isPickingMode = swapContext?.mode === "picking";
  const selectedPlayerId =
    isPickingMode && swapContext.matchId === match.id ? swapContext.outPlayerId : undefined;
  const isSwapModeActive = isPickingMode;

  // Optimistic transition: once the organizer clicks Publish the card
  // visually transitions from draft (dashed) to published (solid) even
  // before the server round-trip completes.
  const effectivelyDraft = isDraft && !isOptimisticPublished;

  // Build SwapContext from a player row tap.
  function handlePlayerTap(player: RosterPlayer, team: "a" | "b") {
    onPlayerTap({
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
      className={[
        "relative rounded-2xl border-2 shadow-sm overflow-hidden",
        // Animate the border/bg change for the publish transition
        "transition-colors duration-[250ms] ease-out",
        // Draft: dashed slate border — indicates "hidden from players"
        // Published: solid teal border — indicates "visible / on deck"
        effectivelyDraft
          ? "border-dashed border-slate-300 dark:border-slate-600 bg-card"
          : selectedPlayerId
            ? "border-[oklch(0.79_0.18_188/0.80)] dark:border-[oklch(0.79_0.18_188/0.60)] shadow-[0_4px_16px_oklch(0.79_0.18_188/0.18)] dark:shadow-[0_4px_16px_oklch(0.79_0.18_188/0.25)] shadow-md bg-card"
            : "border-[oklch(0.79_0.18_188/0.45)] dark:border-[oklch(0.79_0.18_188/0.30)] bg-card",
      ].join(" ")}
    >
      {/* ── Card header row ────────────────────────────────── */}
      <div
        className={[
          "flex items-center gap-1 px-2 py-2.5 border-b transition-colors duration-[250ms] ease-out",
          effectivelyDraft
            ? "bg-slate-50 dark:bg-muted/30 border-slate-200 dark:border-slate-700"
            : "bg-[oklch(0.79_0.18_188/0.06)] dark:bg-[oklch(0.79_0.18_188/0.08)] border-[oklch(0.79_0.18_188/0.20)] dark:border-[oklch(0.79_0.18_188/0.18)]",
        ].join(" ")}
      >
        {/* DRAG HANDLE */}
        <div
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          suppressHydrationWarning
          className="touch-none select-none cursor-grab active:cursor-grabbing
                     flex items-center justify-center p-1 rounded
                     hover:bg-[oklch(0.79_0.18_188/0.12)] transition-colors"
          aria-label="Drag to reorder"
        >
          <GripVertical
            className={[
              "h-5 w-5 shrink-0 transition-colors duration-[250ms]",
              effectivelyDraft
                ? "text-slate-400 dark:text-slate-500"
                : "text-[oklch(0.65_0.15_188)] dark:text-[oklch(0.79_0.18_188)]",
            ].join(" ")}
          />
        </div>

        {/* Label + badges + origin tag */}
        <div className="pointer-events-none select-none flex flex-1 items-center justify-between min-w-0 pl-1">
          <div className="flex items-center gap-2 min-w-0">
            {effectivelyDraft ? (
              <span className="text-sm font-bold text-slate-500 dark:text-slate-400">
                Draft #{sectionIndex + 1}
              </span>
            ) : (
              <span className="text-sm font-bold text-[oklch(0.40_0.15_188)] dark:text-[oklch(0.79_0.18_188)]">
                On Deck #{sectionIndex + 1}
              </span>
            )}
            {match.is_mixed_level && (
              <span
                className="rounded-full border px-2 py-0.5
                            text-[10px] font-bold uppercase tracking-wider
                            bg-[oklch(0.79_0.18_188/0.10)] border-[oklch(0.65_0.15_188/0.40)] text-[oklch(0.35_0.15_188)]
                            dark:bg-[oklch(0.79_0.18_188/0.12)]
                            dark:border-[oklch(0.79_0.18_188/0.35)]
                            dark:text-[oklch(0.79_0.18_188)]"
              >
                Mixed Level
              </span>
            )}
            <MatchOriginTag origin={match.origin} />
          </div>
          <span
            className={[
              "text-xs font-medium shrink-0 transition-colors duration-[250ms]",
              effectivelyDraft
                ? "text-slate-400 dark:text-slate-500"
                : "text-[oklch(0.50_0.14_188)] dark:text-[oklch(0.68_0.14_188)]",
            ].join(" ")}
          >
            {mins === 0 ? "Just formed" : `${mins}m ago`}
          </span>
        </div>
      </div>

      {/* ── Teams grid ─────────────────────────────────────── */}
      <TeamsGrid
        teamA={teamA}
        teamB={teamB}
        onPlayerTap={handlePlayerTap}
        selectedPlayerId={selectedPlayerId}
        isSwapModeActive={isSwapModeActive}
        labelA="Your Team"
        labelB="Opponents"
      />

      {/* ── H2H record strip ─────────────────────────────────── */}
      <H2HStrip
        teamAIds={teamA.map((p) => p.player_id)}
        teamBIds={teamB.map((p) => p.player_id)}
        sessionId={match.session_id}
      />

      {/* ── Footer ──────────────────────────────────────────── */}
      <div className="px-3 py-2 bg-slate-50 dark:bg-muted/50 border-t border-slate-100 dark:border-border flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground min-w-0 truncate">
          {effectivelyDraft
            ? "Hidden from players — publish to reveal"
            : isPickingMode && selectedPlayerId
              ? "Tap another player to swap"
              : "Tap any player to start a swap"}
        </p>

        <div className="flex items-center gap-2 shrink-0">
          {/* Publish button — only shown for drafts */}
          {effectivelyDraft && (
            <button
              onClick={() => onPublish(match.id)}
              disabled={isPublishing || isPickingMode}
              className="flex items-center gap-1.5 rounded-lg
                         bg-[oklch(0.55_0.18_188)] hover:bg-[oklch(0.62_0.18_188)]
                         dark:bg-[oklch(0.79_0.18_188/0.25)] dark:hover:bg-[oklch(0.79_0.18_188/0.38)]
                         dark:text-[oklch(0.79_0.18_188)] dark:border dark:border-[oklch(0.79_0.18_188/0.50)]
                         transition-colors px-3 min-h-[44px] text-xs font-semibold text-white
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle className="h-3.5 w-3.5 shrink-0" />
              {isPublishing ? "Publishing…" : "Publish"}
            </button>
          )}

          {/* Clear button */}
          <button
            onClick={() => onClear(match.id)}
            disabled={isClearing || isPickingMode}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-200
                       bg-red-50 px-3 min-h-[44px] text-xs font-semibold text-red-700
                       hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40
                       dark:text-red-400 dark:hover:bg-red-950/60
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 className="h-4 w-4 shrink-0" />
            {isClearing ? "Clearing…" : "Clear"}
          </button>
        </div>
      </div>

      {/* ── Inline error ───────────────────────────────────── */}
      {error && <p className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

// ── OverlayCard — pure visual, NO dnd hooks ──────────────────
// Rendered inside <DragOverlay>. Never calls useSortable.

function OverlayCard({
  match,
  sectionIndex,
  isDraft,
}: {
  match: EnrichedMatch;
  sectionIndex: number;
  isDraft: boolean;
}) {
  const { teamA, teamB } = getTeams(match);
  const mins = minutesSince(match.created_at);

  return (
    <div
      className={[
        "rounded-2xl border-2 shadow-2xl overflow-hidden rotate-1",
        isDraft
          ? "border-dashed border-slate-300 dark:border-slate-600 bg-card"
          : "border-[oklch(0.79_0.18_188/0.45)] dark:border-[oklch(0.79_0.18_188/0.30)] bg-card",
      ].join(" ")}
    >
      <div
        className={[
          "flex items-center gap-1 px-2 py-2.5 border-b",
          isDraft
            ? "bg-slate-50 dark:bg-muted/30 border-slate-200 dark:border-slate-700"
            : "bg-[oklch(0.79_0.18_188/0.06)] dark:bg-[oklch(0.79_0.18_188/0.08)] border-[oklch(0.79_0.18_188/0.20)] dark:border-[oklch(0.79_0.18_188/0.18)]",
        ].join(" ")}
      >
        <div className="touch-none select-none cursor-grabbing flex items-center justify-center p-1 rounded">
          <GripVertical
            className={[
              "h-5 w-5 shrink-0",
              isDraft ? "text-slate-400 dark:text-slate-500" : "text-[oklch(0.65_0.15_188)] dark:text-[oklch(0.79_0.18_188)]",
            ].join(" ")}
          />
        </div>
        <div className="pointer-events-none select-none flex flex-1 items-center justify-between min-w-0 pl-1">
          <div className="flex items-center gap-2 min-w-0">
            {isDraft ? (
              <span className="text-sm font-bold text-slate-500 dark:text-slate-400">
                Draft #{sectionIndex + 1}
              </span>
            ) : (
              <span className="text-sm font-bold text-[oklch(0.40_0.15_188)] dark:text-[oklch(0.79_0.18_188)]">
                On Deck #{sectionIndex + 1}
              </span>
            )}
            {match.is_mixed_level && (
              <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-[oklch(0.79_0.18_188/0.10)] border-[oklch(0.65_0.15_188/0.40)] text-[oklch(0.35_0.15_188)] dark:bg-[oklch(0.79_0.18_188/0.12)] dark:border-[oklch(0.79_0.18_188/0.35)] dark:text-[oklch(0.79_0.18_188)]">
                Mixed Level
              </span>
            )}
            <MatchOriginTag origin={match.origin} />
          </div>
          <span
            className={[
              "text-xs font-medium shrink-0",
              isDraft ? "text-slate-400 dark:text-slate-500" : "text-[oklch(0.50_0.14_188)] dark:text-[oklch(0.68_0.14_188)]",
            ].join(" ")}
          >
            {mins === 0 ? "Just formed" : `${mins}m ago`}
          </span>
        </div>
      </div>

      <TeamsGrid teamA={teamA} teamB={teamB} labelA="Your Team" labelB="Opponents" />

      <div className="px-3 py-2 bg-slate-50 dark:bg-muted/50 border-t border-slate-100 dark:border-border flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {isDraft ? "Hidden from players — publish to reveal" : "Tap any player to start a swap"}
        </p>
        <button
          disabled
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 min-h-[44px] text-xs font-semibold text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400 opacity-50 cursor-not-allowed"
        >
          <Trash2 className="h-4 w-4" />
          Clear
        </button>
      </div>
    </div>
  );
}

// ── CapSaturationNotice ───────────────────────────────────────
// Extracted to avoid duplicating the same JSX in both the empty-
// state and non-empty-state render paths. Returns null when
// capSaturation is null so callers need no extra guard.

function CapSaturationNotice({
  capSaturation,
  onDismiss,
}: {
  capSaturation: CapSaturationPayload | null;
  onDismiss?: () => void;
}) {
  if (!capSaturation) return null;

  const isRedZone = capSaturation.type === "red_zone";

  return (
    <div
      role="alert"
      aria-label="Partner-pair cap notice"
      className={[
        "rounded-xl border animate-in slide-in-from-top-1 fade-in duration-200",
        isRedZone
          ? "border-red-300 dark:border-red-700/60 bg-red-50 dark:bg-red-950/40"
          : "border-orange-200 dark:border-orange-500/30 bg-orange-50/80 dark:bg-orange-500/10",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <AlertTriangle
            className={[
              "h-4 w-4 mt-0.5 shrink-0",
              isRedZone ? "text-red-600 dark:text-red-400" : "text-orange-500 dark:text-orange-400",
            ].join(" ")}
          />
          <div className="min-w-0">
            <p
              className={[
                "text-sm font-semibold",
                isRedZone
                  ? "text-red-900 dark:text-red-300"
                  : "text-orange-900 dark:text-orange-300",
              ].join(" ")}
            >
              Partner-pair cap reached
              {isRedZone && (
                <span className="ml-1.5 text-xs font-bold uppercase tracking-wider">— urgent</span>
              )}
            </p>
            <p
              className={[
                "text-xs mt-0.5 leading-relaxed",
                isRedZone
                  ? "text-red-700 dark:text-red-400"
                  : "text-orange-700 dark:text-orange-400",
              ].join(" ")}
            >
              {isRedZone
                ? `${capSaturation.anchorPlayerName} has been waiting over 25 min but all available teammates have already hit the ${MAX_PARTNERSHIP_REPEATS}-game partner cap. Manual assignment needed.`
                : `Could not form a match for ${capSaturation.anchorPlayerName} — all partner combinations have reached the ${MAX_PARTNERSHIP_REPEATS}-game cap. Consider a manual override or wait for ongoing matches to finish.`}
            </p>
          </div>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss partner-pair cap notice"
            className={[
              "shrink-0 rounded-md p-1 transition-colors",
              isRedZone
                ? "text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50"
                : "text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-900/30",
            ].join(" ")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
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

  // ── Publish All handler ────────────────────────────────────

  const handlePublishAll = useCallback(async () => {
    setIsPublishingAll(true);
    setPublishAllError(null);
    // Only include matches that are still truly draft (exclude any already in
    // optimisticPublishedIds from a concurrent per-card publish in-flight).
    // This prevents a failing Publish All from reverting a separate in-flight
    // individual publish that happened to overlap.
    const draftIds = orderedMatches
      .filter((m) => !m.is_published && !optimisticPublishedIds.has(m.id))
      .map((m) => m.id);
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
  }, [orderedMatches, optimisticPublishedIds, onPublishAllDrafts]);

  // ── Derived section lists ──────────────────────────────────
  // Both sections reference orderedMatches so drag across the
  // draft/published boundary preserves the global sort order.
  const draftMatches = orderedMatches.filter(
    (m) => !m.is_published && !optimisticPublishedIds.has(m.id)
  );
  const publishedMatches = orderedMatches.filter(
    (m) => m.is_published || optimisticPublishedIds.has(m.id)
  );
  const draftCount = draftMatches.length;

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
      {/* ── Cap saturation notice ── shown when pair cap blocked a match ── */}
      <CapSaturationNotice capSaturation={capSaturation} onDismiss={onDismissCapSaturation} />

      {/* ── Publish All banner ── shown when there are drafts ── */}
      {draftCount > 0 && (
        <div
          role="status"
          aria-label={`${draftCount} on-deck match${draftCount !== 1 ? "es" : ""} waiting for approval`}
          className="rounded-xl border border-[oklch(0.65_0.15_188/0.35)] dark:border-[oklch(0.79_0.18_188/0.25)]
                     bg-[oklch(0.79_0.18_188/0.06)] dark:bg-[oklch(0.79_0.18_188/0.08)]
                     animate-in slide-in-from-top-1 fade-in duration-200"
        >
          <div className="flex items-center justify-between gap-3 px-4 py-2">
            <div className="flex items-center gap-2 text-sm text-[oklch(0.35_0.15_188)] dark:text-[oklch(0.79_0.18_188)] min-w-0">
              <EyeOff className="h-4 w-4 shrink-0 text-[oklch(0.50_0.14_188)] dark:text-[oklch(0.68_0.14_188)]" />
              <span className="font-medium">
                <span className="font-bold">{draftCount}</span> on-deck match
                {draftCount !== 1 ? "es" : ""} waiting for approval
              </span>
            </div>
            <button
              onClick={handlePublishAll}
              disabled={isPublishingAll}
              className="shrink-0 flex items-center gap-1.5 rounded-lg
                         bg-[oklch(0.55_0.18_188)] hover:bg-[oklch(0.62_0.18_188)]
                         dark:bg-[oklch(0.79_0.18_188/0.25)] dark:hover:bg-[oklch(0.79_0.18_188/0.38)]
                         dark:text-[oklch(0.89_0.12_188)] dark:border dark:border-[oklch(0.79_0.18_188/0.50)]
                         transition-colors px-4 min-h-[44px] text-sm font-semibold text-white
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPublishingAll ? "Publishing…" : "Publish All"}
            </button>
          </div>
          {publishAllError && (
            <p role="alert" className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">
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
        <SortableContext items={orderedMatches.map((m) => m.id)} strategy={rectSortingStrategy}>
          {/* ── Drafts section ─────────────────────────────── */}
          {draftMatches.length > 0 && (
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
          {draftMatches.length > 0 && publishedMatches.length > 0 && (
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
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[oklch(0.79_0.18_188)] opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[oklch(0.55_0.18_188)] dark:bg-[oklch(0.79_0.18_188)]" />
                </span>
                <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                  On Deck
                </span>
                <span className="rounded-full px-2 py-0.5 text-xs font-bold bg-[oklch(0.79_0.18_188/0.10)] text-[oklch(0.35_0.15_188)] ring-1 ring-[oklch(0.65_0.15_188/0.40)] dark:bg-[oklch(0.79_0.18_188/0.15)] dark:text-[oklch(0.79_0.18_188)] dark:ring-[oklch(0.79_0.18_188/0.40)]">
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
