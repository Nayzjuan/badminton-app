"use client";

// ============================================================
// RepeatPairDetails — the non-sticky half of the repeat warning
// ============================================================
// Lives BELOW the sticky ManualMatchBar and scrolls with the page, so the
// full pair list and the expanded match histories can be as tall as they
// need to be without eating the queue (see the split rationale in
// manual-match-bar.tsx).
//
// The disclosure fetches the actual matches behind a count, because "have
// partnered 2x tonight" is a claim the organizer should be able to audit
// before overriding it. `getPairMatches` filters on the same
// COMMITTED_MATCH_STATUSES that produced the count, so the list length can
// never contradict the number that opened it.
//
// Disclosure state is keyed by `pairKey` and cleared the moment that key
// leaves the derived set — otherwise deselecting one player renders pair
// X's match history underneath pair Y's label. Fetched lists are cached per
// pairKey for the life of the component.
//
// No box-in-a-box: rows are `border-b` list items on the tab's own surface,
// never nested cards.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Swords, Users } from "lucide-react";
import { getPairMatches, type PairMatch } from "@/app/actions/repeat-pairing";
import { pairRowSummary, relationNoun } from "@/lib/repeat-pairing-copy";
import type { NameLookup } from "@/lib/repeat-pairing-copy";
import type { PairWarning } from "@/lib/repeat-pairing";

interface RepeatPairDetailsProps {
  id: string;
  sessionId: string;
  /** Derived warnings, already avoidability-gated by the caller. */
  warnings: PairWarning[];
  nameOf: NameLookup;
}

type MatchesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; data: PairMatch[] };

export function RepeatPairDetails({ id, sessionId, warnings, nameOf }: RepeatPairDetailsProps) {
  const [expandedPairKey, setExpandedPairKey] = useState<string | null>(null);
  const [cache, setCache] = useState<Map<string, MatchesState>>(new Map());

  // Derived for rendering, so there is never a frame where an open panel is
  // labelled with a pair that no longer exists…
  const activeKey =
    expandedPairKey && warnings.some((w) => w.pairKey === expandedPairKey) ? expandedPairKey : null;

  // …and cleared in state, so re-selecting that pair later doesn't silently
  // resurrect a panel the organizer never re-opened. Adjusted during render
  // (converges immediately) rather than in an effect.
  if (expandedPairKey !== null && activeKey === null) setExpandedPairKey(null);

  // Scroll the freshly-opened panel into view ONCE, on open.
  //
  // This deliberately is NOT an inline `ref={(node) => node?.scrollIntoView()}`:
  // an inline arrow gets a new identity every render, so React detaches and
  // re-attaches it on EVERY commit and the scroll re-fires. RepeatPairDetails
  // re-renders on every realtime queue/match event and on the 45s wait-time
  // poll, and `block:"nearest"` is a no-op only while the panel is already
  // visible — i.e. it would fire precisely when the organizer had scrolled
  // down the queue to find a replacement pick, yanking them back up.
  const openPanelRef = useRef<HTMLDivElement | null>(null);
  // Re-run when the fetch resolves too, not only on open: at open the body is
  // a one-line "Loading matches…" placeholder, and `block:"nearest"` on a
  // one-liner can leave the list the organizer actually asked for below the
  // fold once it grows to N rows on a 375px viewport.
  const activeStatus = activeKey ? cache.get(activeKey)?.status : undefined;
  useEffect(() => {
    if (activeKey === null) return;
    openPanelRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeKey, activeStatus]);

  const openPair = useCallback(
    (w: PairWarning) => {
      setExpandedPairKey(w.pairKey);
      setCache((prev) => {
        if (prev.has(w.pairKey)) return prev;
        const next = new Map(prev);
        next.set(w.pairKey, { status: "loading" });
        return next;
      });

      // Cached per pairKey and never invalidated inside a build episode: the
      // counts are frozen for the episode, so a refetch could only ever
      // disagree with the number that opened this panel.
      void getPairMatches(sessionId, w.playerIds[0], w.playerIds[1])
        .then((result) => {
          setCache((prev) => {
            const next = new Map(prev);
            next.set(
              w.pairKey,
              result.success ? { status: "ok", data: result.data } : { status: "error" }
            );
            return next;
          });
        })
        .catch((err: unknown) => {
          console.error("[RepeatPairDetails] getPairMatches failed:", err);
          setCache((prev) => new Map(prev).set(w.pairKey, { status: "error" }));
        });
    },
    [sessionId]
  );

  function toggle(w: PairWarning) {
    if (activeKey === w.pairKey) {
      setExpandedPairKey(null);
      return;
    }
    if (cache.has(w.pairKey)) {
      setExpandedPairKey(w.pairKey);
      return;
    }
    openPair(w);
  }

  if (warnings.length === 0) return null;

  return (
    <section
      id={id}
      data-testid="repeat-pair-details"
      aria-label="Repeat pairings in this selection"
      className="clip-cut-sm border border-cc-amber/35 bg-cc-amber-dim"
    >
      <h3 className="border-b border-cc-border px-3 py-2 font-command text-[9.5px] uppercase tracking-[0.13em] text-cc-amber">
        {warnings.length} repeat {warnings.length === 1 ? "pairing" : "pairings"} · advisory only
      </h3>

      <ul className="divide-y divide-cc-border">
        {warnings.map((w) => {
          const open = activeKey === w.pairKey;
          const state = cache.get(w.pairKey);
          const isTeammate = w.relation === "teammate";
          const Icon = isTeammate ? Users : Swords;
          const nameA = nameOf(w.playerIds[0]);
          const nameB = nameOf(w.playerIds[1]);

          return (
            <li key={w.pairKey}>
              <button
                type="button"
                onClick={() => toggle(w)}
                aria-expanded={open}
                className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left
                           transition-colors duration-200 hover:bg-cc-bg-3
                           focus-visible:outline-none focus-visible:ring-2
                           focus-visible:ring-inset focus-visible:ring-cc-accent"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-cc-amber" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm text-cc-t1">
                  {nameA} &amp; {nameB}
                </span>
                {/* Relation on a LABEL, never on hue alone. */}
                <span className="shrink-0 font-command text-[9px] uppercase tracking-[0.10em] text-cc-amber">
                  {relationNoun(w.relation)}
                </span>
                <span className="shrink-0 tabular-nums text-xs text-cc-t2">
                  {pairRowSummary(w)}
                </span>
                <span
                  aria-hidden="true"
                  className={`shrink-0 text-cc-t3 transition-transform duration-200 ${
                    open ? "rotate-90" : ""
                  }`}
                >
                  ›
                </span>
              </button>

              {open && (
                <div ref={open ? openPanelRef : null} className="px-3 pb-3 pl-8">
                  {(!state || state.status === "loading") && (
                    <p className="text-xs text-cc-t3">Loading matches…</p>
                  )}
                  {state?.status === "error" && (
                    <p className="text-xs text-cc-red">Couldn&apos;t load these matches.</p>
                  )}
                  {state?.status === "ok" && state.data.length === 0 && (
                    <p className="text-xs text-cc-t3">No matches found.</p>
                  )}
                  {state?.status === "ok" && state.data.length > 0 && (
                    <ul className="space-y-1.5">
                      {state.data.map((m) => (
                        <PairMatchRow key={m.matchId} match={m} />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── One prior match ──────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  in_progress: "On court now",
  pending: "On deck",
};

function PairMatchRow({ match }: { match: PairMatch }) {
  const teamA = match.players.filter((p) => p.team === "A").map((p) => p.displayName);
  const teamB = match.players.filter((p) => p.team === "B").map((p) => p.displayName);
  const hasScore = match.teamAScore !== null && match.teamBScore !== null;

  return (
    <li className="text-xs text-cc-t2">
      <span className="font-command text-[9px] uppercase tracking-[0.10em] text-cc-t3">
        {STATUS_LABEL[match.status] ?? match.status}
      </span>
      {match.courtName && <span className="text-cc-t3"> · {match.courtName}</span>}
      {hasScore && (
        <span className="tabular-nums text-cc-t1">
          {" "}
          · {match.teamAScore}–{match.teamBScore}
        </span>
      )}
      <span className="text-cc-t3"> · {match.sameTeam ? "same team" : "opposite sides"}</span>
      <div className="truncate text-cc-t2">
        {teamA.join(" & ")} <span className="text-cc-t3">vs</span> {teamB.join(" & ")}
      </div>
    </li>
  );
}
