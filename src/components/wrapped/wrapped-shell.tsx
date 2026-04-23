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

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Share2 } from "lucide-react";
import { WrappedIntro } from "@/components/wrapped/wrapped-intro";
import { WrappedAwardCard } from "@/components/wrapped/wrapped-award-card";
import { MatchHistory } from "@/components/player/match-history";
import { sortAwardsByRarity } from "@/lib/wrapped-awards";

// ── Types ──────────────────────────────────────────────────────

export type WrappedStats = {
  playerName:   string;
  games:        number;
  wins:         number;
  losses:       number;
  pointsFor:    number;
  pointsAgainst: number;
  pointDiff:    number;
  winPct:       number;
  sessionRank:  number | null;
  earnedAwards: string[];
  awardData:    Record<string, Record<string, unknown>>;
};

interface WrappedShellProps {
  stats:     WrappedStats;
  sessionId: string;
  playerId:  string;
}

// ── Rarity badge colors (for the stat card) ───────────────────

function WinRateBar({ pct }: { pct: number }) {
  return (
    <div
      style={{
        height:       "6px",
        borderRadius: "999px",
        background:   "rgba(255,255,255,0.1)",
        overflow:     "hidden",
        marginTop:    "6px",
      }}
    >
      <div
        style={{
          height:       "100%",
          width:        `${Math.min(pct, 100)}%`,
          borderRadius: "999px",
          background:   pct >= 50 ? "#F59E0B" : "rgba(255,255,255,0.3)",
          transition:   "width 1.2s cubic-bezier(0.22,1,0.36,1) 600ms",
        }}
      />
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────

export function WrappedShell({ stats, sessionId, playerId }: WrappedShellProps) {
  const [introVisible, setIntroVisible] = useState(true);
  const router = useRouter();

  const sorted = sortAwardsByRarity(stats.earnedAwards);

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
              background:   "rgba(6,13,27,0.95)",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              padding:      "1rem 1.25rem 0.75rem",
              display:      "flex",
              alignItems:   "center",
              justifyContent: "space-between",
              position:     "sticky",
              top:          0,
              zIndex:       10,
            }}
          >
            <div>
              <p
                style={{
                  fontSize:   "10px",
                  fontWeight: "900",
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  color:      "rgba(245,158,11,0.7)",
                  margin:     0,
                }}
              >
                Session Wrapped
              </p>
              <p
                style={{
                  fontSize:   "1.25rem",
                  fontWeight: "800",
                  color:      "#FFFFFF",
                  margin:     0,
                  lineHeight: 1.2,
                }}
              >
                {stats.playerName}&rsquo;s Night
              </p>
            </div>

            <button
              onClick={() => router.push("/play")}
              style={{
                fontSize:      "11px",
                fontWeight:    "700",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color:         "rgba(255,255,255,0.5)",
                background:    "transparent",
                border:        "1px solid rgba(255,255,255,0.12)",
                borderRadius:  "999px",
                padding:       "6px 14px",
                cursor:        "pointer",
              }}
            >
              Done
            </button>
          </div>

          {/* ── Stats summary card ──────────────────────── */}
          <div style={{ padding: "1.25rem 1.25rem 0" }}>
            <div
              style={{
                borderRadius: "1.25rem",
                border:       "1px solid rgba(245,158,11,0.2)",
                background:   "rgba(245,158,11,0.06)",
                padding:      "1.25rem",
                animation:    "wi-up 400ms cubic-bezier(0.22,1,0.36,1) 80ms both",
              }}
            >
              {/* Big stats row */}
              <div
                style={{
                  display:        "flex",
                  justifyContent: "space-around",
                  marginBottom:   "1rem",
                }}
              >
                {[
                  { label: "Matches",  value: stats.games,    color: "#FFFFFF" },
                  { label: "Wins",     value: stats.wins,     color: "#F59E0B" },
                  { label: "Losses",   value: stats.losses,   color: "rgba(255,255,255,0.45)" },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ textAlign: "center" }}>
                    <p
                      style={{
                        fontSize:   "clamp(2rem, 12vw, 3.5rem)",
                        fontWeight: "900",
                        color,
                        margin:     0,
                        lineHeight: 1,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {value}
                    </p>
                    <p
                      style={{
                        fontSize:      "9px",
                        fontWeight:    "900",
                        letterSpacing: "0.2em",
                        textTransform: "uppercase",
                        color:         "rgba(255,255,255,0.3)",
                        margin:        "4px 0 0",
                      }}
                    >
                      {label}
                    </p>
                  </div>
                ))}
              </div>

              {/* Win rate bar */}
              <div style={{ marginBottom: "0.5rem" }}>
                <div
                  style={{
                    display:        "flex",
                    justifyContent: "space-between",
                    alignItems:     "baseline",
                  }}
                >
                  <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)", fontWeight: 600 }}>
                    Win Rate
                  </span>
                  <span style={{ fontSize: "13px", color: "#F59E0B", fontWeight: 700 }}>
                    {Math.round(stats.winPct)}%
                  </span>
                </div>
                <WinRateBar pct={stats.winPct} />
              </div>

              {/* Point diff + rank */}
              <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.75rem" }}>
                <div
                  style={{
                    flex:         1,
                    background:   "rgba(255,255,255,0.04)",
                    borderRadius: "0.625rem",
                    padding:      "0.5rem 0.75rem",
                    textAlign:    "center",
                  }}
                >
                  <p style={{ margin: 0, fontSize: "1.125rem", fontWeight: 700, color: stats.pointDiff >= 0 ? "#F59E0B" : "rgba(255,255,255,0.5)" }}>
                    {stats.pointDiff >= 0 ? "+" : ""}{stats.pointDiff}
                  </p>
                  <p style={{ margin: 0, fontSize: "9px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginTop: "2px" }}>
                    Point Diff
                  </p>
                </div>
                {stats.sessionRank !== null && (
                  <div
                    style={{
                      flex:         1,
                      background:   "rgba(255,255,255,0.04)",
                      borderRadius: "0.625rem",
                      padding:      "0.5rem 0.75rem",
                      textAlign:    "center",
                    }}
                  >
                    <p style={{ margin: 0, fontSize: "1.125rem", fontWeight: 700, color: stats.sessionRank === 1 ? "#F59E0B" : "#FFFFFF" }}>
                      #{stats.sessionRank}
                    </p>
                    <p style={{ margin: 0, fontSize: "9px", fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "rgba(255,255,255,0.3)", marginTop: "2px" }}>
                      Session Rank
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Awards section ──────────────────────────── */}
          <div style={{ padding: "1rem 1.25rem 2rem" }}>
            {sorted.length > 0 ? (
              <>
                <p
                  style={{
                    fontSize:      "10px",
                    fontWeight:    "900",
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                    color:         "rgba(255,255,255,0.3)",
                    marginBottom:  "0.75rem",
                    animation:     "wi-up 400ms cubic-bezier(0.22,1,0.36,1) 150ms both",
                  }}
                >
                  {sorted.length} Award{sorted.length !== 1 ? "s" : ""} Earned
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {sorted.map((slug, i) => (
                    <WrappedAwardCard
                      key={slug}
                      slug={slug}
                      data={stats.awardData[slug] ?? {}}
                      index={i}
                    />
                  ))}
                </div>
              </>
            ) : (
              /* No-awards state */
              <div
                style={{
                  textAlign:  "center",
                  padding:    "3rem 1rem",
                  animation:  "wi-up 400ms cubic-bezier(0.22,1,0.36,1) 200ms both",
                }}
              >
                <p style={{ fontSize: "3rem", margin: "0 0 1rem" }}>🫶</p>
                <p style={{ fontSize: "1.25rem", fontWeight: 700, color: "#FFFFFF", margin: "0 0 0.5rem" }}>
                  Participation Trophy
                </p>
                <p style={{ fontSize: "0.875rem", color: "rgba(255,255,255,0.5)", margin: 0 }}>
                  You showed up and put in the hours. Come back next session — the awards will follow.
                </p>
              </div>
            )}
          </div>

          {/* ── Match Recap ───────────────────────────── */}
          {stats.games > 0 && (
            <div style={{ padding: "0 1.25rem 1.5rem" }}>
              <p
                style={{
                  fontSize:      "10px",
                  fontWeight:    "900",
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  color:         "rgba(255,255,255,0.3)",
                  marginBottom:  "0.75rem",
                }}
              >
                Match Recap
              </p>
              {/* dark wrapper so MatchHistory uses its dark-mode variants */}
              <div className="dark">
                <MatchHistory sessionId={sessionId} playerId={playerId} />
              </div>
            </div>
          )}

          {/* ── Footer: share + done ──────────────────── */}
          <div
            style={{
              padding:  "1rem 1.25rem",
              display:  "flex",
              gap:      "0.75rem",
              animation: "wi-up 400ms cubic-bezier(0.22,1,0.36,1) 300ms both",
            }}
          >
            <button
              onClick={() => {
                // Share API — copy URL to clipboard as fallback
                const url = window.location.href;
                if (navigator.share) {
                  navigator.share({
                    title: `${stats.playerName}'s Session Wrapped`,
                    text: `I played ${stats.games} games and won ${stats.wins} tonight 🏸`,
                    url,
                  }).catch(() => {});
                } else {
                  navigator.clipboard.writeText(url).catch(() => {});
                }
              }}
              style={{
                flex:          1,
                display:       "flex",
                alignItems:    "center",
                justifyContent: "center",
                gap:           "0.5rem",
                padding:       "0.875rem",
                borderRadius:  "0.875rem",
                border:        "1px solid rgba(255,255,255,0.12)",
                background:    "rgba(255,255,255,0.05)",
                color:         "rgba(255,255,255,0.7)",
                fontSize:      "0.875rem",
                fontWeight:    "700",
                cursor:        "pointer",
              }}
            >
              <Share2 size={16} />
              Share
            </button>

            <button
              onClick={() => router.push("/play")}
              style={{
                flex:          2,
                padding:       "0.875rem",
                borderRadius:  "0.875rem",
                background:    "#F59E0B",
                color:         "#060D1B",
                fontSize:      "0.875rem",
                fontWeight:    "900",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                border:        "none",
                cursor:        "pointer",
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
