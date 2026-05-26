"use client";

// ============================================================
// SortableCard + OverlayCard — on-deck match card components
// ============================================================
// Extracted from on-deck-panel.tsx for single-concern isolation.
//
// SortableCard: full interactive card with dnd-kit hooks,
//   player tap, publish, and clear actions.
// OverlayCard:  pure visual clone rendered in <DragOverlay>,
//   never calls useSortable.
// ============================================================

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, CheckCircle, GripVertical, Trash2, X } from "lucide-react";
import { TeamsGrid, type RosterPlayer } from "@/components/organizer/match-roster";
import { H2HStrip } from "@/components/organizer/h2h-strip";
import { MatchOriginTag } from "@/components/organizer/match-origin-tag";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";
import type { CapSaturationPayload } from "@/lib/broadcast";
import { CRITICAL_WAIT_MINUTES, MAX_PARTNERSHIP_REPEATS } from "@/lib/constants";
import type { SwapContext } from "./on-deck-panel";

// ── Helpers ───────────────────────────────────────────────────

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
        win_streak: p.win_streak ?? 0,
      })),
    teamB: match.players
      .filter((p) => p.team === "b")
      .map((p) => ({
        player_id: p.player_id,
        display_name: p.profile.display_name,
        skill_level: p.profile.skill_level,
        vip_tag: p.profile.vip_tag,
        vip_theme: p.profile.vip_theme,
        win_streak: p.win_streak ?? 0,
      })),
  };
}

function minutesSince(dateStr: string) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 60_000);
}

// ── CapSaturationNotice ───────────────────────────────────────
// Extracted to avoid duplicating the same JSX in both the empty-
// state and non-empty-state render paths. Returns null when
// capSaturation is null so callers need no extra guard.

export function CapSaturationNotice({
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
                ? `${capSaturation.anchorPlayerName} has been waiting over ${CRITICAL_WAIT_MINUTES} min but all available teammates have already hit the ${MAX_PARTNERSHIP_REPEATS}-game partner cap. Manual assignment needed.`
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

export function SortableCard({
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
    // Outer wrapper carries drop-shadow (clip-path on inner clips box-shadow)
    <div
      ref={setNodeRef}
      style={{
        ...style,
        filter: !effectivelyDraft
          ? selectedPlayerId
            ? "drop-shadow(0 4px 16px var(--cc-accent-glow))"
            : "drop-shadow(0 0 12px var(--cc-accent-glow))"
          : undefined,
      }}
    >
      <div
        className={[
          "relative clip-cut border-2 overflow-hidden",
          // Animate the border/bg change for the publish transition
          "transition-colors duration-[250ms] ease-out",
          // Draft: dashed slate border — indicates "hidden from players"
          // Published: solid teal border + corner accent + scan shimmer
          effectivelyDraft
            ? "border-dashed border-cc-border bg-cc-bg-2"
            : selectedPlayerId
              ? "border-cc-accent/80 bg-cc-bg-2 cc-corner-accent cc-scan"
              : "border-cc-deck-border bg-cc-bg-2 cc-corner-accent cc-scan",
        ].join(" ")}
      >
        {/* ── Card header row ────────────────────────────────── */}
        <div
          className={[
            "flex items-center gap-1 px-2 py-2.5 border-b transition-colors duration-[250ms] ease-out",
            effectivelyDraft
              ? "bg-cc-bg-3 border-cc-border"
              : "bg-cc-accent-dim border-cc-accent/20",
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
                     hover:bg-cc-accent/10 transition-colors"
            aria-label="Drag to reorder"
          >
            <GripVertical
              className={[
                "h-5 w-5 shrink-0 transition-colors duration-[250ms]",
                effectivelyDraft ? "text-cc-t3" : "text-cc-accent",
              ].join(" ")}
            />
          </div>

          {/* Label + badges + origin tag */}
          <div className="pointer-events-none select-none flex flex-1 items-center justify-between min-w-0 pl-1">
            <div className="flex items-center gap-2 min-w-0">
              {effectivelyDraft ? (
                <span className="text-sm font-bold text-cc-t2">Draft #{sectionIndex + 1}</span>
              ) : (
                <span className="font-command text-[11px] uppercase tracking-[0.16em] text-cc-accent-text">
                  On Deck #{sectionIndex + 1}
                </span>
              )}
              {match.is_mixed_level && (
                <span
                  className="clip-cut-badge border px-2 py-0.5
                            font-command text-[9px] uppercase tracking-[0.10em]
                            bg-cc-accent-dim border-cc-accent/35 text-cc-accent-text"
                >
                  Mixed Level
                </span>
              )}
              <MatchOriginTag origin={match.origin} />
            </div>
            <span
              className={[
                "text-xs font-medium shrink-0 transition-colors duration-[250ms]",
                effectivelyDraft ? "text-cc-t3" : "text-cc-t2",
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
        <div className="px-3 py-2 bg-cc-bg-3 border-t border-cc-border flex items-center justify-between gap-2">
          <p className="text-xs text-cc-t3 min-w-0 truncate">
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
                className="flex items-center gap-1.5 clip-cut-sm
                         bg-cc-accent hover:bg-cc-accent/90
                         border border-cc-accent/50
                         transition-colors px-3 min-h-[44px] font-command text-[10px] uppercase tracking-[0.10em] text-cc-btn-on-accent
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
              className="flex shrink-0 items-center gap-1.5 clip-cut-sm border border-cc-red/30
                       bg-cc-red-dim px-3 min-h-[44px] font-command text-[10px] uppercase tracking-[0.10em] text-cc-red
                       hover:bg-cc-red/20
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              {isClearing ? "Clearing…" : "Clear"}
            </button>
          </div>
        </div>

        {/* ── Inline error ───────────────────────────────────── */}
        {error && <p className="px-4 pb-2 text-xs text-cc-red">{error}</p>}
      </div>
    </div>
  );
}

// ── OverlayCard — pure visual, NO dnd hooks ──────────────────
// Rendered inside <DragOverlay>. Never calls useSortable.

export function OverlayCard({
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
        "relative clip-cut border-2 overflow-hidden rotate-1",
        isDraft
          ? "border-dashed border-cc-border bg-cc-bg-2"
          : "border-cc-deck-border bg-cc-bg-2 cc-corner-accent cc-scan",
      ].join(" ")}
      style={{
        filter: isDraft ? undefined : "drop-shadow(0 8px 24px var(--cc-accent-glow))",
      }}
    >
      <div
        className={[
          "flex items-center gap-1 px-2 py-2.5 border-b",
          isDraft ? "bg-cc-bg-3 border-cc-border" : "bg-cc-accent-dim border-cc-accent/20",
        ].join(" ")}
      >
        <div className="touch-none select-none cursor-grabbing flex items-center justify-center p-1 rounded">
          <GripVertical
            className={["h-5 w-5 shrink-0", isDraft ? "text-cc-t3" : "text-cc-accent"].join(" ")}
          />
        </div>
        <div className="pointer-events-none select-none flex flex-1 items-center justify-between min-w-0 pl-1">
          <div className="flex items-center gap-2 min-w-0">
            {isDraft ? (
              <span className="text-sm font-bold text-cc-t2">Draft #{sectionIndex + 1}</span>
            ) : (
              <span className="font-command text-[11px] uppercase tracking-[0.16em] text-cc-accent-text">
                On Deck #{sectionIndex + 1}
              </span>
            )}
            {match.is_mixed_level && (
              <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-cc-accent-dim border-cc-accent/35 text-cc-accent-text">
                Mixed Level
              </span>
            )}
            <MatchOriginTag origin={match.origin} />
          </div>
          <span
            className={["text-xs font-medium shrink-0", isDraft ? "text-cc-t3" : "text-cc-t2"].join(
              " "
            )}
          >
            {mins === 0 ? "Just formed" : `${mins}m ago`}
          </span>
        </div>
      </div>

      <TeamsGrid teamA={teamA} teamB={teamB} labelA="Your Team" labelB="Opponents" />

      <div className="px-3 py-2 bg-cc-bg-3 border-t border-cc-border flex items-center justify-between gap-2">
        <p className="text-xs text-cc-t3">
          {isDraft ? "Hidden from players — publish to reveal" : "Tap any player to start a swap"}
        </p>
        <button
          disabled
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-cc-red/30 bg-cc-red-dim px-3 min-h-[44px] text-xs font-semibold text-cc-red opacity-50 cursor-not-allowed"
        >
          <Trash2 className="h-4 w-4" />
          Clear
        </button>
      </div>
    </div>
  );
}
