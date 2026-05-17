"use client";

// ============================================================
// WrappedShell — client shell for the Wrapped page
// ============================================================
// Orchestrates:
//   1. WrappedIntro full-screen overlay (auto-shows, dismissable)
//   2. Award feed beneath (revealed once intro is dismissed)
//
// Server passes all data as props so this component has zero
// data-fetching logic — just presentation.
// ============================================================

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Share2 } from "lucide-react";
import { WrappedIntro } from "@/components/wrapped/wrapped-intro";
import { topAwardsByRarity } from "@/lib/wrapped-awards";
import { dismissWrappedIntro } from "@/app/actions/wrapped";
import { WrappedStatsCard } from "./wrapped-stats-card";
import { WrappedAwardsFeed } from "./wrapped-awards-feed";
import { WrappedMatchRecap } from "./wrapped-match-recap";
import type { MatchHistory as MatchHistoryRow } from "@/types/database";

// ── Types ──────────────────────────────────────────────────────

export type WrappedStats = {
  playerName: string;
  games: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  winPct: number;
  sessionRank: number | null;
  earnedAwards: string[];
  awardData: Record<string, Record<string, unknown>>;
};

interface WrappedShellProps {
  stats: WrappedStats;
  sessionId: string;
  playerId: string;
  matchHistory: MatchHistoryRow[];
  /** True when intro_dismissed_at is already set in DB — skip the overlay immediately. */
  introDismissed: boolean;
}

// ── Component ──────────────────────────────────────────────────

export function WrappedShell({
  stats,
  sessionId,
  playerId,
  matchHistory,
  introDismissed,
}: WrappedShellProps) {
  // If the player already dismissed the intro (DB flag set), skip it immediately.
  // This prevents the overlay from reappearing on every page load / device.
  const [introVisible, setIntroVisible] = useState(!introDismissed);
  // Guard against double-click: set true before the async action, reset on error.
  const [isDismissing, setIsDismissing] = useState(false);
  const router = useRouter();

  // Top 6 by rarity — keeps the feed scannable on phone screens and
  // guarantees the most prestigious tier (legendary/rare) appears first
  // when a player earns many awards.
  const sorted = topAwardsByRarity(stats.earnedAwards, 6);

  /**
   * Persist the dismiss to the DB then navigate to the lobby.
   * Called only when the player explicitly clicks "Done" or "Back to Lobby" —
   * not when they tap "See Your Awards →" (which just closes the overlay
   * to reveal the awards without marking the session as fully seen).
   *
   * Guarded against double-click via `isDismissing`.  If the server action
   * fails, we stay on the page so the player can retry rather than silently
   * navigating away with an un-persisted dismiss.
   */
  const handleDone = useCallback(async () => {
    if (isDismissing) return;
    setIsDismissing(true);
    const result = await dismissWrappedIntro(sessionId, playerId);
    if (!result.success) {
      console.error("[WrappedShell] dismissWrappedIntro failed:", result.error);
      setIsDismissing(false); // let player retry
      return;
    }
    router.push("/play");
  }, [isDismissing, sessionId, playerId, router]);

  return (
    <>
      {/* ── Intro overlay (sits on top of everything) ─────── */}
      {introVisible && (
        <WrappedIntro
          playerName={stats.playerName}
          games={stats.games}
          wins={stats.wins}
          onDismiss={() => setIntroVisible(false)}
        />
      )}

      {/* ── Award feed ────────────────────────────────────── */}
      {!introVisible && (
        <main
          className="min-h-screen"
          style={{
            background: "#060D1B",
            paddingBottom: "env(safe-area-inset-bottom, 24px)",
          }}
        >
          {/* Header */}
          <div
            style={{
              background: "rgba(6,13,27,0.95)",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              padding: "1rem 1.25rem 0.75rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              position: "sticky",
              top: 0,
              zIndex: 10,
            }}
          >
            <div>
              <p
                style={{
                  fontSize: "10px",
                  fontWeight: "900",
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  color: "rgba(245,158,11,0.7)",
                  margin: 0,
                }}
              >
                Session Wrapped
              </p>
              <p
                style={{
                  fontSize: "1.25rem",
                  fontWeight: "800",
                  color: "#FFFFFF",
                  margin: 0,
                  lineHeight: 1.2,
                }}
              >
                {stats.playerName}&rsquo;s Night
              </p>
            </div>

            <button
              onClick={handleDone}
              style={{
                fontSize: "11px",
                fontWeight: "700",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.5)",
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: "999px",
                padding: "6px 14px",
                cursor: "pointer",
              }}
            >
              Done
            </button>
          </div>

          {/* ── Stats summary card ──────────────────────── */}
          <WrappedStatsCard stats={stats} />

          {/* ── Awards section ──────────────────────────── */}
          <WrappedAwardsFeed stats={stats} sorted={sorted} />

          {/* ── Match Recap ───────────────────────────── */}
          <WrappedMatchRecap matchHistory={matchHistory} />

          {/* ── Footer: share + done ──────────────────── */}
          <div
            style={{
              padding: "1rem 1.25rem",
              display: "flex",
              gap: "0.75rem",
              animation: "wi-up 400ms cubic-bezier(0.22,1,0.36,1) 300ms both",
            }}
          >
            <button
              onClick={() => {
                // Share API — copy URL to clipboard as fallback
                const url = window.location.href;
                if (navigator.share) {
                  navigator
                    .share({
                      title: `${stats.playerName}'s Session Wrapped`,
                      text: `I played ${stats.games} games and won ${stats.wins} tonight 🏸`,
                      url,
                    })
                    .catch(() => {});
                } else {
                  navigator.clipboard.writeText(url).catch(() => {});
                }
              }}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.5rem",
                padding: "0.875rem",
                borderRadius: "0.875rem",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.05)",
                color: "rgba(255,255,255,0.7)",
                fontSize: "0.875rem",
                fontWeight: "700",
                cursor: "pointer",
              }}
            >
              <Share2 size={16} />
              Share
            </button>

            <button
              onClick={handleDone}
              style={{
                flex: 2,
                padding: "0.875rem",
                borderRadius: "0.875rem",
                background: "#F59E0B",
                color: "#060D1B",
                fontSize: "0.875rem",
                fontWeight: "900",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                border: "none",
                cursor: "pointer",
              }}
            >
              Back to Lobby
            </button>
          </div>
        </main>
      )}
    </>
  );
}
