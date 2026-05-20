"use client";

// ============================================================
// Wait Time Monitor — The Bottleneck View
// ============================================================
// Sorted by longest wait time first.
// Visually highlights players exceeding the 20-min threshold.
// ============================================================

import { useMemo, useState } from "react";
import { BOTTLENECK_THRESHOLD_MINUTES } from "@/lib/constants";
import { SKILL_LEVELS } from "@/types/database";
import type { QueueWithWaitTime } from "@/types/database";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface WaitTimeMonitorProps {
  queue: QueueWithWaitTime[];
  onRemoveFromQueue: (playerId: string) => Promise<{ error?: string }>;
}

export function WaitTimeMonitor({ queue, onRemoveFromQueue }: WaitTimeMonitorProps) {
  // Track which player is currently being removed so the button is
  // disabled during the async call — prevents double-tap on a destructive action.
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Include on_deck players so the organizer can see their accumulated wait time
  // even after they've been assigned to a match. Drafted players are excluded —
  // they're in an unpublished draft and haven't been formally committed yet.
  const sorted = useMemo(
    () =>
      queue
        .filter((q) => q.status === "waiting" || q.status === "on_deck")
        .sort((a, b) => b.wait_minutes - a.wait_minutes),
    [queue]
  );

  // Only waiting players count as bottlenecks — on_deck players are already
  // being served, so they shouldn't trigger the alert indicator.
  const bottleneckCount = sorted.filter((q) => q.is_bottleneck && q.status === "waiting").length;

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
            {sorted.filter((q) => q.status === "waiting").length} waiting
            {sorted.some((q) => q.status === "on_deck") &&
              `, ${sorted.filter((q) => q.status === "on_deck").length} on deck`}
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
            const isOnDeck = entry.status === "on_deck";
            // On-deck players are already assigned — never treat as bottleneck visually.
            const showBottleneck = entry.is_bottleneck && !isOnDeck;

            return (
              <div
                key={entry.id}
                className={`rounded-xl border p-4 transition-colors ${
                  isOnDeck
                    ? "border-teal-300 bg-teal-50 dark:border-teal-500/40 dark:bg-teal-950/20"
                    : showBottleneck
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
                      {isOnDeck && (
                        <span className="inline-block rounded-full bg-teal-100 dark:bg-teal-900/40 px-2 py-0.5 text-xs font-medium text-teal-700 dark:text-teal-300 shrink-0">
                          On Deck
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {entry.games_played} game{entry.games_played !== 1 ? "s" : ""} played
                    </p>
                  </div>

                  {/* Wait Time */}
                  <div className="text-right shrink-0">
                    <p
                      className={`text-2xl font-bold tabular-nums ${
                        showBottleneck
                          ? "text-red-600 dark:text-red-400"
                          : isOnDeck
                            ? "text-teal-600 dark:text-teal-400"
                            : "text-foreground"
                      }`}
                    >
                      {waitMin}m
                    </p>
                    {showBottleneck && (
                      <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                        NEEDS ATTENTION
                      </p>
                    )}
                    {isOnDeck && (
                      <p className="text-xs text-teal-600 dark:text-teal-400 font-medium">
                        ASSIGNED
                      </p>
                    )}
                  </div>

                  {/* Remove button — hidden for on_deck players (already in a match) */}
                  {!isOnDeck && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button
                          disabled={removingId === entry.player_id}
                          className="flex items-center justify-center text-sm text-muted-foreground
                                     hover:text-destructive transition-colors
                                     px-3 py-2 min-h-[44px] min-w-[44px] rounded-lg hover:bg-muted
                                     disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Remove from queue"
                          aria-label={`Remove ${entry.display_name} from queue`}
                        >
                          {removingId === entry.player_id ? "…" : "×"}
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove {entry.display_name}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will remove them from the wait-time queue. They can rejoin the
                            session using their name and PIN.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={async () => {
                              setRemovingId(entry.player_id);
                              try {
                                await onRemoveFromQueue(entry.player_id);
                              } finally {
                                setRemovingId(null);
                              }
                            }}
                            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>

                {/* Wait Time Bar */}
                <div className="mt-3 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isOnDeck
                        ? "bg-teal-500"
                        : showBottleneck
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
