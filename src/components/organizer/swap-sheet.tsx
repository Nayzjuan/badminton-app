"use client";

// ============================================================
// SwapSheet — Tap-to-Swap side drawer for on-deck matches
// ============================================================
// Opened when the organizer taps a player badge in OnDeckPanel.
//
// UI structure:
//   ┌──────────────────────────────────────┐
//   │  Swapping out: [Player Name] [Team A]│  ← header
//   │  ─────────────────────────────────── │
//   │  Replace with...           [Search]  │  ← scrollable list
//   │  [ Player B  Intermediate  #3 queue] │
//   │  [ Player C  Beginner      #5 queue] │
//   │  ─────────────────────────────────── │
//   │  [⏸ Player D  Advanced      PAUSED ] │  disabled
//   │                                      │
//   │  [⚠ Mixed-level warning      [✕]]   │  conditional
//   │  [       Confirm Swap       ]        │  ← footer
//   │  [          Cancel          ]        │
//   └──────────────────────────────────────┘
//
// Safety:
//   - Confirm disabled until a replacement is selected
//   - isConfirming flag on the button prevents double-tap
//   - Inline error display keyed to errorCode from server action
//   - MATCH_STARTED / PLAYER_NOT_IN_MATCH → close sheet
//   - PLAYER_UNAVAILABLE / generic → keep sheet open, show error
// ============================================================

import { useState, useEffect } from "react";
import { AlertTriangle, Pause, Search, Users } from "lucide-react";
import { SkillBadge } from "@/components/ui/skill-badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import type { SwapResult } from "@/app/actions/swap-player";
import type { QueueWithWaitTime, SkillLevel } from "@/types/database";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";
import type { SwapContext } from "./on-deck-panel";

// ── Exported types ────────────────────────────────────────────

export type UndoableSwap = {
  matchId: string;
  outPlayerId: string;
  inPlayerId: string;
  outName: string;
  inName: string;
};

// ── Props ─────────────────────────────────────────────────────

interface SwapSheetProps {
  /** The current swap context. null = sheet is closed. */
  context: SwapContext | null;
  /** Full queue — filtered internally to show only available players. */
  queue: QueueWithWaitTime[];
  /** All active matches (pending + in_progress) — used to exclude on-court players. */
  activeMatches: EnrichedMatch[];
  /** Hook-provided swap function that triggers immediate state refresh. */
  swapPlayer: (matchId: string, outPlayerId: string, inPlayerId: string) => Promise<SwapResult>;
  /** Called when the sheet should close (Cancel, Escape, backdrop). */
  onClose: () => void;
  /** Called after a successful swap with data needed to power the undo toast. */
  onSwapComplete: (swap: UndoableSwap) => void;
}

// ── Team label helper ─────────────────────────────────────────

function teamLabel(team: "a" | "b") {
  return team === "a" ? "Team A" : "Team B";
}

// ── Main component ────────────────────────────────────────────

export function SwapSheet({ context, queue, activeMatches, swapPlayer, onClose, onSwapComplete }: SwapSheetProps) {
  // Internal state — reset via key prop in parent when context changes.
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [mismatchDismissed, setMismatchDismissed] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Reset on context change (parent passes key={matchId+outPlayerId}).
  useEffect(() => {
    setSelectedPlayerId(null);
    setMismatchDismissed(false);
    setIsConfirming(false);
    setInlineError(null);
    setSearch("");
  }, [context?.matchId, context?.outPlayerId]);

  const isOpen = context !== null;

  // ── Build player list ──────────────────────────────────────
  // Players already in this match are excluded.
  // All waiting players shown; paused ones rendered as disabled.

  const currentMatchPlayerIds = new Set(
    context?.currentPlayers.map((p) => p.player_id) ?? []
  );

  // Build a set of ALL player IDs currently assigned to any active match
  // (both pending on-deck and in_progress on-court). This prevents players
  // who are physically on a court from appearing as swap candidates, even
  // if Realtime hasn't yet updated the queue status to "playing".
  const activeMatchPlayerIds = new Set(
    activeMatches.flatMap((m) => m.players.map((p) => p.player_id))
  );

  const allCandidates = queue
    .filter((p) => {
      // Must not already be in this match
      if (currentMatchPlayerIds.has(p.player_id)) return false;
      // Must not be assigned to any other active match (on-court or on-deck)
      if (activeMatchPlayerIds.has(p.player_id)) return false;
      // Must be waiting (on_deck/playing/left excluded — they're not available)
      if (p.status !== "waiting") return false;
      return true;
    })
    .sort((a, b) => {
      // Next-up players first — same sort order as matchmaking
      if (a.games_played !== b.games_played) return a.games_played - b.games_played;
      return new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime();
    });

  // Search filter (applied after sort so order is stable)
  const filteredCandidates = search.trim()
    ? allCandidates.filter((p) =>
        p.display_name.toLowerCase().includes(search.toLowerCase())
      )
    : allCandidates;

  // ── Skill mismatch detection ───────────────────────────────
  // Evaluate when a replacement is selected (not at browse time —
  // reduces noise while the organizer is still looking).

  let showMismatchWarning = false;
  if (context && selectedPlayerId && !mismatchDismissed) {
    const selected = queue.find((p) => p.player_id === selectedPlayerId);
    if (selected) {
      const remainingPlayers = context.currentPlayers.filter(
        (p) => p.player_id !== context.outPlayerId
      );
      const allSkills: SkillLevel[] = [
        ...remainingPlayers.map((p) => p.skill_level),
        selected.skill_level,
      ];
      showMismatchWarning = new Set(allSkills).size > 1;
    }
  }

  // ── Confirm handler ────────────────────────────────────────

  async function handleConfirm() {
    if (!context || !selectedPlayerId || isConfirming) return;

    setIsConfirming(true);
    setInlineError(null);

    const inPlayer = queue.find((p) => p.player_id === selectedPlayerId);
    const inName = inPlayer?.display_name ?? "Unknown";

    const result = await swapPlayer(
      context.matchId,
      context.outPlayerId,
      selectedPlayerId
    );

    if (result.success) {
      onSwapComplete({
        matchId: context.matchId,
        outPlayerId: context.outPlayerId,
        inPlayerId: selectedPlayerId,
        outName: context.outPlayerName,
        inName,
      });
      // onClose is called by parent after onSwapComplete
      onClose();
      return;
    }

    // Failure routing — keep confirming=false so user can retry or close
    setIsConfirming(false);

    if (result.errorCode === "MATCH_STARTED") {
      // Layer 2 useEffect in dashboard will also close this, but handle
      // here as an immediate fallback in case realtime is slow.
      onClose();
      return;
    }

    if (result.errorCode === "PLAYER_NOT_IN_MATCH") {
      // outPlayer was already swapped by a concurrent organizer
      onClose();
      return;
    }

    // PLAYER_UNAVAILABLE or generic network error — keep open
    setInlineError(result.message);
  }

  // ── Render ─────────────────────────────────────────────────

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent showClose>
        {/* ── Header: who is being swapped out ──────────────── */}
        <SheetHeader className="pr-10">
          <SheetTitle>Swap Player</SheetTitle>
          <SheetDescription>
            Replacing from {context ? teamLabel(context.outTeam) : "—"}
          </SheetDescription>

          {context && (
            <div className="mt-3 flex items-center gap-3 rounded-xl
                            bg-amber-50 dark:bg-amber-950/30
                            border border-amber-200 dark:border-amber-800/50
                            px-4 py-3">
              {/* Avatar initial */}
              <div className="flex h-9 w-9 shrink-0 items-center justify-center
                              rounded-full bg-amber-500 dark:bg-amber-600
                              text-sm font-bold text-white select-none">
                {context.outPlayerName.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-slate-900 dark:text-foreground truncate">
                  {context.outPlayerName}
                </p>
                <SkillBadge level={context.outPlayerSkill} className="mt-0.5" />
              </div>
              <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold
                               uppercase tracking-wider
                               bg-amber-100 border border-amber-300 text-amber-800
                               dark:bg-amber-900/40 dark:border-amber-700 dark:text-amber-300">
                {context ? teamLabel(context.outTeam) : ""}
              </span>
            </div>
          )}
        </SheetHeader>

        {/* ── Scrollable player list ─────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">

          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder="Search players…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-border bg-muted/30
                         pl-8 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground
                         focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent
                         transition-colors"
            />
          </div>

          {/* Section label */}
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Replace with
          </p>

          {/* Player rows */}
          {filteredCandidates.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <Users className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">No players available</p>
              <p className="text-xs text-muted-foreground">
                {search ? "No match for that name" : "All waiting players are already in a match"}
              </p>
            </div>
          )}

          {filteredCandidates.map((player, idx) => {
            const isDisabled = player.is_paused || isConfirming;
            const isSelected = selectedPlayerId === player.player_id;

            return (
              <button
                key={player.player_id}
                disabled={isDisabled}
                onClick={() => {
                  if (!player.is_paused) {
                    setSelectedPlayerId(isSelected ? null : player.player_id);
                    setMismatchDismissed(false);
                    setInlineError(null);
                  }
                }}
                aria-pressed={isSelected}
                aria-disabled={player.is_paused}
                className={[
                  "w-full flex items-center gap-3 rounded-xl px-4 py-3",
                  "border transition-all text-left",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  // Selected state
                  isSelected
                    ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-600"
                    : "border-border bg-background hover:bg-muted/40",
                  // Paused state
                  player.is_paused
                    ? "opacity-50 cursor-not-allowed"
                    : "cursor-pointer",
                ].join(" ")}
              >
                {/* Queue position number */}
                <span className="flex h-6 w-6 shrink-0 items-center justify-center
                                 rounded-full bg-slate-100 dark:bg-muted
                                 text-[10px] font-bold text-slate-500 dark:text-muted-foreground">
                  {idx + 1}
                </span>

                {/* Player info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-foreground truncate">
                    {player.display_name}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <SkillBadge level={player.skill_level} />
                    <span className="text-[10px] text-muted-foreground">
                      {player.games_played}GP · {player.wait_minutes}m wait
                    </span>
                  </div>
                </div>

                {/* Paused badge OR selected checkmark */}
                {player.is_paused ? (
                  <span className="flex items-center gap-1 rounded-full px-2 py-0.5
                                   bg-slate-100 dark:bg-muted border border-slate-200 dark:border-border
                                   text-[10px] font-bold uppercase tracking-wider
                                   text-slate-500 dark:text-muted-foreground shrink-0">
                    <Pause className="h-2.5 w-2.5" />
                    Paused
                  </span>
                ) : isSelected ? (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center
                                   rounded-full bg-amber-500 dark:bg-amber-600">
                    <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* ── Footer: mismatch warning + action buttons ─────── */}
        <SheetFooter>
          {/* Skill mismatch warning banner */}
          {showMismatchWarning && (
            <div className="flex items-start gap-3 rounded-xl
                            bg-amber-50 dark:bg-amber-950/30
                            border border-amber-200 dark:border-amber-700/50
                            px-4 py-3 mb-1">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <p className="flex-1 text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                This swap creates a mixed-level match. You can still confirm.
              </p>
              <button
                onClick={() => setMismatchDismissed(true)}
                aria-label="Dismiss mixed-level warning"
                className="shrink-0 rounded p-0.5 text-amber-600 dark:text-amber-400
                           hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* Inline error */}
          {inlineError && (
            <div className="rounded-xl bg-red-50 dark:bg-red-950/30
                            border border-red-200 dark:border-red-800/50
                            px-4 py-3">
              <p className="text-xs text-red-700 dark:text-red-400">{inlineError}</p>
              <button
                onClick={() => setInlineError(null)}
                className="mt-1 text-xs font-semibold text-red-600 dark:text-red-400
                           hover:underline"
              >
                Retry
              </button>
            </div>
          )}

          {/* Confirm Swap */}
          <button
            onClick={handleConfirm}
            disabled={!selectedPlayerId || isConfirming}
            className="w-full rounded-xl px-4 py-3 text-sm font-bold
                       bg-amber-500 hover:bg-amber-600 text-white
                       dark:bg-amber-600 dark:hover:bg-amber-700
                       disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors"
          >
            {isConfirming ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Swapping…
              </span>
            ) : (
              "Confirm Swap"
            )}
          </button>

          {/* Cancel */}
          <button
            onClick={onClose}
            disabled={isConfirming}
            className="w-full rounded-xl px-4 py-3 text-sm font-medium
                       border border-border bg-background text-foreground
                       hover:bg-muted/60
                       disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors"
          >
            Cancel
          </button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
