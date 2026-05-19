"use client";

// ============================================================
// Sandbox: Active Courts Grid — light mode alignment diagnosis
// Route: /sandbox/active-courts-grid
// ============================================================
// Renders the ACTUAL CourtCard structure (no auth needed) with
// a mix of states to expose the alignment issue in light mode.
// ============================================================

import { Trophy, XCircle, Plus, Swords } from "lucide-react";
import { TeamsGrid, type RosterPlayer } from "@/components/organizer/match-roster";
import { MatchOriginTag } from "@/components/organizer/match-origin-tag";

// ── Mock players ─────────────────────────────────────────────

const makePlayer = (
  id: string,
  name: string,
  skill: RosterPlayer["skill_level"]
): RosterPlayer => ({
  player_id: id,
  display_name: name,
  skill_level: skill,
  vip_tag: null,
  vip_theme: null,
});

const COURTS = [
  {
    id: "c1",
    name: "Court 1",
    state: "in_progress" as const,
    timer: "12:34",
    teamA: [makePlayer("p1", "Marcus", "advanced"), makePlayer("p2", "Priya", "intermediate")],
    teamB: [makePlayer("p3", "Jordan", "advanced"), makePlayer("p4", "Sam", "beginner")],
  },
  {
    id: "c2",
    name: "Court 2",
    state: "available" as const,
  },
  {
    id: "c3",
    name: "Court 3",
    state: "in_progress" as const,
    timer: "04:07",
    teamA: [makePlayer("p5", "Dana", "advanced"), makePlayer("p6", "Riley", "intermediate")],
    teamB: [makePlayer("p7", "Alex", "advanced"), makePlayer("p8", "Chris", "intermediate")],
  },
  {
    id: "c4",
    name: "Court 4",
    state: "in_progress" as const,
    timer: "28:51",
    teamA: [
      makePlayer("p9", "Taylor", "lower_intermediate"),
      makePlayer("p10", "Quinn", "intermediate"),
    ],
    teamB: [makePlayer("p11", "Morgan", "advanced"), makePlayer("p12", "Casey", "beginner")],
  },
  {
    id: "c5",
    name: "Court 5",
    state: "available" as const,
  },
  {
    id: "c6",
    name: "Court 6",
    state: "closed" as const,
  },
];

function CourtCardMock({ court }: { court: (typeof COURTS)[number] }) {
  const isActive = court.state === "in_progress";

  return (
    <div
      className={[
        "flex flex-col rounded-2xl shadow-md overflow-hidden transition-all",
        !isActive ? "bg-white dark:bg-card border border-gray-200 dark:border-border" : "",
      ].join(" ")}
      style={
        isActive
          ? {
              background: "#0D1B2A",
              boxShadow: "0 0 0 1px rgba(16,185,129,0.3), 0 0 40px rgba(16,185,129,0.12)",
            }
          : undefined
      }
    >
      {/* Header */}
      <div
        className={[
          "flex items-center justify-between gap-2 px-5 pt-4 pb-3",
          isActive ? "border-b" : "border-b border-gray-200 dark:border-border",
        ].join(" ")}
        style={isActive ? { borderColor: "rgba(255,255,255,0.1)" } : undefined}
      >
        <div className="flex items-center gap-2 min-w-0">
          <h3
            className={`truncate text-base font-bold ${
              isActive ? "text-white" : "text-gray-900 dark:text-foreground"
            }`}
          >
            {court.name}
          </h3>
          {court.id === "c4" && (
            <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-bold uppercase tracking-wider bg-amber-100 border-amber-300 text-amber-800">
              Mixed Level
            </span>
          )}
          {court.id === "c3" && <MatchOriginTag origin="manual" />}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isActive && (
            <span className="text-xs font-mono tabular-nums text-white/60">
              {(court as { timer?: string }).timer}
            </span>
          )}
          <span
            className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-bold uppercase tracking-widest ${
              court.state === "in_progress"
                ? "bg-blue-600 text-white border-blue-700"
                : court.state === "available"
                  ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                  : "bg-gray-100 text-gray-600 border-gray-200"
            }`}
          >
            {court.state === "in_progress"
              ? "In Progress"
              : court.state === "available"
                ? "Available"
                : "Closed"}
          </span>
        </div>
      </div>

      {/* Body */}
      {isActive && "teamA" in court && (
        <div className="flex-1">
          <TeamsGrid
            dark
            teamA={court.teamA!}
            teamB={court.teamB!}
            labelA="Team A"
            labelB="Team B"
          />
        </div>
      )}

      {!isActive && (
        <div className="flex-1 px-4 pb-3">
          {court.state === "available" && (
            <div className="flex flex-col items-center justify-center gap-2 py-6">
              <div className="rounded-full bg-emerald-50 border border-emerald-200 p-2.5">
                <Swords className="h-5 w-5 text-emerald-400" />
              </div>
              <p className="text-sm font-medium text-emerald-600">Ready for next match</p>
            </div>
          )}
          {court.state === "closed" && (
            <div className="flex items-center justify-center py-6">
              <p className="text-sm text-muted-foreground">Court is closed</p>
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div
        className={`px-4 pt-3 pb-4 space-y-2 ${isActive ? "border-t" : ""}`}
        style={isActive ? { borderColor: "rgba(255,255,255,0.1)" } : undefined}
      >
        {isActive && (
          <div className="flex items-center justify-end gap-2">
            <button className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-red-500 hover:bg-red-50 transition-colors">
              <XCircle className="h-3.5 w-3.5" />
              Cancel
            </button>
            <button className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2.5 min-h-[44px] text-xs font-semibold text-white hover:bg-slate-800 transition-colors shadow-sm">
              <Trophy className="h-3.5 w-3.5" />
              Input Score &amp; End
            </button>
          </div>
        )}
        {court.state === "available" && (
          <div className="flex items-center justify-between gap-2">
            <button className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2.5 min-h-[44px] text-sm font-semibold text-white hover:bg-emerald-700 transition-colors shadow-sm">
              <Plus className="h-4 w-4" />
              Call Next Match
            </button>
            <button className="rounded-xl border border-gray-200 px-3 py-2.5 text-xs text-gray-500 hover:bg-gray-50 transition-colors">
              Close
            </button>
          </div>
        )}
        {court.state === "closed" && (
          <div className="flex items-center justify-between gap-2">
            <button className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
              Reopen Court
            </button>
            <button className="rounded-xl border border-destructive/30 px-3 py-2.5 text-xs text-destructive hover:bg-destructive/10 transition-colors">
              Remove
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ActiveCourtsGridPage() {
  return (
    <div className="min-h-screen bg-[#FAFAF7] px-6 py-10">
      <div className="mx-auto max-w-5xl">
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          Sandbox / active-courts-grid
        </p>
        <h1 className="mt-1 text-2xl font-black text-foreground">
          Active Courts — Light Mode Grid
        </h1>
        <p className="mt-2 mb-8 text-sm text-muted-foreground">
          Mixed states: 4 in-progress (dark navy) + 1 available + 1 closed. This reproduces the
          alignment issue in light mode.
        </p>

        {/* The exact same grid as in active-courts.tsx */}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {COURTS.map((court) => (
            <CourtCardMock key={court.id} court={court} />
          ))}
        </div>

        {/* Row-by-row diagnostic */}
        <div className="mt-16">
          <h2 className="mb-4 text-lg font-bold text-foreground">
            Row 1 — in_progress vs available (the main mismatch)
          </h2>
          <div className="grid grid-cols-2 gap-5">
            <CourtCardMock court={COURTS[0]} />
            <CourtCardMock court={COURTS[1]} />
          </div>
        </div>

        <div className="mt-10">
          <h2 className="mb-4 text-lg font-bold text-foreground">
            Row 2 — two in_progress side by side
          </h2>
          <div className="grid grid-cols-2 gap-5">
            <CourtCardMock court={COURTS[2]} />
            <CourtCardMock court={COURTS[3]} />
          </div>
        </div>
      </div>
    </div>
  );
}
