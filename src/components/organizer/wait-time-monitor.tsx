"use client";

// ============================================================
// Wait Time Monitor — The Bottleneck View
// ============================================================
// Sorted by longest wait time first.
// Visually highlights players exceeding the 20-min threshold.
// ============================================================

import { useMemo } from "react";
import { BOTTLENECK_THRESHOLD_MINUTES } from "@/lib/constants";
import { SKILL_LEVELS } from "@/types/database";
import type { QueueWithWaitTime } from "@/types/database";

interface WaitTimeMonitorProps {
  queue: QueueWithWaitTime[];
  onRemoveFromQueue: (playerId: string) => Promise<{ error?: string }>;
}

export function WaitTimeMonitor({ queue, onRemoveFromQueue }: WaitTimeMonitorProps) {
  // Sort by wait time descending (longest first).
  const sorted = useMemo(
    () => [...queue].sort((a, b) => b.wait_minutes - a.wait_minutes),
    [queue]
  );

  const bottleneckCount = sorted.filter((q) => q.is_bottleneck).length;

  function getSkillLabel(value: string): string {
    return SKILL_LEVELS.find((s) => s.value === value)?.label ?? value;
  }

  return (
    <div className="space-y-5">
      {/* Summary Bar */}
      <div
        className={`rounded-xl border-2 p-4 flex items-center justify-between ${
          bottleneckCount > 0
            ? "border-red-400 bg-red-50 dark:bg-red-950/30 dark:border-red-500/60"
            : "border-border bg-card"
        }`}
      >
        <div>
          <p className="text-sm font-medium">
            {bottleneckCount > 0
              ? `${bottleneckCount} player${bottleneckCount !== 1 ? "s" : ""} waiting over ${BOTTLENECK_THRESHOLD_MINUTES} minutes`
              : "No bottlenecks — all players within threshold"}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {sorted.length} player{sorted.length !== 1 ? "s" : ""} in queue
          </p>
        </div>
        {bottleneckCount > 0 && (
          <span className="relative flex h-3.5 w-3.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-red-500" />
          </span>
        )}
      </div>

      {/* Player List */}
      {sorted.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <p className="text-muted-foreground">Queue is empty.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((entry) => {
            const waitMin = Math.floor(entry.wait_minutes);
            const pct = Math.min(entry.wait_minutes / (BOTTLENECK_THRESHOLD_MINUTES * 1.5), 1);

            return (
              <div
                key={entry.id}
                className={`rounded-xl border p-4 transition-colors ${
                  entry.is_bottleneck
                    ? "border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-950/20"
                    : entry.wait_minutes > BOTTLENECK_THRESHOLD_MINUTES * 0.75
                    ? "border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/20"
                    : "border-border bg-card"
                }`}
              >
                <div className="flex items-center gap-4">
                  {/* Player Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold truncate">{entry.display_name}</p>
                      <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium shrink-0">
                        {getSkillLabel(entry.skill_level)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {entry.games_played} game{entry.games_played !== 1 ? "s" : ""} played
                    </p>
                  </div>

                  {/* Wait Time */}
                  <div className="text-right shrink-0">
                    <p
                      className={`text-2xl font-bold tabular-nums ${
                        entry.is_bottleneck ? "text-red-600 dark:text-red-400" : "text-foreground"
                      }`}
                    >
                      {waitMin}m
                    </p>
                    {entry.is_bottleneck && (
                      <p className="text-xs text-red-600 dark:text-red-400 font-medium">NEEDS ATTENTION</p>
                    )}
                  </div>

                  {/* Remove */}
                  <button
                    onClick={() => onRemoveFromQueue(entry.player_id)}
                    className="flex items-center justify-center text-sm text-muted-foreground
                               hover:text-destructive transition-colors
                               px-3 py-2 min-h-[44px] min-w-[44px] rounded-lg hover:bg-muted"
                    title="Remove from queue"
                    aria-label={`Remove ${entry.display_name} from queue`}
                  >
                    &times;
                  </button>
                </div>

                {/* Wait Time Bar */}
                <div className="mt-3 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      entry.is_bottleneck
                        ? "bg-red-500"
                        : entry.wait_minutes > BOTTLENECK_THRESHOLD_MINUTES * 0.75
                        ? "bg-amber-500"
                        : "bg-emerald-500"
                    }`}
                    style={{ width: `${pct * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
