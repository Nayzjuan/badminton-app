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
// Dot colours match the login-form SKILL_COLORS palette so the
// same player looks identical across every surface.
// Abbreviations mirror SkillBadge labels (shortened for small UI):
//   Beginner       → Beg
//   Lower Int.     → L.Int
//   Intermediate   → Int
//   Upper Int.     → U.Int
//   Lower Adv.     → L.Adv
//   Advanced       → Adv

const SKILL_CONFIG: Record<SkillLevel, { dot: string; abbr: string }> = {
  beginner:           { dot: "bg-emerald-500", abbr: "Beg"   },
  lower_intermediate: { dot: "bg-teal-500",    abbr: "L.Int" },
  intermediate:       { dot: "bg-sky-500",     abbr: "Int"   },
  upper_intermediate: { dot: "bg-indigo-500",  abbr: "U.Int" },
  lower_advanced:     { dot: "bg-amber-500",   abbr: "L.Adv" },
  advanced:           { dot: "bg-purple-500",  abbr: "Adv"   },
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
  const { dot, abbr } = SKILL_CONFIG[level] ?? { dot: "bg-slate-400", abbr: "?" };
  return (
    <div className="flex shrink-0 items-center gap-1" aria-label={level}>
      <span className={`h-2 w-2 rounded-full ${dot} opacity-80`} aria-hidden="true" />
      <span className="text-[10px] font-bold uppercase tracking-wide text-white/40 leading-none">
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
          ? "bg-emerald-500/20 ring-1 ring-emerald-500/40"
          : "bg-white dark:bg-white/10 ring-1 ring-slate-200 dark:ring-white/20 shadow-sm dark:shadow-none"
      }`}
      aria-hidden="true"
    >
      <span
        className={`text-[10px] font-black tracking-tight ${
          dark ? "text-emerald-400" : "text-slate-400 dark:text-white/50"
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
  /** Highlights this row amber — the swap source player. */
  isSelected?: boolean;
  /** Any picking mode active — show pointer affordance on this row. */
  isSwapTarget?: boolean;
  /** Called when row is tapped to initiate/complete a swap. */
  onSwapClick?: () => void;
}

function PlayerRowLight({
  player,
  isSelected,
  isSwapTarget,
  onSwapClick,
}: PlayerRowLightProps) {
  const hasTag = !!(player.vip_tag && player.vip_theme);

  const classes = [
    "group w-full rounded-xl px-3 py-2 text-left transition-colors",
    isSelected
      ? "bg-amber-100 dark:bg-amber-500/15 ring-1 ring-amber-400 dark:ring-amber-500/40"
      : isSwapTarget || onSwapClick
      ? "bg-slate-100/70 dark:bg-white/[0.06] hover:bg-amber-50/60 dark:hover:bg-amber-500/10 cursor-pointer"
      : "bg-slate-100/70 dark:bg-white/[0.06]",
  ].join(" ");

  const inner = (
    <>
      {/* Line 1 — "Name | TAG" */}
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span className="shrink min-w-0 truncate text-[13px] font-bold leading-none text-slate-800 dark:text-slate-100">
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
            className="ml-auto h-3 w-3 flex-shrink-0 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100"
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
}

function PlayerRowDark({ player, teamColor }: PlayerRowDarkProps) {
  const hasTag = !!(player.vip_tag && player.vip_theme);
  return (
    <div
      className="w-full rounded-xl px-3 py-2 transition-colors hover:bg-white/5"
      style={{ background: "rgba(255,255,255,0.04)" }}
    >
      {/* Line 1 — "Name | TAG" */}
      <div className="flex items-center gap-1.5 overflow-hidden">
        <span
          className={`shrink min-w-0 truncate text-[13px] font-bold leading-none ${teamColor}`}
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
  // ── Swap interaction — on-deck (light) mode only ──────────────
  /** Called when a player row is tapped to initiate/complete a swap. */
  onPlayerTap?: (player: RosterPlayer, team: "a" | "b") => void;
  /** player_id of the currently selected swap-source (amber highlight). */
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
    <div
      className="grid gap-y-2 px-3 py-3"
      style={{ gridTemplateColumns: "1fr 40px 1fr" }}
    >
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
          <PlayerRowDark player={a0} teamColor="text-sky-200" />
        ) : (
          <PlayerRowLight
            player={a0}
            isSelected={selectedPlayerId === a0.player_id}
            isSwapTarget={isSwapModeActive && selectedPlayerId !== a0.player_id}
            onSwapClick={onPlayerTap ? () => onPlayerTap(a0, "a") : undefined}
          />
        )}
      </div>
      <div style={{ gridColumn: 3, gridRow: 2 }}>
        {dark ? (
          <PlayerRowDark player={b0} teamColor="text-amber-200" />
        ) : (
          <PlayerRowLight
            player={b0}
            isSelected={selectedPlayerId === b0.player_id}
            isSwapTarget={isSwapModeActive && selectedPlayerId !== b0.player_id}
            onSwapClick={onPlayerTap ? () => onPlayerTap(b0, "b") : undefined}
          />
        )}
      </div>

      {/* Row 3 — second player pair */}
      <div style={{ gridColumn: 1, gridRow: 3 }}>
        {dark ? (
          <PlayerRowDark player={a1} teamColor="text-sky-200" />
        ) : (
          <PlayerRowLight
            player={a1}
            isSelected={selectedPlayerId === a1.player_id}
            isSwapTarget={isSwapModeActive && selectedPlayerId !== a1.player_id}
            onSwapClick={onPlayerTap ? () => onPlayerTap(a1, "a") : undefined}
          />
        )}
      </div>
      <div style={{ gridColumn: 3, gridRow: 3 }}>
        {dark ? (
          <PlayerRowDark player={b1} teamColor="text-amber-200" />
        ) : (
          <PlayerRowLight
            player={b1}
            isSelected={selectedPlayerId === b1.player_id}
            isSwapTarget={isSwapModeActive && selectedPlayerId !== b1.player_id}
            onSwapClick={onPlayerTap ? () => onPlayerTap(b1, "b") : undefined}
          />
        )}
      </div>
    </div>
  );
}
