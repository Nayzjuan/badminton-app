"use client";

// ============================================================
// match-roster.tsx — Shared player roster sub-components
// ============================================================
// Replaces BadmintonCourt in both OnDeckPanel and ActiveCourts
// with a CSS-grid roster layout:
//
//   col 1 (1fr)   │ col 2 (40px) │ col 3 (1fr)
//   ──────────────┼──────────────┼──────────────
//   row 1  label  │              │ label
//   row 2  A[0]   │    [VS]      │ B[0]
//   row 3  A[1]   │   (span 2)   │ B[1]
//
// Each player row is two lines:
//   Line 1 — "Name | TAG"   (name shrinks, tag always visible)
//   Line 2 — skill dot · abbreviation · optional swap icon
//
// Exported:
//   TeamsGrid       — the full 3-col grid
//   RosterPlayer    — shared player data shape
// ============================================================

import { ArrowLeftRight } from "lucide-react";
import { VipTag } from "@/components/ui/vip-tag";
import { SKILL_META } from "@/lib/constants";
import type { SkillLevel } from "@/types/database";

// ── Types ──────────────────────────────────────────────────────

export interface RosterPlayer {
  player_id: string;
  display_name: string;
  skill_level: SkillLevel;
  /** VIP display label (e.g. "MVP"). null = no tag shown. */
  vip_tag?: string | null;
  /** VIP theme key (e.g. "cyber-neon"). Must pair with vip_tag. */
  vip_theme?: string | null;
}

// ── Skill config (dark only) ────────────────────────────────────
// SKILL_META (from constants.ts) handles the themed light/dark dot colors.
// SKILL_CONFIG_DARK covers the always-dark navy court visualization where
// dot → text color only, matching the preview spec.
// ADV/U.INT → amber, INT/L.INT → teal, L.ADV → blue, BEG → muted
const SKILL_CONFIG_DARK: Record<SkillLevel, { color: string; abbr: string }> = {
  beginner: { color: "text-cc-t3", abbr: "Beg" },
  lower_intermediate: { color: "text-cc-accent", abbr: "L.Int" },
  intermediate: { color: "text-cc-accent", abbr: "Int" },
  upper_intermediate: { color: "text-cc-amber", abbr: "U.Int" },
  lower_advanced: { color: "text-cc-blue", abbr: "L.Adv" },
  advanced: { color: "text-cc-amber", abbr: "Adv" },
};

// ── Internal: skill indicators ─────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function SkillDot({ level }: { level: SkillLevel }) {
  const { dot, abbr } = SKILL_META[level] ?? { dot: "bg-slate-400", abbr: "?" };
  return (
    <div className="flex shrink-0 items-center gap-1" aria-label={level}>
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 leading-none">
        {abbr}
      </span>
    </div>
  );
}

function SkillLevelDark({ level }: { level: SkillLevel }) {
  const { color, abbr } = SKILL_CONFIG_DARK[level] ?? { color: "text-white/40", abbr: "?" };
  return (
    <span
      className={`font-command text-[9px] font-bold uppercase tracking-[0.14em] leading-none ${color}`}
      aria-label={level}
    >
      {abbr}
    </span>
  );
}

// ── Internal: VS badge ─────────────────────────────────────────

function VsBadge({ dark: _dark }: { dark?: boolean }) {
  // Both on-deck (light) and court cards (dark) use vertical lines + text
  // per preview .vs-divider / .court-vs spec.
  return (
    <div className="flex flex-col items-center gap-1" aria-hidden="true">
      <div className="w-px h-3.5 bg-cc-border" />
      <span className="font-command text-[8px] font-bold text-cc-t3">VS</span>
      <div className="w-px h-3.5 bg-cc-border" />
    </div>
  );
}

// ── Internal: player row — light / on-deck ─────────────────────
// Two-line layout:
//   Line 1 — "Name | TAG": name shrinks first (no flex-1), tag is shrink-0
//   Line 2 — skill dot · swap icon (hover-reveal, only when swappable)
//
// When onSwapClick is provided, the whole row becomes a <button>
// and a swap icon is revealed on hover (line 2, ml-auto).

interface PlayerRowLightProps {
  player: RosterPlayer;
  /** Highlights this row — the swap source player. */
  isSelected?: boolean;
  /** Any picking mode active — show pointer affordance on this row. */
  isSwapTarget?: boolean;
  /** Called when row is tapped to initiate/complete a swap. */
  onSwapClick?: () => void;
  /** When myPlayerId is set: true = you, false = others (dim others). */
  isMe?: boolean;
}

function PlayerRowLight({
  player,
  isSelected,
  isSwapTarget,
  isMe,
  onSwapClick,
}: PlayerRowLightProps) {
  const hasTag = !!(player.vip_tag && player.vip_theme);

  const classes = [
    "group w-full clip-cut-tr px-3 py-2 text-left transition-colors",
    isSelected
      ? "bg-cc-accent-dim outline outline-1 outline-cc-accent/55"
      : isSwapTarget || onSwapClick
        ? "bg-cc-bg-3 hover:bg-cc-accent-dim cursor-pointer"
        : "bg-cc-bg-3",
  ].join(" ");

  const inner = (
    <>
      {/* Line 1 — "Name | TAG" */}
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span
          className={`shrink min-w-0 truncate font-command text-[12px] leading-none ${
            isMe === false ? "font-medium text-cc-t2" : "font-medium text-cc-t1"
          }`}
        >
          {player.display_name}
        </span>
        {hasTag && (
          <>
            <span
              className="shrink-0 text-[11px] leading-none text-cc-t3 select-none"
              aria-hidden="true"
            >
              |
            </span>
            <span className="shrink-0 leading-none">
              <VipTag tag={player.vip_tag!} theme={player.vip_theme!} />
            </span>
          </>
        )}
      </div>
      {/* Line 2 — skill level (colored text, no dot) + swap icon */}
      <div className="mt-1 flex items-center gap-1.5">
        <SkillLevelDark level={player.skill_level} />
        {onSwapClick && (
          <ArrowLeftRight
            className="ml-auto h-3 w-3 flex-shrink-0 text-cc-accent opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          />
        )}
      </div>
    </>
  );

  if (onSwapClick) {
    return (
      <button
        type="button"
        className={classes}
        onClick={onSwapClick}
        aria-label={`Swap ${player.display_name}`}
        aria-pressed={isSelected ?? false}
        // Prevent dnd-kit from treating a tap-to-swap click as a drag start
        data-no-dnd="true"
        data-testid={`player-pill-${player.player_id}`}
      >
        {inner}
      </button>
    );
  }

  return (
    <div className={classes} data-testid={`player-pill-${player.player_id}`}>
      {inner}
    </div>
  );
}

// ── Internal: player row — dark / active court ─────────────────

interface PlayerRowDarkProps {
  player: RosterPlayer;
  /** When set, this player's name renders bold white ("you are here"). */
  isMe?: boolean;
}

function PlayerRowDark({ player, isMe }: PlayerRowDarkProps) {
  const hasTag = !!(player.vip_tag && player.vip_theme);
  return (
    <div className="w-full clip-cut-tr bg-cc-bg-3 px-3 py-2 transition-colors hover:bg-cc-border">
      {/* Line 1 — name + optional VIP tag */}
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span
          className={`shrink min-w-0 truncate font-command text-[12px] leading-none ${
            isMe ? "font-bold text-cc-t1" : "font-medium text-cc-t1"
          }`}
        >
          {player.display_name}
        </span>
        {hasTag && (
          <>
            <span
              className="shrink-0 text-[11px] leading-none text-cc-t3 select-none"
              aria-hidden="true"
            >
              |
            </span>
            <span className="shrink-0 leading-none">
              <VipTag tag={player.vip_tag!} theme={player.vip_theme!} />
            </span>
          </>
        )}
      </div>
      {/* Line 2 — skill level (colored text, no dot) */}
      <div className="mt-1">
        <SkillLevelDark level={player.skill_level} />
      </div>
    </div>
  );
}

// ── TeamsGrid (exported) ───────────────────────────────────────

export interface TeamsGridProps {
  teamA: RosterPlayer[];
  teamB: RosterPlayer[];
  /** When true, renders dark navy player rows (for active courts). */
  dark?: boolean;
  /** Column A label (defaults to "Team A"). */
  labelA?: string;
  /** Column B label (defaults to "Team B"). */
  labelB?: string;
  /**
   * The logged-in player's ID. When provided, their row gets bold-white
   * emphasis and all other rows are dimmed — used in the player's Live
   * Courts tab to make "you" instantly findable in a busy match roster.
   */
  myPlayerId?: string;
  // ── Swap interaction — on-deck (light) mode only ──────────────
  /** Called when a player row is tapped to initiate/complete a swap. */
  onPlayerTap?: (player: RosterPlayer, team: "a" | "b") => void;
  /** player_id of the currently selected swap-source (teal highlight). */
  selectedPlayerId?: string;
  /** True while any picking-mode swap is in progress. */
  isSwapModeActive?: boolean;
}

export function TeamsGrid({
  teamA,
  teamB,
  dark,
  labelA = "Team A",
  labelB = "Team B",
  myPlayerId,
  onPlayerTap,
  selectedPlayerId,
  isSwapModeActive,
}: TeamsGridProps) {
  const a0 = teamA[0];
  const a1 = teamA[1];
  const b0 = teamB[0];
  const b1 = teamB[1];

  // Guard — require two players per team
  if (!a0 || !a1 || !b0 || !b1) return null;

  return (
    <div className="grid gap-y-2 px-3 py-3" style={{ gridTemplateColumns: "1fr 40px 1fr" }}>
      {/* Row 1 — column labels.
          Dark (court cards): muted "Team A / Team B" per preview .team-header.
          Light/on-deck (light-style player rows): blue/amber per preview
          .team-label.yours / .team-label.opps. */}
      <div style={{ gridColumn: 1, gridRow: 1 }}>
        <span
          className={`font-command text-[9px] uppercase tracking-[0.20em] ${
            dark ? "text-cc-t3" : "text-cc-blue"
          }`}
        >
          {labelA}
        </span>
      </div>
      <div style={{ gridColumn: 2, gridRow: 1 }} aria-hidden="true" />
      <div style={{ gridColumn: 3, gridRow: 1 }} className="text-right">
        <span
          className={`font-command text-[9px] uppercase tracking-[0.20em] ${
            dark ? "text-cc-t3" : "text-cc-amber"
          }`}
        >
          {labelB}
        </span>
      </div>

      {/* VS badge — col 2, spans rows 2–3 */}
      <div
        style={{ gridColumn: 2, gridRow: "2 / span 2" }}
        className="flex items-center justify-center"
      >
        <VsBadge dark={dark} />
      </div>

      {/* Row 2 — first player pair */}
      <div style={{ gridColumn: 1, gridRow: 2 }}>
        {dark ? (
          <PlayerRowDark player={a0} isMe={myPlayerId ? myPlayerId === a0.player_id : undefined} />
        ) : (
          <PlayerRowLight
            player={a0}
            isSelected={selectedPlayerId === a0.player_id}
            isSwapTarget={isSwapModeActive && selectedPlayerId !== a0.player_id}
            isMe={myPlayerId ? myPlayerId === a0.player_id : undefined}
            onSwapClick={onPlayerTap ? () => onPlayerTap(a0, "a") : undefined}
          />
        )}
      </div>
      <div style={{ gridColumn: 3, gridRow: 2 }}>
        {dark ? (
          <PlayerRowDark player={b0} isMe={myPlayerId ? myPlayerId === b0.player_id : undefined} />
        ) : (
          <PlayerRowLight
            player={b0}
            isSelected={selectedPlayerId === b0.player_id}
            isSwapTarget={isSwapModeActive && selectedPlayerId !== b0.player_id}
            isMe={myPlayerId ? myPlayerId === b0.player_id : undefined}
            onSwapClick={onPlayerTap ? () => onPlayerTap(b0, "b") : undefined}
          />
        )}
      </div>

      {/* Row 3 — second player pair */}
      <div style={{ gridColumn: 1, gridRow: 3 }}>
        {dark ? (
          <PlayerRowDark player={a1} isMe={myPlayerId ? myPlayerId === a1.player_id : undefined} />
        ) : (
          <PlayerRowLight
            player={a1}
            isSelected={selectedPlayerId === a1.player_id}
            isSwapTarget={isSwapModeActive && selectedPlayerId !== a1.player_id}
            isMe={myPlayerId ? myPlayerId === a1.player_id : undefined}
            onSwapClick={onPlayerTap ? () => onPlayerTap(a1, "a") : undefined}
          />
        )}
      </div>
      <div style={{ gridColumn: 3, gridRow: 3 }}>
        {dark ? (
          <PlayerRowDark player={b1} isMe={myPlayerId ? myPlayerId === b1.player_id : undefined} />
        ) : (
          <PlayerRowLight
            player={b1}
            isSelected={selectedPlayerId === b1.player_id}
            isSwapTarget={isSwapModeActive && selectedPlayerId !== b1.player_id}
            isMe={myPlayerId ? myPlayerId === b1.player_id : undefined}
            onSwapClick={onPlayerTap ? () => onPlayerTap(b1, "b") : undefined}
          />
        )}
      </div>
    </div>
  );
}
