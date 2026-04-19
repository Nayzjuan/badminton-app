"use client";

// ============================================================
// OnDeckAlert — Player-facing match status card
// ============================================================
// Four display states (in priority order):
//
//  1. "in_progress"  → "Now Playing" violet card (on court)
//  2. "pending"      → "You're Up Next!" amber card (on-deck, no court yet)
//                      Shows full Team A vs Team B with names + skill badges
//  3. Approaching    → "Get Ready" blue/amber card (positions 1–4 in queue)
//  4. null           → nothing rendered
// ============================================================

import { SkillBadge } from "@/components/ui/skill-badge";
import type { Court, Profile, MatchStatus, QueueStatus as QueueStatusType } from "@/types/database";

interface OnDeckAlertProps {
  matchStatus: MatchStatus | null;
  queueStatus: QueueStatusType | null;
  position: number | null;
  court: Court | null;
  teammates: Profile[];
  opponents: Profile[];
  /** 1-based position among all pending on-deck matches (1 = next court). */
  onDeckPosition?: number | null;
  /** Total pending on-deck matches right now. */
  totalOnDeck?: number;
}

export function OnDeckAlert({
  matchStatus,
  queueStatus,
  position,
  court,
  teammates,
  opponents,
  onDeckPosition = null,
  totalOnDeck = 0,
}: OnDeckAlertProps) {
  // ── State 1: IN PROGRESS — on court right now ──────────────
  if (matchStatus === "in_progress" || queueStatus === "playing") {
    return (
      <div className="rounded-2xl border-2 border-violet-400 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/20 p-5 text-center">
        <p className="text-xs font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400">
          Now Playing
        </p>
        <p className="mt-1 text-2xl font-bold text-violet-900 dark:text-violet-200">
          {court?.name ?? "On Court"}
        </p>

        <div className="mt-4 flex items-start justify-center gap-5 text-sm">
          <div className="flex flex-col items-center gap-1.5">
            <p className="text-xs font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400">
              You &amp; Partner
            </p>
            {teammates.map((t) => (
              <div key={t.id} className="flex items-center gap-1.5">
                <span className="text-sm font-bold text-violet-900 dark:text-violet-200">{t.display_name}</span>
                <SkillBadge level={t.skill_level} />
              </div>
            ))}
          </div>
          <span className="mt-1 text-lg font-black text-violet-300 dark:text-violet-600">vs</span>
          <div className="flex flex-col items-center gap-1.5">
            <p className="text-xs font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400">
              Opponents
            </p>
            {opponents.map((o) => (
              <div key={o.id} className="flex items-center gap-1.5">
                <span className="text-sm font-bold text-violet-900 dark:text-violet-200">{o.display_name}</span>
                <SkillBadge level={o.skill_level} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── State 2: ON DECK — match formed, waiting for a court ───
  if (matchStatus === "pending" || queueStatus === "on_deck") {
    const hasPlayers = teammates.length > 0 || opponents.length > 0;

    // Position-aware header copy
    const deckEyebrow =
      onDeckPosition !== null && totalOnDeck > 1
        ? `${onDeckPosition} of ${totalOnDeck} on deck`
        : "You're Up Next!";
    const deckHeading =
      onDeckPosition === null || onDeckPosition === 1
        ? "Next Available Court!"
        : `#${onDeckPosition} On Deck`;
    const deckSubline =
      onDeckPosition === null || onDeckPosition === 1
        ? "Find your teammates — head to a court when called 🏸"
        : onDeckPosition === 2
        ? "1 match ahead — get warmed up! 🏸"
        : `${onDeckPosition - 1} matches ahead — be ready soon 🏸`;

    return (
      <div className="rounded-2xl border-2 border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/20 p-5 animate-in fade-in slide-in-from-top-2 duration-300">
        {/* Header */}
        <div className="text-center mb-4">
          <p className="text-xs font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
            {deckEyebrow}
          </p>
          <p className="mt-1 text-xl font-bold text-amber-900 dark:text-amber-200">
            {deckHeading}
          </p>
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">
            {deckSubline}
          </p>
        </div>

        {/* Team layout */}
        {hasPlayers && (
          <div className="mt-3 rounded-xl bg-white/70 dark:bg-card/60 p-4">
            <div className="flex items-stretch gap-3">
              {/* My team */}
              <div className="flex-1 text-center">
                <p className="mb-2 text-xs font-black uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
                  Your Team
                </p>
                {teammates.length > 0 ? (
                  teammates.map((t) => (
                    <div key={t.id} className="mb-1.5 last:mb-0">
                      <p className="text-base font-bold text-slate-900 dark:text-foreground">{t.display_name}</p>
                      <SkillBadge level={t.skill_level} className="mt-0.5" />
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-500 dark:text-muted-foreground">Loading…</p>
                )}
              </div>

              {/* VS divider */}
              <div className="flex shrink-0 items-center justify-center">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 dark:bg-amber-600 text-xs font-bold text-white shadow-sm">
                  VS
                </div>
              </div>

              {/* Opponents */}
              <div className="flex-1 text-center">
                <p className="mb-2 text-xs font-black uppercase tracking-wider text-slate-500 dark:text-muted-foreground">
                  Opponents
                </p>
                {opponents.length > 0 ? (
                  opponents.map((o) => (
                    <div key={o.id} className="mb-1.5 last:mb-0">
                      <p className="text-base font-bold text-slate-900 dark:text-foreground">{o.display_name}</p>
                      <SkillBadge level={o.skill_level} className="mt-0.5" />
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-500 dark:text-muted-foreground">Loading…</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Court line — only shows once court is assigned (pending→in_progress transition) */}
        {court && (
          <p className="mt-3 text-center text-base font-bold text-amber-900 dark:text-amber-300">
            Head to {court.name}! →
          </p>
        )}
      </div>
    );
  }

  // ── State 3: APPROACHING — in queue, near the front ────────
  if (!matchStatus && queueStatus === "waiting" && position !== null && position <= 4) {
    const urgencyStyles =
      position <= 2
        ? "bg-amber-50 dark:bg-amber-950/20 border-amber-400 dark:border-amber-700 text-amber-900 dark:text-amber-200"
        : "bg-blue-50 dark:bg-blue-950/20 border-blue-300 dark:border-blue-800 text-blue-900 dark:text-blue-200";

    const label =
      position === 1
        ? "You're Next!"
        : position === 2
        ? "Almost there…"
        : position === 3
        ? "Get ready!"
        : "Coming up soon";

    return (
      <div
        className={`rounded-2xl border-2 p-5 text-center animate-in fade-in slide-in-from-top-2 duration-300 ${urgencyStyles}`}
      >
        <p className="text-sm font-medium uppercase tracking-wide opacity-75">
          #{position} in line
        </p>
        <p className="mt-1 text-xl font-bold">{label}</p>
      </div>
    );
  }

  return null;
}
