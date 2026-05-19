"use client";

// ============================================================
// WrappedMatchRecap — Match history recap for the Wrapped page
// ============================================================

import type { MatchHistory as MatchHistoryRow } from "@/types/database";

interface WrappedMatchRecapProps {
  matchHistory: MatchHistoryRow[];
}

export function WrappedMatchRecap({ matchHistory }: WrappedMatchRecapProps) {
  if (matchHistory.length === 0) return null;

  return (
    <div style={{ padding: "0 1.25rem 1.5rem" }}>
      <p
        style={{
          fontSize: "10px",
          fontWeight: "900",
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.3)",
          marginBottom: "0.75rem",
        }}
      >
        Match Recap
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {matchHistory.map((match, i) => {
          const isTeamA = match.team === "a";
          const myScore = isTeamA ? match.team_a_score : match.team_b_score;
          const theirScore = isTeamA ? match.team_b_score : match.team_a_score;
          // Guard: both scores must be non-null before determining outcome.
          // Without this, a match with null scores would show as "Lost" because
          // won=false and draw=false both hold when scores are absent.
          const hasScores = myScore !== null && theirScore !== null;
          const won = hasScores && myScore! > theirScore!;
          const draw = hasScores && myScore! === theirScore!;
          const lost = hasScores && !won && !draw;

          const completedDate = match.completed_at ? new Date(match.completed_at) : null;
          const timeStr = completedDate
            ? completedDate.toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })
            : "";

          const borderColor = won
            ? "rgba(52,211,153,0.3)"
            : draw
              ? "rgba(255,255,255,0.12)"
              : "rgba(255,255,255,0.08)";
          const badgeBg = won ? "#10B981" : draw ? "rgba(255,255,255,0.2)" : "rgba(239,68,68,0.25)";
          const badgeColor = won ? "#fff" : draw ? "rgba(255,255,255,0.8)" : "#FCA5A5";
          const badgeLabel = won ? "Won" : draw ? "Draw" : lost ? "Lost" : "—";
          const myScoreColor = won
            ? "#34D399"
            : draw
              ? "rgba(255,255,255,0.5)"
              : "rgba(255,255,255,0.35)";
          const theirScoreColor = lost ? "#FCA5A5" : "rgba(255,255,255,0.35)";

          return (
            <div
              key={match.match_id}
              style={{
                borderRadius: "1rem",
                border: `1px solid ${borderColor}`,
                background: "rgba(255,255,255,0.04)",
                overflow: "hidden",
              }}
            >
              {/* Card header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0.5rem 1rem",
                  borderBottom: `1px solid ${borderColor}`,
                  background: won
                    ? "rgba(52,211,153,0.08)"
                    : draw
                      ? "rgba(255,255,255,0.04)"
                      : "rgba(255,255,255,0.03)",
                }}
              >
                <span
                  style={{
                    fontSize: "11px",
                    color: "rgba(255,255,255,0.4)",
                    fontWeight: 600,
                  }}
                >
                  Match {matchHistory.length - i}
                  {match.court_name ? ` · Court ${match.court_name}` : ""}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  {timeStr && (
                    <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)" }}>
                      {timeStr}
                    </span>
                  )}
                  <span
                    style={{
                      borderRadius: "999px",
                      padding: "2px 8px",
                      fontSize: "10px",
                      fontWeight: "800",
                      textTransform: "uppercase",
                      background: badgeBg,
                      color: badgeColor,
                    }}
                  >
                    {badgeLabel}
                  </span>
                </div>
              </div>

              {/* Score + players */}
              <div style={{ padding: "0.75rem 1rem" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "0.75rem",
                    marginBottom: "0.75rem",
                  }}
                >
                  <span
                    style={{
                      fontSize: "2rem",
                      fontWeight: 900,
                      fontVariantNumeric: "tabular-nums",
                      color: myScoreColor,
                    }}
                  >
                    {myScore ?? "?"}
                  </span>
                  <span
                    style={{
                      fontSize: "0.875rem",
                      fontWeight: 700,
                      color: "rgba(255,255,255,0.2)",
                    }}
                  >
                    –
                  </span>
                  <span
                    style={{
                      fontSize: "2rem",
                      fontWeight: 900,
                      fontVariantNumeric: "tabular-nums",
                      color: theirScoreColor,
                    }}
                  >
                    {theirScore ?? "?"}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "1rem",
                    fontSize: "12px",
                  }}
                >
                  <div style={{ textAlign: "center" }}>
                    <p
                      style={{
                        margin: 0,
                        fontSize: "9px",
                        fontWeight: 700,
                        letterSpacing: "0.15em",
                        textTransform: "uppercase",
                        color: "rgba(255,255,255,0.3)",
                        marginBottom: "2px",
                      }}
                    >
                      Partner
                    </p>
                    <p
                      style={{
                        margin: 0,
                        fontWeight: 600,
                        color: "rgba(255,255,255,0.75)",
                      }}
                    >
                      {match.teammates?.join(", ") ?? "—"}
                    </p>
                  </div>
                  <span style={{ color: "rgba(255,255,255,0.2)" }}>vs</span>
                  <div style={{ textAlign: "center" }}>
                    <p
                      style={{
                        margin: 0,
                        fontSize: "9px",
                        fontWeight: 700,
                        letterSpacing: "0.15em",
                        textTransform: "uppercase",
                        color: "rgba(255,255,255,0.3)",
                        marginBottom: "2px",
                      }}
                    >
                      Opponents
                    </p>
                    <p
                      style={{
                        margin: 0,
                        fontWeight: 600,
                        color: "rgba(255,255,255,0.75)",
                      }}
                    >
                      {match.opponents?.join(" & ") ?? "—"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
