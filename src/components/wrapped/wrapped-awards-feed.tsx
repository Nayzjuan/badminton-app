"use client";

// ============================================================
// WrappedAwardsFeed — Awards section for the Wrapped page
// ============================================================

import { WrappedAwardCard } from "@/components/wrapped/wrapped-award-card";
import type { WrappedStats } from "./wrapped-shell";

interface WrappedAwardsFeedProps {
  stats: WrappedStats;
  sorted: string[];
}

export function WrappedAwardsFeed({ stats, sorted }: WrappedAwardsFeedProps) {
  const totalEarned = stats.earnedAwards.length;

  return (
    <div style={{ padding: "1rem 1.25rem 2rem" }}>
      {sorted.length > 0 ? (
        <>
          <p
            style={{
              fontSize: "10px",
              fontWeight: "900",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.3)",
              marginBottom: "0.75rem",
              animation: "wi-up 400ms cubic-bezier(0.22,1,0.36,1) 150ms both",
            }}
          >
            {totalEarned > sorted.length
              ? `Top ${sorted.length} of ${totalEarned} Awards`
              : `${sorted.length} Award${sorted.length !== 1 ? "s" : ""} Earned`}
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
            textAlign: "center",
            padding: "3rem 1rem",
            animation: "wi-up 400ms cubic-bezier(0.22,1,0.36,1) 200ms both",
          }}
        >
          <p style={{ fontSize: "3rem", margin: "0 0 1rem" }}>🫶</p>
          <p
            style={{
              fontSize: "1.25rem",
              fontWeight: 700,
              color: "#FFFFFF",
              margin: "0 0 0.5rem",
            }}
          >
            Participation Trophy
          </p>
          <p style={{ fontSize: "0.875rem", color: "rgba(255,255,255,0.5)", margin: 0 }}>
            You showed up and put in the hours. Come back next session — the awards will follow.
          </p>
        </div>
      )}
    </div>
  );
}
