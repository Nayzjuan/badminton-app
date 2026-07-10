"use client";

// ============================================================
// Queue — By Skill Level view
// ============================================================
// A second lens on the Queue & Match Control tab (the flat table
// is the other). Waiting players only, grouped into skill-tier
// bands ordered Advanced → Beginner, and within each tier sorted
// by wait time (longest waiting first). Empty tiers are hidden.
//
// Fully interactive: it shares QueueControl's selection state and
// mutation handlers, so selecting 4 here feeds the same manual-
// match bar, and skill/pause/checkout behave identically to the
// flat view. Locked rows (on_deck / drafted) never appear here —
// this view is scoped to `status === "waiting"`.
//
// Design register: organizer command-center. Chrome uses cc-*
// tokens + clip-cut geometry; the only per-tier hue is the
// SKILL_META dot (the sanctioned skill-color indicator used across
// the organizer). Wait time is the hero metric per row.
// ============================================================

import { LogOut, PauseCircle, PlayCircle } from "lucide-react";
import { VipTag } from "@/components/ui/vip-tag";
import { SKILL_LEVELS } from "@/types/database";
import { SKILL_META } from "@/lib/constants";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { QueueFullWithWaitTime, SkillLevel, Profile } from "@/types/database";

interface QueueSkillGroupsProps {
  /** The full queue (waiting + drafted + on_deck). Filtered to waiting here. */
  queue: QueueFullWithWaitTime[];
  profiles?: Map<string, Profile>;
  /** Shared manual-match selection set (player_ids). */
  selected: Set<string>;
  onToggleSelect: (playerId: string) => void;
  /** True when the selection has reached the required roster size (cap). */
  isFull: boolean;
  onSkillChange: (playerId: string, skill: SkillLevel) => void;
  updatingSkill: string | null;
  onPausePlayer: (playerId: string, isPaused: boolean) => void;
  pausingPlayers: Set<string>;
  onRemoveFromQueue: (playerId: string) => void;
  removingPlayer: string | null;
}

// Tiers highest → lowest (Advanced first). Derived from the numeric
// ordering so it stays in sync if SKILL_LEVELS ever changes.
const TIER_ORDER: SkillLevel[] = [...SKILL_LEVELS]
  .sort((a, b) => b.numeric - a.numeric)
  .map((s) => s.value);

export function QueueSkillGroups({
  queue,
  profiles,
  selected,
  onToggleSelect,
  isFull,
  onSkillChange,
  updatingSkill,
  onPausePlayer,
  pausingPlayers,
  onRemoveFromQueue,
  removingPlayer,
}: QueueSkillGroupsProps) {
  // Waiting-only. Paused players keep status "waiting"; they are shown
  // but sink to the bottom of their tier (matchmaking-ineligible).
  const waiting = queue.filter((q) => q.status === "waiting");

  if (waiting.length === 0) {
    return (
      <div className="clip-cut-sm border border-dashed border-cc-border p-10 text-center">
        <p className="font-command text-[11px] uppercase tracking-[0.12em] text-cc-t3">
          No players waiting
        </p>
        <p className="mt-1 text-sm text-cc-t2">Everyone is on a court or on deck.</p>
      </div>
    );
  }

  // Group by tier, preserving the incoming wait-desc order within each tier
  // (the parent already hands us a stable queue; we re-sort per tier below).
  const byTier = new Map<SkillLevel, QueueFullWithWaitTime[]>();
  for (const entry of waiting) {
    const list = byTier.get(entry.skill_level);
    if (list) list.push(entry);
    else byTier.set(entry.skill_level, [entry]);
  }

  return (
    <div className="space-y-4">
      {TIER_ORDER.map((tier) => {
        const rows = byTier.get(tier);
        if (!rows || rows.length === 0) return null; // hide empty tiers

        // Active first (longest wait → shortest), paused sink to the bottom
        // (also longest-first among themselves).
        const ordered = [...rows].sort((a, b) => {
          if (a.is_paused !== b.is_paused) return a.is_paused ? 1 : -1;
          return b.wait_minutes - a.wait_minutes;
        });
        const activeCount = ordered.filter((r) => !r.is_paused).length;
        const meta = SKILL_META[tier];

        return (
          <section key={tier} aria-label={`${meta.label} — ${activeCount} waiting`}>
            {/* ── Tier header ─────────────────────────────── */}
            <div className="flex items-center gap-2.5 px-0.5 pb-2 pt-1">
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot}`}
                aria-hidden="true"
              />
              <h3 className="font-command text-[12px] font-bold uppercase tracking-[0.14em] text-cc-t1">
                {meta.label}
              </h3>
              <span className="clip-cut-badge border border-cc-border bg-cc-bg-3 px-2 py-0.5 font-command text-[9.5px] uppercase tracking-[0.1em] text-cc-t2">
                {activeCount} waiting
              </span>
              <span className="h-px flex-1 bg-cc-border/60" aria-hidden="true" />
            </div>

            {/* ── Tier rows ───────────────────────────────── */}
            <div className="space-y-1.5">
              {ordered.map((entry, i) => {
                const isLongest = i === 0 && !entry.is_paused;
                return (
                  <PlayerRow
                    key={entry.id}
                    entry={entry}
                    profile={profiles?.get(entry.player_id)}
                    isSelected={selected.has(entry.player_id)}
                    isFull={isFull}
                    isLongest={isLongest}
                    onToggleSelect={onToggleSelect}
                    onSkillChange={onSkillChange}
                    updating={updatingSkill === entry.player_id}
                    onPausePlayer={onPausePlayer}
                    pausing={pausingPlayers.has(entry.player_id)}
                    onRemoveFromQueue={onRemoveFromQueue}
                    removing={removingPlayer === entry.player_id}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── Single player row ─────────────────────────────────────────

interface PlayerRowProps {
  entry: QueueFullWithWaitTime;
  profile?: Profile;
  isSelected: boolean;
  isFull: boolean;
  isLongest: boolean;
  onToggleSelect: (playerId: string) => void;
  onSkillChange: (playerId: string, skill: SkillLevel) => void;
  updating: boolean;
  onPausePlayer: (playerId: string, isPaused: boolean) => void;
  pausing: boolean;
  onRemoveFromQueue: (playerId: string) => void;
  removing: boolean;
}

function PlayerRow({
  entry,
  profile,
  isSelected,
  isFull,
  isLongest,
  onToggleSelect,
  onSkillChange,
  updating,
  onPausePlayer,
  pausing,
  onRemoveFromQueue,
  removing,
}: PlayerRowProps) {
  const isPaused = entry.is_paused;
  const selectable = !isPaused;
  const waitMin = Math.floor(entry.wait_minutes);
  const meta = SKILL_META[entry.skill_level];

  const waitColor = entry.is_bottleneck
    ? "text-cc-red"
    : isLongest
      ? "text-cc-amber"
      : "text-cc-t1";

  const rowState = isPaused
    ? "cursor-default border-cc-border bg-cc-bg-2 opacity-50"
    : isSelected
      ? "cursor-pointer border-cc-accent/60 bg-cc-accent-dim"
      : entry.is_bottleneck
        ? "cursor-pointer border-cc-red/50 bg-cc-red-dim"
        : "cursor-pointer border-cc-border bg-cc-bg-2 hover:border-cc-border-hi";

  function toggle() {
    if (selectable) onToggleSelect(entry.player_id);
  }

  return (
    // Clicking anywhere on the row is a mouse convenience for toggling match
    // selection. Keyboard and assistive-tech users operate the real nested
    // <input type="checkbox"> (it owns the accessible name + checked state), so
    // the row deliberately carries no button role / tabindex / key handler:
    // those would create an ARIA nested-interactive violation and a duplicate
    // tab stop over the checkbox, and a row key handler would swallow Enter/
    // Space aimed at the inner controls. Visible text (name, "Paused", wait,
    // "Longest waiting") is read directly by AT as it traverses the row.
    <div
      onClick={toggle}
      className={`clip-cut-tr flex items-center gap-3 border px-3 py-2.5 transition-colors sm:py-2 ${rowState}`}
    >
      {/* Checkbox — omitted for paused rows */}
      <div
        className="relative z-10 flex shrink-0 items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {selectable ? (
          <label
            htmlFor={`qsg-select-${entry.player_id}`}
            className="relative flex h-5 w-5 cursor-pointer"
          >
            <input
              id={`qsg-select-${entry.player_id}`}
              type="checkbox"
              className="sr-only"
              checked={isSelected}
              disabled={!isSelected && isFull}
              onChange={() => onToggleSelect(entry.player_id)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${entry.display_name} for a match`}
            />
            <div
              aria-hidden="true"
              className={`flex h-5 w-5 items-center justify-center border-2 transition-colors
                          ${
                            isSelected
                              ? "border-cc-accent bg-cc-accent"
                              : isFull
                                ? "cursor-not-allowed border-cc-border bg-cc-bg-3"
                                : "border-cc-border-hi hover:border-cc-accent"
                          }`}
            >
              {isSelected && (
                <svg
                  className="h-3 w-3 text-cc-btn-on-accent"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={3}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
          </label>
        ) : (
          <span className="h-5 w-5" aria-hidden="true" />
        )}
      </div>

      {/* Name + mobile meta line */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-cc-t1">{entry.display_name}</span>
          {profile?.vip_tag && profile?.vip_theme && (
            <VipTag tag={profile.vip_tag} theme={profile.vip_theme} />
          )}
          {isPaused && (
            <span className="clip-cut-badge shrink-0 bg-cc-bg-3 px-2 py-0.5 font-command text-[9px] font-bold uppercase tracking-[0.08em] text-cc-t3">
              Paused
            </span>
          )}
        </div>

        {/* Mobile-only: compact skill chip (tappable) + games. Hidden ≥sm. */}
        <div className="mt-1.5 flex items-center gap-2 sm:hidden">
          <label
            className="relative inline-flex min-h-[44px] cursor-pointer items-center gap-1.5 clip-cut-badge border border-cc-border bg-cc-bg-3 px-3 py-1 font-command text-[10px] uppercase tracking-[0.06em] text-cc-t2 focus-within:outline-none focus-within:ring-2 focus-within:ring-inset focus-within:ring-cc-accent"
            onClick={(e) => e.stopPropagation()}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} aria-hidden="true" />
            <span aria-hidden="true">{meta.abbr}</span>
            <select
              aria-label={`Skill level for ${entry.display_name}`}
              value={entry.skill_level}
              disabled={updating}
              onChange={(e) => onSkillChange(entry.player_id, e.target.value as SkillLevel)}
              onClick={(e) => e.stopPropagation()}
              className={`absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait ${
                updating ? "animate-pulse" : ""
              }`}
            >
              {SKILL_LEVELS.map((sl) => (
                <option key={sl.value} value={sl.value}>
                  {sl.label}
                </option>
              ))}
            </select>
          </label>
          <span className="tabular-nums text-[11px] text-cc-t3">{entry.games_played} games</span>
        </div>
      </div>

      {/* Desktop skill select — hidden < sm */}
      <div className="hidden w-[150px] shrink-0 sm:block" onClick={(e) => e.stopPropagation()}>
        <select
          aria-label={`Skill level for ${entry.display_name}`}
          value={entry.skill_level}
          disabled={updating}
          onChange={(e) => onSkillChange(entry.player_id, e.target.value as SkillLevel)}
          className={`clip-cut-badge w-full border border-cc-border bg-cc-bg-3 px-2 py-1.5 text-xs
                      text-cc-t1 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cc-accent
                      disabled:cursor-wait disabled:opacity-50 ${updating ? "animate-pulse" : ""}`}
        >
          {SKILL_LEVELS.map((sl) => (
            <option key={sl.value} value={sl.value}>
              {sl.label}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop games — hidden < sm */}
      <div className="hidden w-12 shrink-0 text-right sm:block">
        <div className="font-command text-[9px] uppercase tracking-[0.1em] text-cc-t3">Games</div>
        <div className="tabular-nums text-sm text-cc-t2">{entry.games_played}</div>
      </div>

      {/* Wait — hero metric */}
      <div className="shrink-0 text-right">
        <div
          className={`font-display text-2xl font-extrabold italic leading-none tabular-nums sm:text-[28px] ${waitColor}`}
        >
          {waitMin}
          <span className="text-xs font-bold not-italic text-cc-t3">m</span>
        </div>
        <div className="mt-0.5 font-command text-[8px] uppercase tracking-[0.12em] text-cc-t3">
          {isLongest ? "Longest waiting" : "waiting"}
        </div>
      </div>

      {/* Actions */}
      <div
        className="flex shrink-0 items-center justify-end gap-0.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => onPausePlayer(entry.player_id, !isPaused)}
          disabled={pausing}
          className="flex h-11 w-11 items-center justify-center rounded transition-colors
                     text-cc-t3 hover:text-cc-amber focus-visible:outline-none
                     focus-visible:ring-2 focus-visible:ring-cc-accent
                     disabled:cursor-not-allowed disabled:opacity-50"
          title={isPaused ? `Resume ${entry.display_name}` : `Pause ${entry.display_name}`}
          aria-label={isPaused ? `Resume ${entry.display_name}` : `Pause ${entry.display_name}`}
        >
          {isPaused ? (
            <PlayCircle className="h-4 w-4 text-cc-accent" />
          ) : (
            <PauseCircle className="h-4 w-4" />
          )}
        </button>

        {/* Checkout is available for every waiting row, paused included —
            parity with the flat List view (only on_deck/drafted lock it out,
            and those never appear in this waiting-only view). */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              className="flex h-11 w-11 items-center justify-center rounded transition-colors
                         text-cc-t3 hover:text-cc-red focus-visible:outline-none
                         focus-visible:ring-2 focus-visible:ring-cc-accent"
              title="Checkout — player has left the gym"
              aria-label={`Checkout ${entry.display_name}`}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Checkout {entry.display_name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove them from the queue. If they are currently in a match, the match
                will not be affected. They can rejoin later using their name and PIN.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => onRemoveFromQueue(entry.player_id)}
                disabled={removing}
                className="bg-cc-red hover:bg-cc-red/90 focus:ring-cc-red disabled:cursor-not-allowed disabled:opacity-50"
              >
                {removing ? "Removing…" : "Checkout"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
