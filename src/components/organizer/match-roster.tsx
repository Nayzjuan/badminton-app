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

// ── Skill config ───────────────────────────────────────────────
// All 6 levels shown distinctly — no bucket collapsing.
// Two maps: SKILL_CONFIG for themed surfaces (light/dark via dark:),
// SKILL_CONFIG_DARK for the always-dark navy court visualization.
//
// lower_advanced uses fuchsia (not amber) to avoid colliding with
// the app's amber semantic for "pending / on-deck / warning" — an
// amber dot inside an amber-themed on-deck card had no contrast.
//
// Abbreviations mirror SkillBadge labels (shortened for small UI):
//   Beginner       → Beg
//   Lower Int.     → L.Int
//   Intermediate   → Int
//   Upper Int.     → U.Int
//   Lower Adv.     → L.Adv
//   Advanced       → Adv

const SKILL_CONFIG: Record<SkillLevel, { dot: string; abbr: string }> = {
  beginner: { dot: "bg-emerald-500 dark:bg-emerald-400", abbr: "Beg" },
  lower_intermediate: { dot: "bg-teal-500    dark:bg-teal-400", abbr: "L.Int" },
  intermediate: { dot: "bg-sky-500     dark:bg-sky-400", abbr: "Int" },
  upper_intermediate: { dot: "bg-indigo-500  dark:bg-indigo-400", abbr: "U.Int" },
  lower_advanced: { dot: "bg-fuchsia-500 dark:bg-fuchsia-400", abbr: "L.Adv" },
  advanced: { dot: "bg-purple-500  dark:bg-purple-400", abbr: "Adv" },
};

// Always-dark navy court (Active Courts visualization, On Deck cards) —
// use brighter -400 variants directly since dark: would not fire when the
// user's theme is light but the surface is still dark navy.
const SKILL_CONFIG_DARK: Record<SkillLevel, { dot: string; abbr: string }> = {
  beginner: { dot: "bg-emerald-400", abbr: "Beg" },
  lower_intermediate: { dot: "bg-teal-400", abbr: "L.Int" },
  intermediate: { dot: "bg-sky-400", abbr: "Int" },
  upper_intermediate: { dot: "bg-indigo-400", abbr: "U.Int" },
  lower_advanced: { dot: "bg-fuchsia-400", abbr: "L.Adv" },
  advanced: { dot: "bg-purple-400", abbr: "Adv" },
};

// ── Internal: skill indicators ─────────────────────────────────

function SkillDot({ level }: { level: SkillLevel }) {
  const { dot, abbr } = SKILL_CONFIG[level] ?? { dot: "bg-slate-400", abbr: "?" };
  return (
    <div className="flex shrink-0 items-center gap-1" aria-label={level}>
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400 leading-none">
        {abbr}
      </span>
    </div>
  );
}

function SkillDotDark({ level }: { level: SkillLevel }) {
  const { dot, abbr } = SKILL_CONFIG_DARK[level] ?? { dot: "bg-slate-400", abbr: "?" };
  return (
    <div className="flex shrink-0 items-center gap-1" aria-label={level}>
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
      <span className="text-[10px] font-bold uppercase tracking-wide text-white/60 leading-none">
        {abbr}
      </span>
    </div>
  );
}

// ── Internal: VS badge ─────────────────────────────────────────

function VsBadge({ dark }: { dark?: boolean }) {
  return (
    <div
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
        dark
          ? "bg-[oklch(0.79_0.18_188/0.15)] ring-1 ring-[oklch(0.79_0.18_188/0.40)]"
          : "bg-white dark:bg-white/10 ring-1 ring-slate-200 dark:ring-white/20 shadow-sm dark:shadow-none"
      }`}
      aria-hidden="true"
    >
      <span
        className={`text-[10px] font-black tracking-tight ${
          dark ? "text-[oklch(0.79_0.18_188)]" : "text-slate-400 dark:text-white/50"
        }`}
      >
        VS
      </span>
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

function PlayerRowLight({ player, isSelected, isSwapTarget, isMe, onSwapClick }: PlayerRowLightProps) {
  const hasTag = !!(player.vip_tag && player.vip_theme);

  const classes = [
    "group w-full rounded-xl px-3 py-2 text-left transition-colors",
    isSelected
      ? "bg-[oklch(0.79_0.18_188/0.12)] dark:bg-[oklch(0.79_0.18_188/0.15)] ring-1 ring-[oklch(0.65_0.15_188/0.55)] dark:ring-[oklch(0.79_0.18_188/0.50)]"
      : isSwapTarget || onSwapClick
        ? "bg-slate-100/70 dark:bg-white/[0.06] hover:bg-[oklch(0.79_0.18_188/0.08)] dark:hover:bg-[oklch(0.79_0.18_188/0.10)] cursor-pointer"
        : "bg-slate-100/70 dark:bg-white/[0.06]",
  ].join(" ");

  const inner = (
    <>
      {/* Line 1 — "Name | TAG" */}
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span
          className={`shrink min-w-0 truncate text-[13px] leading-none ${
            isMe === false
              ? "font-normal text-slate-500 dark:text-slate-400"
              : "font-bold text-slate-800 dark:text-slate-100"
          }`}
        >
          {player.display_name}
        </span>
        {hasTag && (
          <>
            <span
              className="shrink-0 text-[11px] leading-none text-slate-300 dark:text-white/20 select-none"
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
      {/* Line 2 — skill · swap icon */}
      <div className="mt-1 flex items-center gap-1.5">
        <SkillDot level={player.skill_level} />
        {/* invisible spacer keeps line-2 height consistent */}
        <span className="invisible text-[10px] leading-none" aria-hidden="true">
          _
        </span>
        {onSwapClick && (
          <ArrowLeftRight
            className="ml-auto h-3 w-3 flex-shrink-0 text-[oklch(0.65_0.15_188)] dark:text-[oklch(0.79_0.18_188)] opacity-0 transition-opacity group-hover:opacity-100"
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
  /** Tailwind text-* class for the player name (team colour). */
  teamColor: string;
  /** When set, this player's name renders bold white ("you are here"). */
  isMe?: boolean;
}

function PlayerRowDark({ player, teamColor, isMe }: PlayerRowDarkProps) {
  const hasTag = !!(player.vip_tag && player.vip_theme);
  return (
    <div
      className="w-full rounded-xl px-3 py-2 transition-colors hover:bg-white/5"
      style={{ background: "rgba(255,255,255,0.04)" }}
    >
      {/* Line 1 — "Name | TAG" */}
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span
          className={`shrink min-w-0 truncate text-[13px] leading-none ${
            isMe ? "font-bold text-white" : `font-normal ${teamColor}`
          }`}
        >
          {player.display_name}
        </span>
        {hasTag && (
          <>
            <span
              className="shrink-0 text-[11px] leading-none text-white/25 select-none"
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
      {/* Line 2 — skill */}
      <div className="mt-1 flex items-center gap-1.5">
        <SkillDotDark level={player.skill_level} />
        <span className="invisible text-[10px] leading-none" aria-hidden="true">
          _
        </span>
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
      {/* Row 1 — column labels */}
      <div style={{ gridColumn: 1, gridRow: 1 }}>
        <span
          className={`text-[10px] font-black uppercase tracking-widest ${
            dark ? "text-sky-400/70" : "text-sky-600 dark:text-sky-400"
          }`}
        >
          {labelA}
        </span>
      </div>
      <div style={{ gridColumn: 2, gridRow: 1 }} aria-hidden="true" />
      <div style={{ gridColumn: 3, gridRow: 1 }} className="text-right">
        <span
          className={`text-[10px] font-black uppercase tracking-widest ${
            dark ? "text-amber-400/70" : "text-amber-600 dark:text-amber-400"
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
          <PlayerRowDark player={a0} teamColor="text-sky-200" isMe={myPlayerId ? myPlayerId === a0.player_id : undefined} />
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
          <PlayerRowDark player={b0} teamColor="text-amber-200" isMe={myPlayerId ? myPlayerId === b0.player_id : undefined} />
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
          <PlayerRowDark player={a1} teamColor="text-sky-200" isMe={myPlayerId ? myPlayerId === a1.player_id : undefined} />
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
          <PlayerRowDark player={b1} teamColor="text-amber-200" isMe={myPlayerId ? myPlayerId === b1.player_id : undefined} />
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
