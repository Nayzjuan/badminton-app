"use client";

// ============================================================
// LeaderboardTable — Container + header + rows + empty state
// ============================================================
// Wraps the ranked rows in a card with a column header, loading
// skeletons, and an empty state message when no qualified
// players exist yet.
//
// Column visibility is controlled by the parent via props so the
// header and rows always stay in sync.
// ============================================================

import { LeaderboardRow } from "./leaderboard-row";
import type { LeaderboardRow as LeaderboardRowType } from "@/types/leaderboard";

interface LeaderboardTableProps {
  rows: LeaderboardRowType[];
  loading: boolean;
  currentUserId: string | null;
  flashedIds: Set<string>;
  showAdvanced: boolean;
  showRankMovement: boolean;
  /** Minimum GP for the active scope (shown in empty state) */
  minGP: number;
}

function SkeletonRow() {
  return (
    <div className="flex items-center min-h-[44px] px-3 border-b border-slate-100 dark:border-border last:border-b-0 gap-2">
      <div className="w-7 shrink-0">
        <div className="h-4 w-5 bg-slate-200 dark:bg-muted rounded animate-pulse mx-auto" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="h-3.5 bg-slate-200 dark:bg-muted rounded animate-pulse w-32" />
      </div>
      <div className="w-8 shrink-0">
        <div className="h-3 bg-slate-200 dark:bg-muted rounded animate-pulse ml-auto w-5" />
      </div>
      <div className="w-14 shrink-0">
        <div className="h-3.5 bg-slate-200 dark:bg-muted rounded animate-pulse ml-auto w-10" />
      </div>
      <div className="w-16 shrink-0">
        <div className="h-3.5 bg-slate-200 dark:bg-muted rounded animate-pulse ml-auto w-12" />
      </div>
    </div>
  );
}

export function LeaderboardTable({
  rows,
  loading,
  currentUserId,
  flashedIds,
  showAdvanced,
  showRankMovement,
  minGP,
}: LeaderboardTableProps) {
  return (
    <div
      id="advanced-stats-columns"
      role="grid"
      aria-label="Leaderboard"
      className="rounded-xl border border-slate-200 dark:border-border
                 bg-white dark:bg-card shadow-sm overflow-hidden"
    >
      {/* Column header — role="row" so screen readers get column context */}
      <div
        role="row"
        className="flex items-center min-h-[36px] px-3
                   bg-muted/60 dark:bg-muted/40
                   border-b border-slate-200 dark:border-border"
      >
        <div className="w-7 shrink-0 text-center" role="columnheader" aria-label="Rank">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground" aria-hidden="true">
            #
          </span>
        </div>
        <div className="flex-1 min-w-0 pl-2" role="columnheader" aria-label="Player">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground" aria-hidden="true">
            Player
          </span>
        </div>
        <div className="w-8 shrink-0 text-right" role="columnheader" aria-label="Games Played">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground" aria-hidden="true">
            GP
          </span>
        </div>
        <div className="w-14 shrink-0 text-right" role="columnheader" aria-label="Wins and Losses">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground" aria-hidden="true">
            W–L
          </span>
        </div>
        <div className="w-16 shrink-0 text-right" role="columnheader" aria-label="Win Rate — ranked by confidence-weighted win rate (more games played earns more weight)">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground" aria-hidden="true">
            Win%
          </span>
        </div>
        {showRankMovement && (
          <div className="w-11 shrink-0 text-right" role="columnheader" aria-label="Rank change this week">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground" aria-hidden="true">
              Δ
            </span>
          </div>
        )}
        {showAdvanced && (
          <>
            <div className="w-10 shrink-0 text-right" role="columnheader" aria-label="Points For">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground" aria-hidden="true">
                PF
              </span>
            </div>
            <div className="w-10 shrink-0 text-right" role="columnheader" aria-label="Points Against">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground" aria-hidden="true">
                PA
              </span>
            </div>
            <div className="w-10 shrink-0 text-right" role="columnheader" aria-label="Point Differential">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground" aria-hidden="true">
                +/−
              </span>
            </div>
          </>
        )}
      </div>

      {/* Loading state */}
      {loading && (
        <>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </>
      )}

      {/* Empty state */}
      {!loading && rows.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
          <p className="text-sm font-medium text-muted-foreground">
            No players qualified yet
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Players need {minGP} or more completed games to appear
          </p>
        </div>
      )}

      {/* Rows */}
      {!loading &&
        rows.map((row) => (
          <LeaderboardRow
            key={row.player_id}
            row={row}
            isCurrentUser={row.player_id === currentUserId}
            flash={flashedIds.has(row.player_id)}
            showAdvanced={showAdvanced}
            showRankMovement={showRankMovement}
          />
        ))}
    </div>
  );
}
