"use client";

// ============================================================
// MatchHistoryPlayerFilter
// ============================================================
// Controlled type-to-filter searchable list for the organizer's
// Match History panel. Pattern lifted from swap-sheet.tsx:
//   - plain <input> + <ul> of <button aria-pressed> rows
//   - inline in normal document flow (NOT a floating popover)
//   - results narrow as the organizer types; Escape clears
// ============================================================

import { useState, useCallback, useId } from "react";
import { Search, X } from "lucide-react";
import { SkillBadge } from "@/components/ui/skill-badge";
import type { PlayerOption } from "@/lib/match-history-filter";

interface MatchHistoryPlayerFilterProps {
  players: PlayerOption[];
  selectedId: string | null;
  onSelect: (option: { id: string; display_name: string } | null) => void;
}

export function MatchHistoryPlayerFilter({
  players,
  selectedId,
  onSelect,
}: MatchHistoryPlayerFilterProps) {
  const [query, setQuery] = useState("");
  const inputId = useId();

  const filtered = query.trim()
    ? players.filter((p) => p.display_name.toLowerCase().includes(query.toLowerCase()))
    : players;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        if (query) {
          setQuery("");
        } else {
          onSelect(null);
        }
      }
    },
    [query, onSelect]
  );

  const handleSelect = useCallback(
    (opt: PlayerOption) => {
      if (selectedId === opt.player_id) {
        onSelect(null);
      } else {
        onSelect({ id: opt.player_id, display_name: opt.display_name });
        setQuery("");
      }
    },
    [selectedId, onSelect]
  );

  return (
    <div className="space-y-2">
      {/* Visually-hidden label for screen readers */}
      <label htmlFor={inputId} className="sr-only">
        Filter match history by player
      </label>

      {/* Search input — mirrors swap-sheet styling */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <input
          id={inputId}
          type="text"
          placeholder="Filter by player…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full rounded-lg border border-border bg-muted/30
                     pl-8 pr-8 py-2 text-sm text-foreground placeholder:text-muted-foreground
                     focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent
                     transition-colors"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Player list — only visible when there's a query OR nothing is selected yet */}
      {(query || !selectedId) && players.length > 0 && (
        <ul className="space-y-1" role="list">
          {filtered.length === 0 ? (
            <li className="px-3 py-4 text-center text-xs text-muted-foreground">
              No players match &ldquo;{query}&rdquo;
            </li>
          ) : (
            filtered.map((opt) => {
              const isSelected = selectedId === opt.player_id;
              return (
                <li key={opt.player_id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(opt)}
                    aria-pressed={isSelected}
                    className={[
                      "w-full flex items-center gap-3 rounded-xl px-3 py-2.5",
                      "border transition-all text-left cursor-pointer",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isSelected
                        ? "bg-cc-accent-dim outline outline-1 outline-cc-accent/55 border-transparent"
                        : "border-cc-border bg-transparent hover:bg-muted/40",
                    ].join(" ")}
                  >
                    {/* Name + skill badge */}
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-semibold text-foreground truncate leading-snug">
                        {opt.display_name}
                        {opt.disambiguator && (
                          <span className="ml-1.5 font-mono text-[10px] text-cc-t3 font-normal">
                            · {opt.disambiguator}
                          </span>
                        )}
                      </p>
                      <SkillBadge level={opt.skill_level} className="mt-0.5" />
                    </div>

                    {/* Game count */}
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                      {opt.count}g
                    </span>

                    {/* Selected checkmark */}
                    {isSelected && (
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center
                                       rounded-full bg-cc-accent ring-1 ring-cc-accent/60"
                      >
                        <svg
                          className="h-3 w-3 text-cc-btn-on-accent"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={3}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
