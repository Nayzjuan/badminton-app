"use client";

// ============================================================
// MatchEventTimeline — the per-match provenance / modification trail
// ============================================================
// Organizer-facing. Lazy-loads match_events on first expand. Shows how the
// match was born and every composition change it underwent, in order, with
// who/when. Pre-cutover matches (no event trail) get an explicit empty state.
// ============================================================

import { useState, useTransition } from "react";
import { getMatchEvents } from "@/app/actions/match-events";
import type { MatchEvent, MatchMovement } from "@/types/database";
import { isRosterSwapMovement } from "@/lib/match-provenance";

type Props = {
  matchId: string;
  sessionId: string;
  /** When true (provenance_backfilled), the match predates the audit log. */
  preCutover?: boolean;
};

function describe(ev: MatchEvent): string {
  const moves = (ev.movements ?? []) as MatchMovement[];
  switch (ev.event_type) {
    case "created": {
      const method = (ev.payload?.method as string) ?? "auto";
      const label =
        method === "held" ? "Held draft" : method === "manual" ? "Manual match" : "Auto draft";
      return `Created · ${label}`;
    }
    case "published":
      return "Published to players";
    case "roster_swap": {
      const m = moves[0];
      if (m && isRosterSwapMovement(m))
        return `${m.out_player_name} → ${m.in_player_name} (team ${m.team.toUpperCase()})`;
      return "Roster changed";
    }
    case "team_flip": {
      const names = moves
        .map((m) => (isRosterSwapMovement(m) ? null : m.player_name))
        .filter(Boolean);
      return names.length === 2 ? `${names[0]} ↔ ${names[1]} swapped sides` : "Teams swapped";
    }
    case "ondeck_pull": {
      const m = moves[0];
      const leg = (ev.payload?.leg as string) ?? "";
      if (m && isRosterSwapMovement(m))
        return `Pulled ${m.in_player_name} in for ${m.out_player_name}${leg === "ondeck" ? " (backfill)" : ""}`;
      return "Cross-court pull";
    }
    case "undo": {
      const m = moves[0];
      if (m && isRosterSwapMovement(m)) return `Undid: ${m.out_player_name} → ${m.in_player_name}`;
      return "Undid a change";
    }
    case "player_left": {
      const m = moves[0];
      return m && isRosterSwapMovement(m) ? `${m.out_player_name} left` : "Player left";
    }
    case "cancelled":
      return "Match cancelled";
    case "score_edit": {
      const o = ev.payload?.old as { a: number; b: number } | undefined;
      const n = ev.payload?.new as { a: number; b: number } | undefined;
      return o && n ? `Score corrected ${o.a}–${o.b} → ${n.a}–${n.b}` : "Score edited";
    }
    case "revert":
      return "Reverted to active";
    default:
      return ev.event_type;
  }
}

const PHASE_LABEL: Record<string, string> = {
  draft: "draft",
  active: "mid-game",
  post_completion: "after game",
};

function eventTime(iso: string): string {
  // Deterministic short clock label (avoids locale variance across SSR/CSR).
  const d = new Date(iso);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

export function MatchEventTimeline({ matchId, sessionId, preCutover }: Props) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<MatchEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && events === null && !pending) {
      startTransition(async () => {
        const res = await getMatchEvents(matchId, sessionId);
        if (res.success) setEvents(res.events);
        else setError(res.error);
      });
    }
  }

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 font-medium text-muted-foreground
                   transition-colors hover:text-foreground cursor-pointer"
      >
        <span
          className={`inline-block transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        >
          ›
        </span>
        History
      </button>

      {open && (
        <div className="mt-2 pl-3">
          {pending && <p className="text-muted-foreground">Loading…</p>}
          {error && <p className="text-rose-500">{error}</p>}
          {!pending && !error && events?.length === 0 && (
            <p className="text-muted-foreground">
              {preCutover
                ? "Created before the audit log — no detailed history."
                : "No changes recorded."}
            </p>
          )}
          {!pending && events && events.length > 0 && (
            <ol className="space-y-1.5">
              {events.map((ev) => (
                <li key={ev.id} className="flex items-baseline gap-2 leading-snug">
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">
                    {eventTime(ev.created_at)}
                  </span>
                  <span className="text-foreground">{describe(ev)}</span>
                  <span className="text-muted-foreground/70">
                    · {PHASE_LABEL[ev.phase] ?? ev.phase}
                    {ev.actor_name
                      ? ` · ${ev.actor_name}`
                      : ev.actor_type === "engine"
                        ? " · engine"
                        : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
