"use client";

// ============================================================
// LeaderboardHeroCard — Pinned personal rank card
// ============================================================
// Always visible at the top of the leaderboard when the user
// is authenticated, regardless of their table position.
//
// Three states:
//   qualified      — full stats + rank + streak
//   below-threshold — "Play N more games to appear"
//   zero-games     — "You haven't played yet this session"
//
// Design tokens (per UI spec):
//   border-2 border-indigo-300 dark:border-amber-500/60
//   bg-indigo-50 dark:bg-amber-950/30
//   Rank number: text-3xl font-black
//   "★ YOU" label: text-[10px] uppercase tracking-widest
// ============================================================

import { Trophy } from "lucide-react";
import { VipTag } from "@/components/ui/vip-tag";
import type { LeaderboardRow } from "@/types/leaderboard";

// Minimum GP to appear on the board (matches server action constant)
const MIN_SESSION_GP = 3;
const MIN_ALLTIME_GP = 10;

interface LeaderboardHeroCardProps {
  /** The logged-in player's enriched row, or null if not found */
  row: LeaderboardRow | null;
  /** Total qualified players (for "you're #N of M" display) */
  totalPlayers: number;
  /** Scope affects the minimum GP message */
  scope: "session" | "alltime";
  /** True when data is still loading — show skeleton */
  loading?: boolean;
}

function streakDisplay(streak: number): string | null {
  if (streak < 3) return null;
  if (streak === 3) return "🔥🔥🔥";
  return `🔥×${streak}`;
}

export function LeaderboardHeroCard({
  row,
  totalPlayers,
  scope,
  loading = false,
}: LeaderboardHeroCardProps) {
  const minGP = scope === "session" ? MIN_SESSION_GP : MIN_ALLTIME_GP;

  // ── Loading skeleton ────────────────────────────────────────
  if (loading) {
    return (
      <div
        className="h-14 rounded-xl border-2 border-amber-200/50 dark:border-amber-900/30
                   bg-slate-100 dark:bg-muted animate-pulse"
        aria-hidden="true"
      />
    );
  }

  const baseCard =
    "rounded-xl border-2 border-amber-300 dark:border-amber-500/60 " +
    "bg-amber-50 dark:bg-amber-950/30 shadow-md dark:shadow-amber-900/20 " +
    "px-4 py-3";

  // ── Zero games state ────────────────────────────────────────
  if (!row || row.games_played === 0) {
    return (
      <div
        className={baseCard}
        aria-label="Your current status: no games played yet"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full
                          bg-amber-100 dark:bg-amber-900/40">
            <Trophy className="h-4 w-4 text-amber-500 dark:text-amber-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              You haven&apos;t played yet this session
            </p>
            <p className="text-xs text-muted-foreground">
              Complete a match to appear on the leaderboard
            </p>
          </div>
          <span className="text-[10px] font-bold uppercase tracking-widest
                           text-amber-500 shrink-0">
            ★ YOU
          </span>
        </div>
      </div>
    );
  }

  // ── Below threshold state ───────────────────────────────────
  if (row.games_played < minGP) {
    const gamesNeeded = minGP - row.games_played;
    return (
      <div
        className={baseCard}
        aria-label={`Your current status: play ${gamesNeeded} more game${gamesNeeded !== 1 ? "s" : ""} to qualify`}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full
                          bg-amber-100 dark:bg-amber-900/40">
            <Trophy className="h-4 w-4 text-amber-500 dark:text-amber-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              Play {gamesNeeded} more game{gamesNeeded !== 1 ? "s" : ""} to appear on the board
            </p>
            <p className="text-xs text-muted-foreground">
              {row.games_played} GP · {row.wins}W–{row.losses}L so far
            </p>
          </div>
          <span className="text-[10px] font-bold uppercase tracking-widest
                           text-amber-500 shrink-0">
            ★ YOU
          </span>
        </div>
      </div>
    );
  }

  // ── Qualified state — full stats ────────────────────────────
  const streak = streakDisplay(row.win_streak);

  return (
    <div
      className={baseCard}
      aria-label={`Your current rank: #${row.rank} of ${totalPlayers} players`}
    >
      <div className="flex items-center gap-3">
        {/* Rank number — visually large */}
        <div className="shrink-0 text-3xl font-black tabular-nums leading-none
                        text-amber-700 dark:text-amber-400 min-w-[2.5rem] text-center">
          #{row.rank}
        </div>

        {/* Name + streak */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <span className="text-sm font-bold text-foreground truncate">
              {row.display_name}
            </span>
            {row.vip_tag && row.vip_theme && (
              <VipTag tag={row.vip_tag} theme={row.vip_theme} />
            )}
            {streak && (
              <span
                className="text-xs font-medium text-orange-500 dark:text-orange-400 shrink-0"
                aria-label={`Win streak: ${row.win_streak}`}
              >
                {streak}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
            <span className="tabular-nums">{row.games_played} GP</span>
            <span className="text-border">·</span>
            <span className="tabular-nums font-semibold">
              <span className="text-emerald-600 dark:text-emerald-400">{row.wins}W</span>
              –
              <span className="text-red-500 dark:text-red-400">{row.losses}L</span>
            </span>
            <span className="text-border">·</span>
            <span className="tabular-nums font-bold text-foreground">
              {row.win_pct.toFixed(1)}%
            </span>
          </div>
        </div>

        {/* "of N" count + YOU label */}
        <div className="shrink-0 text-right">
          <span className="text-[10px] font-bold uppercase tracking-widest
                           text-amber-500 block">
            ★ YOU
          </span>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            of {totalPlayers}
          </span>
        </div>
      </div>
    </div>
  );
}
