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
  /** When true, the player has been drafted into a pending match.
   *  Shows a pulsing "selected" indicator instead of a blank position. */
  isDrafted?: boolean;
}

export function QueueStatus({
  position,
  waitMinutes,
  gamesPlayed,
  totalInQueue,
  isDrafted = false,
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
      {/* ── Primary: Queue Position / Drafted indicator ──────── */}
      <div className="flex items-center gap-3">
        {isDrafted ? (
          /* Pulsing ping dot — signals "selected, confirming" without
             showing a position number that's no longer meaningful. */
          <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
            <span className="absolute inline-flex h-7 w-7 animate-ping rounded-full bg-primary opacity-25" />
            <span className="relative inline-flex h-4 w-4 rounded-full bg-primary" />
          </span>
        ) : (
          <span className="text-5xl font-extrabold tabular-nums leading-none text-foreground">
            {position !== null ? `#${position}` : "—"}
          </span>
        )}
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-foreground leading-tight">
            {isDrafted ? "Match forming" : ordinal !== null ? `${ordinal} in line` : "Not in queue"}
          </span>
          {/* ── Secondary: contextual sub-label ──────────────── */}
          <span className="text-xs text-muted-foreground mt-0.5">
            {isDrafted
              ? `selected from ${totalInQueue} queued`
              : position !== null
                ? `of ${totalInQueue} · ~${waitMinutes} min wait`
                : `${totalInQueue} player${totalInQueue !== 1 ? "s" : ""} ahead`}
          </span>
        </div>
      </div>

      {/* ── Tertiary: Games played ────────────────────────── */}
      <p className="mt-3 pt-3 border-t border-border text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{gamesPlayed}</span> game
        {gamesPlayed !== 1 ? "s" : ""} played this session
      </p>
    </div>
  );
}
