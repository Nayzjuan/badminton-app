"use client";

// ============================================================
// Queue Status — Position-first hierarchy
// ============================================================
// Queue Position is the dominant signal — rendered large so
// players can read it at a glance across the room.
// Wait time is inline context beneath the position number.
// Games played is a quiet tertiary stat that doesn't compete.
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
  const ordinal =
    position === null
      ? null
      : position === 1
      ? "1st"
      : position === 2
      ? "2nd"
      : position === 3
      ? "3rd"
      : `${position}th`;

  return (
    <div className="rounded-xl bg-card border border-border px-5 py-4">
      {/* ── Primary: Queue Position ───────────────────────── */}
      <div className="flex items-baseline gap-3">
        <span className="text-5xl font-extrabold tabular-nums leading-none text-foreground">
          {position !== null ? `#${position}` : "—"}
        </span>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-foreground leading-tight">
            {ordinal !== null ? `${ordinal} in line` : "Not in queue"}
          </span>
          {/* ── Secondary: Wait time ──────────────────────── */}
          <span className="text-xs text-muted-foreground mt-0.5">
            {position !== null
              ? `of ${totalInQueue} · ~${waitMinutes} min wait`
              : `${totalInQueue} player${totalInQueue !== 1 ? "s" : ""} ahead`}
          </span>
        </div>
      </div>

      {/* ── Tertiary: Games played ────────────────────────── */}
      <p className="mt-3 pt-3 border-t border-border text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{gamesPlayed}</span>
        {" "}game{gamesPlayed !== 1 ? "s" : ""} played this session
      </p>
    </div>
  );
}
