"use client";

// ============================================================
// Queue Status Board — Position, wait time, games played
// ============================================================

interface QueueStatusProps {
  position: number | null;
  waitMinutes: number;
  gamesPlayed: number;
  totalInQueue: number;
}

export function QueueStatus({
  position,
  waitMinutes,
  gamesPlayed,
  totalInQueue,
}: QueueStatusProps) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {/* Position */}
      <div className="rounded-xl bg-card border border-border p-4 text-center">
        <p className="text-3xl font-bold text-foreground">
          {position !== null ? `#${position}` : "—"}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          of {totalInQueue} in line
        </p>
      </div>

      {/* Wait Time */}
      <div className="rounded-xl bg-card border border-border p-4 text-center">
        <p className="text-3xl font-bold text-foreground">
          {waitMinutes}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          min waiting
        </p>
      </div>

      {/* Games Played */}
      <div className="rounded-xl bg-card border border-border p-4 text-center">
        <p className="text-3xl font-bold text-foreground">
          {gamesPlayed}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          games played
        </p>
      </div>
    </div>
  );
}
