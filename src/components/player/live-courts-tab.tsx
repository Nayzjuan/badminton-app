"use client";

// ============================================================
// LiveCourtsTab — Read-only view of all active matches
// ============================================================
// Shows in-progress matches (dark navy treatment) then on-deck
// matches (light treatment) using the shared TeamsGrid roster
// layout — matches the organizer dashboard card design exactly.
// ============================================================

import { Swords } from "lucide-react";
import { TeamsGrid, type RosterPlayer } from "@/components/organizer/match-roster";
import type { SessionMatch } from "@/hooks/use-session-data";

interface LiveCourtsTabProps {
  inProgressMatches: SessionMatch[];
  onDeckMatches: SessionMatch[];
  loading: boolean;
  /** Logged-in player's ID — used to bold-highlight "you" in court rosters. */
  myPlayerId?: string;
}

export function LiveCourtsTab({
  inProgressMatches,
  onDeckMatches,
  loading,
  myPlayerId,
}: LiveCourtsTabProps) {
  if (loading) {
    // Two card-shaped skeletons matching CourtMatchCard's header + roster grid.
    // `loading` flips true→false once per mount, so this shows only on first load.
    return (
      <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading courts">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="rounded-2xl overflow-hidden border border-border bg-card shadow-sm"
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
              <div className="h-3 w-24 rounded-full bg-muted animate-pulse" />
              <div className="h-4 w-20 rounded-full bg-muted animate-pulse" />
            </div>
            <div className="grid grid-cols-2 gap-4 p-4">
              <div className="h-16 rounded-xl bg-muted animate-pulse" />
              <div className="h-16 rounded-xl bg-muted animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const hasNothing = inProgressMatches.length === 0 && onDeckMatches.length === 0;

  if (hasNothing) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-12 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Swords className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">No active matches</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Matches will appear here once the organizer starts them.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── In Progress ─────────────────────────────────────── */}
      {inProgressMatches.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Now Playing
            </h2>
            <span className="rounded-full bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-400">
              {inProgressMatches.length}
            </span>
          </div>

          <div className="space-y-4">
            {inProgressMatches.map((match) => (
              <CourtMatchCard
                key={match.id}
                match={match}
                variant="in_progress"
                myPlayerId={myPlayerId}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── On Deck ─────────────────────────────────────────── */}
      {onDeckMatches.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              On Deck
            </h2>
            <span className="rounded-full bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-400">
              {onDeckMatches.length}
            </span>
          </div>

          <div className="space-y-4">
            {onDeckMatches.map((match) => (
              <CourtMatchCard
                key={match.id}
                match={match}
                variant="on_deck"
                myPlayerId={myPlayerId}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CourtMatchCard — Header bar + TeamsGrid roster
// ─────────────────────────────────────────────────────────────

function CourtMatchCard({
  match,
  variant,
  myPlayerId,
}: {
  match: SessionMatch;
  variant: "in_progress" | "on_deck";
  myPlayerId?: string;
}) {
  const isOnDeck = variant === "on_deck";

  const teamA: RosterPlayer[] = match.players
    .filter((p) => p.team === "a")
    .map((p) => ({
      player_id: p.player_id,
      display_name: p.profile.display_name,
      skill_level: p.profile.skill_level,
      vip_tag: p.profile.vip_tag,
      vip_theme: p.profile.vip_theme,
    }));

  const teamB: RosterPlayer[] = match.players
    .filter((p) => p.team === "b")
    .map((p) => ({
      player_id: p.player_id,
      display_name: p.profile.display_name,
      skill_level: p.profile.skill_level,
      vip_tag: p.profile.vip_tag,
      vip_theme: p.profile.vip_theme,
    }));

  return (
    <div
      className={
        // Enter animation plays only on true DOM insertion (first load, a
        // genuinely new card, or a tab-switch remount) — stable `match.id`
        // keys mean realtime refetches move/patch nodes without replaying it.
        isOnDeck
          ? "rounded-2xl overflow-hidden shadow-sm border border-amber-100 dark:border-amber-500/20 bg-card animate-in fade-in slide-in-from-bottom-2 duration-300"
          : // bg-card: oklch(1 0 0) light / oklch(0.11 0.016 238) dark — matches original
            // dark value (0.11 ≈ old hardcoded 0.10) while being white in light mode.
            // borderColor: transparent (in style) lets the emerald ring-shadow be the
            // sole border, avoiding a double-border with Tailwind's `border` class.
            "rounded-2xl overflow-hidden shadow-sm border bg-card animate-in fade-in slide-in-from-bottom-2 duration-300"
      }
      style={
        isOnDeck
          ? undefined
          : {
              // Emerald glow ring traces the card edge in both modes.
              // 0.20 opacity is visible on dark card (0.11L) and subtly tints white card.
              boxShadow:
                "0 0 0 1px oklch(0.76 0.17 155 / 0.20), 0 0 16px oklch(0.76 0.17 155 / 0.07)",
              borderColor: "transparent",
            }
      }
    >
      {/* Header bar */}
      <div
        className={`flex items-center justify-between px-4 py-2.5 ${
          isOnDeck
            ? "bg-amber-50 dark:bg-amber-500/10 border-b border-amber-100 dark:border-amber-500/20"
            : "border-b border-cc-border"
        }`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`text-[11px] font-bold uppercase tracking-[0.08em] ${
              isOnDeck ? "text-amber-900 dark:text-amber-300" : "text-cc-t3"
            }`}
          >
            {isOnDeck ? "On Deck" : (match.court?.name ?? "Court")}
          </span>
          {match.is_mixed_level && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${
                isOnDeck
                  ? "bg-amber-100 dark:bg-amber-500/15 border-amber-300 dark:border-amber-500/30 text-amber-800 dark:text-amber-300"
                  : "bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300"
              }`}
            >
              Mixed Level
            </span>
          )}
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em] ${
            isOnDeck
              ? "bg-amber-200/60 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300"
              : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          }`}
        >
          {isOnDeck ? "Waiting for court" : "In Progress"}
        </span>
      </div>

      {/* Roster grid */}
      <TeamsGrid
        dark={false}
        teamA={teamA}
        teamB={teamB}
        labelA="Team A"
        labelB="Team B"
        myPlayerId={myPlayerId}
      />
    </div>
  );
}
