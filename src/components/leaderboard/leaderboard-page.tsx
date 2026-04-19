"use client";

// ============================================================
// LeaderboardPage — Placeholder (full implementation pending)
// ============================================================
// This stub satisfies the import in player-dashboard.tsx while
// the full leaderboard feature is being built.
//
// Props:
//   sessionId      — the session to scope stats to
//   currentUserId  — highlight this player's own row
//   variant        — "player-panel" (inline) | "full-page"
// ============================================================

import { Trophy } from "lucide-react";

interface LeaderboardPageProps {
  sessionId: string;
  currentUserId: string;
  variant?: "player-panel" | "full-page";
}

export function LeaderboardPage({
  sessionId: _sessionId,
  currentUserId: _currentUserId,
  variant = "player-panel",
}: LeaderboardPageProps) {
  return (
    <div
      className={
        variant === "player-panel"
          ? "flex flex-col items-center justify-center gap-4 py-16 px-6 text-center"
          : "min-h-screen flex flex-col items-center justify-center gap-4 py-16 px-6 text-center"
      }
    >
      <div className="rounded-full bg-amber-100 dark:bg-amber-900/30 p-4">
        <Trophy className="h-8 w-8 text-amber-600 dark:text-amber-400" />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          Leaderboard Coming Soon
        </h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-xs">
          Rankings, streaks, and win stats are on the way. Check back after your
          next match!
        </p>
      </div>
    </div>
  );
}
