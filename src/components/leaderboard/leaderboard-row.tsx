"use client";

// ============================================================
// LeaderboardRow — Single table row (flex layout, not <table>)
// ============================================================
// Layout follows the Column Width spec from LEADERBOARD_UI_SPEC.md:
//   Rank w-7 | Player flex-1 | GP w-8 | W-L w-14 | Win% w-16
//   | [Rank Δ w-11] | [PF w-10 | PA w-10 | +/- w-10]
//
// Rank medals for top 3 — no CSS styling on emoji (renders natively).
// Streak renders inline: nothing <3, "🔥🔥🔥" at 3, "🔥×N" at 4+.
// Rank Δ: ↑N emerald, ↓N red, — muted, NEW amber.
// +/- : positive emerald, negative red, zero muted.
// data-flash triggers the global flash animation from globals.css.
// ============================================================

import { VipTag } from "@/components/ui/vip-tag";
import type { LeaderboardRow as LeaderboardRowType } from "@/types/leaderboard";

const MEDALS: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

function streakLabel(streak: number): string | null {
  if (streak < 3) return null;
  if (streak === 3) return "🔥🔥🔥";
  return `🔥×${streak}`;
}

function rankMovementDisplay(movement: number | null): {
  label: string;
  className: string;
} {
  if (movement === null) {
    return {
      label: "NEW",
      className:
        "text-[10px] font-bold uppercase tracking-wider text-amber-500",
    };
  }
  if (movement > 0) {
    return {
      label: `↑${movement}`,
      className:
        "text-xs font-bold tabular-nums text-emerald-600 dark:text-emerald-400",
    };
  }
  if (movement < 0) {
    return {
      label: `↓${Math.abs(movement)}`,
      className:
        "text-xs font-bold tabular-nums text-red-500 dark:text-red-400",
    };
  }
  return {
    label: "—",
    className: "text-xs text-muted-foreground",
  };
}

function pointDiffDisplay(diff: number): { label: string; className: string } {
  if (diff > 0) {
    return {
      label: `+${diff}`,
      className:
        "text-emerald-600 dark:text-emerald-400 font-semibold tabular-nums",
    };
  }
  if (diff < 0) {
    return {
      label: `${diff}`,
      className: "text-red-500 dark:text-red-400 font-semibold tabular-nums",
    };
  }
  return { label: "0", className: "text-muted-foreground tabular-nums" };
}

interface LeaderboardRowProps {
  row: LeaderboardRowType;
  isCurrentUser: boolean;
  flash: boolean;
  showAdvanced: boolean;
  showRankMovement: boolean;
}

export function LeaderboardRow({
  row,
  isCurrentUser,
  flash,
  showAdvanced,
  showRankMovement,
}: LeaderboardRowProps) {
  const medal = MEDALS[row.rank];
  const streak = streakLabel(row.win_streak);
  const movement = showRankMovement
    ? rankMovementDisplay(row.rank_movement ?? null)
    : null;
  const pointDiff = showAdvanced ? pointDiffDisplay(row.point_diff) : null;

  return (
    <div
      data-flash={flash ? "true" : undefined}
      className={[
        "flex items-center min-h-[44px] px-3",
        "border-b border-slate-100 dark:border-border last:border-b-0",
        "transition-colors duration-150",
        "hover:bg-slate-50/80 dark:hover:bg-muted/30",
        isCurrentUser
          ? "bg-amber-50/60 dark:bg-amber-950/20"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Rank */}
      <div className="w-7 shrink-0 text-center">
        {medal ? (
          <span className="text-base leading-none">{medal}</span>
        ) : (
          <span className="text-sm font-bold tabular-nums text-muted-foreground">
            {row.rank}
          </span>
        )}
      </div>

      {/* Player name + VIP tag + streak */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 pl-2">
        <span className="text-sm font-semibold text-foreground truncate">
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

      {/* GP */}
      <div className="w-8 shrink-0 text-right">
        <span className="text-xs tabular-nums text-muted-foreground">
          {row.games_played}
        </span>
      </div>

      {/* W–L */}
      <div className="w-14 shrink-0 text-right">
        <span className="text-sm tabular-nums font-semibold">
          <span className="text-emerald-600 dark:text-emerald-400">
            {row.wins}W
          </span>
          <span className="text-muted-foreground">–</span>
          <span className="text-red-500 dark:text-red-400">{row.losses}L</span>
        </span>
      </div>

      {/* Win% */}
      <div className="w-16 shrink-0 text-right">
        <span className="text-sm tabular-nums font-semibold text-muted-foreground">
          {row.win_pct.toFixed(1)}%
        </span>
      </div>

      {/* Rank movement (all-time tab only) */}
      {showRankMovement && movement && (
        <div className="w-11 shrink-0 text-right">
          <span className={movement.className}>{movement.label}</span>
        </div>
      )}

      {/* Advanced stats — PF / PA / +/- */}
      {showAdvanced && (
        <>
          <div className="w-10 shrink-0 text-right">
            <span className="text-xs tabular-nums text-muted-foreground">
              {row.points_for}
            </span>
          </div>
          <div className="w-10 shrink-0 text-right">
            <span className="text-xs tabular-nums text-muted-foreground">
              {row.points_against}
            </span>
          </div>
          <div className="w-10 shrink-0 text-right">
            <span className={`text-xs ${pointDiff!.className}`}>
              {pointDiff!.label}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
