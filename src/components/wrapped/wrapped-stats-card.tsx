"use client";

// ============================================================
// WrappedStatsCard — Session summary statistics card
// ============================================================

import type { WrappedStats } from "./wrapped-shell";

function WinRateBar({ pct }: { pct: number }) {
  return (
    <div
      style={{
        height: "6px",
        borderRadius: "999px",
        background: "rgba(255,255,255,0.1)",
        overflow: "hidden",
        marginTop: "6px",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.min(pct, 100)}%`,
          borderRadius: "999px",
          background: pct >= 50 ? "#F59E0B" : "rgba(255,255,255,0.3)",
          transition: "width 1.2s cubic-bezier(0.22,1,0.36,1) 600ms",
        }}
      />
    </div>
  );
}

interface WrappedStatsCardProps {
  stats: WrappedStats;
}

export function WrappedStatsCard({ stats }: WrappedStatsCardProps) {
  return (
    <div style={{ padding: "1.25rem 1.25rem 0" }}>
      <div
        style={{
          borderRadius: "1.25rem",
          border: "1px solid rgba(245,158,11,0.2)",
          background: "rgba(245,158,11,0.06)",
          padding: "1.25rem",
          animation: "wi-up 400ms cubic-bezier(0.22,1,0.36,1) 80ms both",
        }}
      >
        {/* Big stats row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-around",
            marginBottom: "1rem",
          }}
        >
          {[
            { label: "Matches", value: stats.games, color: "#FFFFFF" },
            { label: "Wins", value: stats.wins, color: "#F59E0B" },
            { label: "Losses", value: stats.losses, color: "rgba(255,255,255,0.45)" },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ textAlign: "center" }}>
              <p
                style={{
                  fontSize: "clamp(2rem, 12vw, 3.5rem)",
                  fontWeight: "900",
                  color,
                  margin: 0,
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {value}
              </p>
              <p
                style={{
                  fontSize: "9px",
                  fontWeight: "900",
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  color: "rgba(255,255,255,0.3)",
                  margin: "4px 0 0",
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
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
            }}
          >
            <span
              style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)", fontWeight: 600 }}
            >
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
              flex: 1,
              background: "rgba(255,255,255,0.04)",
              borderRadius: "0.625rem",
              padding: "0.5rem 0.75rem",
              textAlign: "center",
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: "1.125rem",
                fontWeight: 700,
                color: stats.pointDiff >= 0 ? "#F59E0B" : "rgba(255,255,255,0.5)",
              }}
            >
              {stats.pointDiff >= 0 ? "+" : ""}
              {stats.pointDiff}
            </p>
            <p
              style={{
                margin: 0,
                fontSize: "9px",
                fontWeight: 700,
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.3)",
                marginTop: "2px",
              }}
            >
              Point Diff
            </p>
          </div>
          {stats.sessionRank !== null && (
            <div
              style={{
                flex: 1,
                background: "rgba(255,255,255,0.04)",
                borderRadius: "0.625rem",
                padding: "0.5rem 0.75rem",
                textAlign: "center",
              }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: "1.125rem",
                  fontWeight: 700,
                  color: stats.sessionRank === 1 ? "#F59E0B" : "#FFFFFF",
                }}
              >
                #{stats.sessionRank}
              </p>
              <p
                style={{
                  margin: 0,
                  fontSize: "9px",
                  fontWeight: 700,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  color: "rgba(255,255,255,0.3)",
                  marginTop: "2px",
                }}
              >
                Session Rank
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
