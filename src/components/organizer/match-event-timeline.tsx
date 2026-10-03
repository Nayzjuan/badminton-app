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
import type { MatchEvent } from "@/types/database";
import {
  describeMatchEvent,
  describeMatchEventActor,
  MATCH_EVENT_PHASE_LABEL,
} from "@/lib/match-event-copy";

type Props = {
  matchId: string;
  sessionId: string;
  /** When true (provenance_backfilled), the match predates the audit log. */
  preCutover?: boolean;
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
                  <span className="text-foreground">{describeMatchEvent(ev)}</span>
                  <span className="text-muted-foreground/70">
                    · {MATCH_EVENT_PHASE_LABEL[ev.phase] ?? ev.phase}
                    {describeMatchEventActor(ev)}
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
