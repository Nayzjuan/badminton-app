"use client";

// ============================================================
// Queue & Match Control Center
// ============================================================
// Live-updating queue list with checkbox selection for manual
// match creation. Organizer selects exactly 4 players, picks
// a court, and creates a custom match.
// ============================================================

import { useMemo, useState } from "react";
import { PLAYERS_PER_MATCH } from "@/lib/constants";
import { SKILL_LEVELS } from "@/types/database";
import type { Court, QueueWithWaitTime } from "@/types/database";

// Re-export constant for clarity in this file.
const REQUIRED_PLAYERS = PLAYERS_PER_MATCH; // 4

interface QueueControlProps {
  queue: QueueWithWaitTime[];
  courts: Court[];
  onCreateManualMatch: (
    courtId: string,
    teamA: string[],
    teamB: string[]
  ) => Promise<{ error?: string }>;
  onRemoveFromQueue: (playerId: string) => Promise<{ error?: string }>;
}

export function QueueControl({
  queue,
  courts,
  onCreateManualMatch,
  onRemoveFromQueue,
}: QueueControlProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedCourt, setSelectedCourt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableCourts = useMemo(
    () => courts.filter((c) => c.status === "available"),
    [courts]
  );

  function togglePlayer(playerId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else {
        if (next.size >= REQUIRED_PLAYERS) return prev; // cap at 4
        next.add(playerId);
      }
      return next;
    });
  }

  function getSkillLabel(value: string): string {
    return SKILL_LEVELS.find((s) => s.value === value)?.label ?? value;
  }

  async function handleCreateMatch() {
    if (selected.size !== REQUIRED_PLAYERS) return;
    if (!selectedCourt) {
      setError("Please select a court.");
      return;
    }

    setCreating(true);
    setError(null);

    // Split into teams: first 2 selected = Team A, last 2 = Team B.
    const playerIds = Array.from(selected);
    const teamA = playerIds.slice(0, 2);
    const teamB = playerIds.slice(2, 4);

    const result = await onCreateManualMatch(selectedCourt, teamA, teamB);
    if (result.error) {
      setError(result.error);
    } else {
      setSelected(new Set());
      setSelectedCourt("");
    }
    setCreating(false);
  }

  return (
    <div className="space-y-5">
      {/* Manual Match Bar */}
      <div
        className={`rounded-xl border-2 p-4 transition-colors ${
          selected.size === REQUIRED_PLAYERS
            ? "border-emerald-400 bg-emerald-50"
            : selected.size > 0
            ? "border-amber-300 bg-amber-50"
            : "border-border bg-card"
        }`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {selected.size === 0
                ? "Select 4 players to create a manual match"
                : `${selected.size} of ${REQUIRED_PLAYERS} players selected`}
            </p>
            {selected.size > 0 && selected.size < REQUIRED_PLAYERS && (
              <p className="text-xs text-muted-foreground">
                Select {REQUIRED_PLAYERS - selected.size} more
              </p>
            )}
          </div>

          {selected.size === REQUIRED_PLAYERS && (
            <>
              <select
                value={selectedCourt}
                onChange={(e) => setSelectedCourt(e.target.value)}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm
                           focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Select court...</option>
                {availableCourts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              <button
                onClick={handleCreateMatch}
                disabled={creating || !selectedCourt}
                className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white
                           hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed
                           whitespace-nowrap transition-colors"
              >
                {creating ? "Creating..." : "Create Manual Match"}
              </button>
            </>
          )}

          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Clear
            </button>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive mt-2">{error}</p>
        )}
      </div>

      {/* Queue Table */}
      {queue.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <p className="text-muted-foreground">Queue is empty. Waiting for players to join.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="px-4 py-3 text-left w-12"></th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">#</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Player</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Skill</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Wait</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Games</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground w-16"></th>
              </tr>
            </thead>
            <tbody>
              {queue.map((entry, index) => {
                const isSelected = selected.has(entry.player_id);
                const isFull = selected.size >= REQUIRED_PLAYERS;
                const waitMin = Math.floor(entry.wait_minutes);

                return (
                  <tr
                    key={entry.id}
                    className={`border-b border-border last:border-b-0 transition-colors cursor-pointer
                                ${isSelected ? "bg-emerald-50" : "hover:bg-muted/30"}
                                ${entry.is_bottleneck ? "!bg-red-50" : ""}`}
                    onClick={() => togglePlayer(entry.player_id)}
                  >
                    {/* Checkbox */}
                    <td className="px-4 py-3">
                      <div
                        className={`h-5 w-5 rounded border-2 flex items-center justify-center transition-colors
                                    ${
                                      isSelected
                                        ? "bg-emerald-600 border-emerald-600"
                                        : isFull
                                        ? "border-muted bg-muted/50 cursor-not-allowed"
                                        : "border-border hover:border-primary"
                                    }`}
                      >
                        {isSelected && (
                          <svg
                            className="h-3 w-3 text-white"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={3}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                    </td>
                    {/* Position */}
                    <td className="px-4 py-3 text-muted-foreground">{index + 1}</td>
                    {/* Name */}
                    <td className="px-4 py-3 font-medium">{entry.display_name}</td>
                    {/* Skill */}
                    <td className="px-4 py-3">
                      <span className="inline-block rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
                        {getSkillLabel(entry.skill_level)}
                      </span>
                    </td>
                    {/* Wait time */}
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span className={entry.is_bottleneck ? "text-red-600 font-bold" : ""}>
                        {waitMin}m
                      </span>
                    </td>
                    {/* Games */}
                    <td className="px-4 py-3 text-right tabular-nums">{entry.games_played}</td>
                    {/* Remove */}
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveFromQueue(entry.player_id);
                        }}
                        className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                        title="Remove from queue"
                      >
                        &times;
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
