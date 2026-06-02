"use client";

// ============================================================
// LiveSwapSheet — replacement picker for active court players
// ============================================================
// Opened by a 500ms long-press on any player name in an active
// (in_progress) court card. The outgoing player is determined
// by the long-press target — no Step 1 selection needed.
//
// Three replacement sections (in priority order):
//   1. Switch Teams — opposite-team players in the same match
//   2. On-Deck      — players in pending matches, by court
//   3. Waiting Queue — players ordered by wait time
//
// When an on-deck player is selected, an inline "Fill on-deck"
// expansion appears. The organizer must choose a queue player
// to fill the vacated on-deck slot before Confirm unlocks.
//
// Orange accent (#cc-live) is used throughout to distinguish
// this operation from amber (data correction) and teal (queue swap).
// ============================================================

import { useMemo } from "react";
import { AlertTriangle, ArrowLeftRight, Users } from "lucide-react";
import { SkillBadge } from "@/components/ui/skill-badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { SKILL_META } from "@/lib/constants";
import { skillLevelToInt } from "@/types/database";
import type { SkillLevel } from "@/types/database";
import type { EnrichedMatch } from "@/hooks/use-organizer-data";
import type { QueueFullWithWaitTime } from "@/types/database";
import type {
  ReplacementCandidate,
  FillCandidate,
  LiveSwapState,
} from "@/hooks/use-live-match-swap";

// ── Props ─────────────────────────────────────────────────────

interface LiveSwapSheetProps {
  state: LiveSwapState;
  /** All published on-deck matches (pending status). */
  onDeckMatches: EnrichedMatch[];
  /** Full queue — filtered internally to status === "waiting". */
  queuePlayers: QueueFullWithWaitTime[];
  /** Player IDs currently in ANY in_progress match (used to exclude). */
  activePlayerIds: Set<string>;
  isSubmitting: boolean;
  canConfirm: boolean;
  onSelectReplacement: (candidate: ReplacementCandidate | null) => void;
  onSelectFill: (fill: FillCandidate | null) => void;
  onConfirm: () => void;
  onClose: () => void;
}

// ── Skill abbreviation helper (inline, dark-surface style) ────

function SkillAbbr({ level }: { level: SkillLevel }) {
  const meta = SKILL_META[level];
  return (
    <span className="font-command text-[9px] uppercase tracking-[0.12em] text-cc-t3">
      {meta?.abbr ?? "?"}
    </span>
  );
}

// ── Section header ────────────────────────────────────────────

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-4 pb-1">
      <span className="font-command text-[9px] uppercase tracking-[0.20em] text-cc-t3">
        {label}
      </span>
      {count !== undefined && (
        <span className="font-command text-[9px] text-cc-t3 tabular-nums">({count})</span>
      )}
      <div className="flex-1 h-px bg-cc-border" />
    </div>
  );
}

// ── Player row (selectable) ───────────────────────────────────

function CandidateRow({
  name,
  skillLevel,
  sublabel,
  isSelected,
  isDisabled,
  onClick,
}: {
  name: string;
  skillLevel: SkillLevel;
  sublabel?: string;
  isSelected: boolean;
  isDisabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      className={[
        "w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors",
        "border-b border-cc-border last:border-b-0",
        isSelected
          ? "bg-[var(--cc-live-dim)] outline outline-1 outline-[var(--cc-live)]/40"
          : isDisabled
            ? "opacity-40 cursor-not-allowed"
            : "hover:bg-cc-bg-3 cursor-pointer",
      ].join(" ")}
    >
      {/* Selection indicator */}
      <span
        className={[
          "h-3.5 w-3.5 shrink-0 rounded-full border transition-colors",
          isSelected
            ? "border-[var(--cc-live)] bg-[var(--cc-live)]"
            : "border-cc-border bg-transparent",
        ].join(" ")}
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0">
        <p className="font-command text-[12px] text-cc-t1 truncate">{name}</p>
        {sublabel && (
          <p className="font-command text-[9px] uppercase tracking-[0.12em] text-cc-t3 mt-0.5">
            {sublabel}
          </p>
        )}
      </div>
      <SkillAbbr level={skillLevel} />
    </button>
  );
}

// ── Mixed-level warning ───────────────────────────────────────

function MixedLevelWarning() {
  return (
    <div
      className="mx-4 mt-3 flex items-start gap-2 clip-cut-sm
                 border border-cc-amber/35 bg-cc-amber-dim px-3 py-2.5"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-cc-amber mt-0.5" aria-hidden="true" />
      <p className="font-command text-[9px] uppercase tracking-[0.10em] text-cc-amber leading-relaxed">
        This swap creates a mixed-level match. You can still confirm.
      </p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────

export function LiveSwapSheet({
  state,
  onDeckMatches,
  queuePlayers,
  activePlayerIds,
  isSubmitting,
  canConfirm,
  onSelectReplacement,
  onSelectFill,
  onConfirm,
  onClose,
}: LiveSwapSheetProps) {
  const { isOpen, outgoingPlayer, outgoingTeam, match, selectedReplacement, selectedFill } = state;

  // ── Derived candidate lists ───────────────────────────────────

  const matchPlayerIds = useMemo(
    () => new Set(match?.players.map((p) => p.player_id) ?? []),
    [match]
  );

  // Section 1: Opposite-team players only (for a mutual team swap).
  const sameMatchCandidates = useMemo(() => {
    if (!match || !outgoingTeam || !outgoingPlayer) return [];
    return match.players
      .filter((p) => p.team !== outgoingTeam && p.player_id !== outgoingPlayer.player_id)
      .map((p) => ({
        player_id: p.player_id,
        display_name: p.profile.display_name,
        skill_level: p.profile.skill_level,
        source: "same_match" as const,
      }));
  }, [match, outgoingTeam, outgoingPlayer]);

  // Section 2: On-deck players, excluding: this match, any active match, other active courts.
  const onDeckCandidates = useMemo(() => {
    const candidates: ReplacementCandidate[] = [];
    for (const m of onDeckMatches) {
      for (const p of m.players) {
        if (matchPlayerIds.has(p.player_id)) continue;
        if (activePlayerIds.has(p.player_id)) continue;
        candidates.push({
          player_id: p.player_id,
          display_name: p.profile.display_name,
          skill_level: p.profile.skill_level,
          source: "ondeck",
          onDeckMatchId: m.id,
          onDeckLabel: `On-deck slot ${(m.sort_order ?? 0) + 1}`,
        });
      }
    }
    return candidates;
  }, [onDeckMatches, matchPlayerIds, activePlayerIds]);

  // Section 3: Queue players (waiting only), excluding match + active court players.
  const queueCandidates = useMemo(() => {
    return queuePlayers
      .filter(
        (q) =>
          q.status === "waiting" &&
          !matchPlayerIds.has(q.player_id) &&
          !activePlayerIds.has(q.player_id)
      )
      .map((q) => ({
        player_id: q.player_id,
        display_name: q.display_name,
        skill_level: q.skill_level,
        source: "queue" as const,
        waitMinutes: q.wait_minutes,
      }));
  }, [queuePlayers, matchPlayerIds, activePlayerIds]);

  // Queue players available to fill on-deck hole (excludes all match and active players,
  // plus the already-selected replacement to prevent selecting the same person twice).
  const fillCandidates = useMemo<FillCandidate[]>(() => {
    if (selectedReplacement?.source !== "ondeck") return [];
    return queuePlayers
      .filter(
        (q) =>
          q.status === "waiting" &&
          !matchPlayerIds.has(q.player_id) &&
          !activePlayerIds.has(q.player_id) &&
          q.player_id !== selectedReplacement.player_id
      )
      .map((q) => ({
        player_id: q.player_id,
        display_name: q.display_name,
        skill_level: q.skill_level,
      }));
  }, [queuePlayers, matchPlayerIds, activePlayerIds, selectedReplacement]);

  const totalCandidates =
    sameMatchCandidates.length + onDeckCandidates.length + queueCandidates.length;

  // ── Mixed-level check ─────────────────────────────────────────

  const isMixedAfterSwap = useMemo(() => {
    if (!match || !outgoingPlayer || !selectedReplacement) return false;
    // Build the new roster skill levels
    const levels = match.players
      .filter((p) => p.player_id !== outgoingPlayer.player_id)
      .map((p) => skillLevelToInt(p.profile.skill_level));
    levels.push(skillLevelToInt(selectedReplacement.skill_level as SkillLevel));
    const min = Math.min(...levels);
    const max = Math.max(...levels);
    return max - min > 1;
  }, [match, outgoingPlayer, selectedReplacement]);

  const teamLabel = outgoingTeam === "a" ? "Team A" : "Team B";

  if (!outgoingPlayer || !match) return null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="max-h-screen overflow-hidden flex flex-col bg-cc-bg-2 border-l border-cc-border p-0 w-full sm:max-w-md">
        {/* ── Header ───────────────────────────────────────────── */}
        <SheetHeader className="px-4 pt-4 pb-3 border-b border-cc-border shrink-0">
          <div className="flex items-center gap-2">
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{ background: "var(--cc-live)" }}
              aria-hidden="true"
            />
            <SheetTitle className="font-command text-[13px] uppercase tracking-[0.12em] text-cc-t1">
              Replace {outgoingPlayer.display_name}
            </SheetTitle>
          </div>
          <SheetDescription className="font-command text-[9px] uppercase tracking-[0.16em] text-cc-t3 mt-0.5">
            {match.court_id ? "Active Court" : "On-deck"} · {teamLabel} · Pick a replacement below
          </SheetDescription>
        </SheetHeader>

        {/* ── Scrollable body ───────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {totalCandidates === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
              <div className="rounded-full bg-cc-bg-3 p-3">
                <Users className="h-5 w-5 text-cc-t3" />
              </div>
              <p className="font-command text-[10px] uppercase tracking-[0.14em] text-cc-t3">
                No available players to swap in.
              </p>
            </div>
          ) : (
            <>
              {/* ── Section 1: Switch Teams ──────────────────────── */}
              {sameMatchCandidates.length > 0 && (
                <>
                  <SectionHeader label="Switch Teams" count={sameMatchCandidates.length} />
                  <div className="bg-cc-bg-2 divide-y divide-cc-border">
                    {sameMatchCandidates.map((c) => (
                      <CandidateRow
                        key={c.player_id}
                        name={c.display_name}
                        skillLevel={c.skill_level as SkillLevel}
                        sublabel="Mutual team swap · stays in match"
                        isSelected={selectedReplacement?.player_id === c.player_id}
                        onClick={() =>
                          onSelectReplacement(
                            selectedReplacement?.player_id === c.player_id ? null : c
                          )
                        }
                      />
                    ))}
                  </div>
                </>
              )}

              {/* ── Section 2: On-Deck ──────────────────────────── */}
              {onDeckCandidates.length > 0 && (
                <>
                  <SectionHeader label="On-Deck" count={onDeckCandidates.length} />
                  <div className="bg-cc-bg-2 divide-y divide-cc-border">
                    {onDeckCandidates.map((c) => (
                      <CandidateRow
                        key={c.player_id}
                        name={c.display_name}
                        skillLevel={c.skill_level as SkillLevel}
                        sublabel={`${c.onDeckLabel} · will need a fill player`}
                        isSelected={selectedReplacement?.player_id === c.player_id}
                        onClick={() =>
                          onSelectReplacement(
                            selectedReplacement?.player_id === c.player_id ? null : c
                          )
                        }
                      />
                    ))}
                  </div>
                </>
              )}

              {/* ── Section 3: Waiting Queue ─────────────────────── */}
              {queueCandidates.length > 0 && (
                <>
                  <SectionHeader label="Waiting Queue" count={queueCandidates.length} />
                  <div className="bg-cc-bg-2 divide-y divide-cc-border">
                    {queueCandidates.map((c) => {
                      const mins = Math.round(
                        (c as typeof c & { waitMinutes?: number }).waitMinutes ?? 0
                      );
                      return (
                        <CandidateRow
                          key={c.player_id}
                          name={c.display_name}
                          skillLevel={c.skill_level as SkillLevel}
                          sublabel={mins > 0 ? `${mins}m waiting` : "Just joined"}
                          isSelected={selectedReplacement?.player_id === c.player_id}
                          onClick={() =>
                            onSelectReplacement(
                              selectedReplacement?.player_id === c.player_id ? null : c
                            )
                          }
                        />
                      );
                    })}
                  </div>
                </>
              )}

              {/* ── Inline expansion: Fill on-deck hole ─────────── */}
              {selectedReplacement?.source === "ondeck" && (
                <div className="mt-2 border-t border-[var(--cc-live)]/20 bg-[var(--cc-live-dim)]">
                  <div className="px-4 pt-3 pb-1 flex items-center gap-2">
                    <ArrowLeftRight
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: "var(--cc-live)" }}
                      aria-hidden="true"
                    />
                    <span
                      className="font-command text-[9px] uppercase tracking-[0.18em]"
                      style={{ color: "var(--cc-live)" }}
                    >
                      Fill vacated on-deck slot
                    </span>
                    <span className="font-command text-[9px] text-cc-t3">(required)</span>
                  </div>

                  {fillCandidates.length === 0 ? (
                    <p className="px-4 pb-3 font-command text-[9px] uppercase tracking-[0.12em] text-cc-t3">
                      No queue players available.
                    </p>
                  ) : (
                    <div className="divide-y divide-cc-border/60">
                      {fillCandidates.map((f) => (
                        <button
                          key={f.player_id}
                          type="button"
                          onClick={() =>
                            onSelectFill(selectedFill?.player_id === f.player_id ? null : f)
                          }
                          className={[
                            "w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors",
                            selectedFill?.player_id === f.player_id
                              ? "bg-[var(--cc-live)]/15 outline outline-1 outline-[var(--cc-live)]/30"
                              : "hover:bg-[var(--cc-live)]/8 cursor-pointer",
                          ].join(" ")}
                        >
                          <span
                            className={[
                              "h-3.5 w-3.5 shrink-0 rounded-full border transition-colors",
                              selectedFill?.player_id === f.player_id
                                ? "bg-[var(--cc-live)] border-[var(--cc-live)]"
                                : "border-cc-border bg-transparent",
                            ].join(" ")}
                            aria-hidden="true"
                          />
                          <p className="font-command text-[12px] text-cc-t1 flex-1 truncate">
                            {f.display_name}
                          </p>
                          <SkillAbbr level={f.skill_level as SkillLevel} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Mixed-level warning ──────────────────────────── */}
              {isMixedAfterSwap && <MixedLevelWarning />}
            </>
          )}

          {/* ── Inline error ──────────────────────────────────────── */}
          {state.error && (
            <div
              className="mx-4 mt-3 clip-cut-sm border border-cc-red/30 bg-cc-red-dim
                         px-3 py-2 font-command text-[9px] uppercase tracking-[0.10em] text-cc-red"
            >
              {state.error}
            </div>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────────── */}
        <SheetFooter className="px-4 py-4 border-t border-cc-border shrink-0 gap-2">
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm || isSubmitting}
            className={[
              "flex-1 clip-cut-sm py-3 min-h-[44px]",
              "font-command text-[10px] uppercase tracking-[0.14em]",
              "transition-all",
              canConfirm && !isSubmitting
                ? "text-white hover:brightness-110"
                : "opacity-40 cursor-not-allowed text-cc-t2 bg-cc-bg-3 border border-cc-border",
            ].join(" ")}
            style={
              canConfirm && !isSubmitting
                ? { background: "var(--cc-live)", color: "white" }
                : undefined
            }
          >
            {isSubmitting ? "Swapping…" : "Confirm Swap"}
          </button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
