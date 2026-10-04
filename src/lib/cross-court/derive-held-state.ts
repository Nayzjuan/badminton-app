// ============================================================
// Cross-Court Diversity Drafting — held-draft view state (Phase 7)
// ============================================================
// Pure mapping from a held draft's data to the 3-state lifecycle the organizer
// sees on the on-deck card. Extracted as a pure function so the state logic is
// unit-tested WITHOUT rendering (the React card just renders the result).
//
//   HOLDING → pulled body still playing on its court (held_ready_at unset,
//             source match still in_progress)
//   RESTING → body's game ended; serving the 1-match rest gap (not yet stamped)
//   READY   → held_ready_at stamped & due → promotable now
//   NONE    → not a held draft (a normal on-deck draft / match)
// ============================================================

export type HeldState = "none" | "holding" | "resting" | "ready";

export type HeldStateInput = {
  /** matches.is_held — true iff pulled_player_ids is non-empty. */
  isHeld: boolean;
  /** matches.held_ready_at — non-null once readiness is stamped. */
  heldReadyAt: string | null;
  /**
   * Is the pulled body's source match still in_progress? The card derives this by
   * checking whether pulled_from_match_id is among the active (in_progress) courts.
   */
  sourceStillPlaying: boolean;
};

export function deriveHeldState(input: HeldStateInput): HeldState {
  if (!input.isHeld) return "none";
  if (input.heldReadyAt !== null) return "ready";
  if (input.sourceStillPlaying) return "holding";
  return "resting";
}

/**
 * Is this held draft still waiting on its pulled body — i.e. NOT publishable?
 *
 * This is the single definition of the publish rule. Every layer that has to
 * agree on it CALLS this rather than re-spelling it; do not maintain a list of
 * them here, it will rot — `grep -rn "isHeldAwaitingReadiness" src/` is the
 * list. There is exactly one deliberate exception, `matchmaking-db.ts`'s
 * unready-hold count, and it says at the call site why it spells the predicate
 * out instead. The DB enforces the same rule independently in `publish_match` /
 * `publish_all_drafts` — see migration
 * `20260816000000_publish_never_touches_an_unready_held_draft`. ⚠️ The SQL
 * spelling is NOT identical: `NOT (is_held IS TRUE AND held_ready_at IS NULL)`
 * is the same partition in three-valued logic, not the same characters.
 *
 * Why `held_ready_at IS NULL` is the whole test, and not `deriveHeldState`:
 * publishing an unready held draft is useless in BOTH of its unready states, for
 * two different reasons, and the stamp is what distinguishes them from READY.
 *   • HOLDING (body still on court) — `publish_match`'s conflict check counts the
 *     body's `in_progress` match and returns CONFLICT. It cannot succeed.
 *   • RESTING (source ended, not yet stamped) — it CAN succeed, and that is worse:
 *     the roster flips to `on_deck` and gets an ON_DECK_WARNING push, but
 *     `promoteOnDeckMatchInternal` filters on `held_ready_at !== null`, so the
 *     match sits on deck un-promotable until a lifecycle event stamps it.
 * `deriveHeldState` needs `sourceStillPlaying` to tell those two apart, which is
 * exactly the input this predicate does not need — so it does not take it.
 */
export function isHeldAwaitingReadiness(input: {
  /** matches.is_held */
  is_held: boolean;
  /** matches.held_ready_at */
  held_ready_at: string | null;
}): boolean {
  return input.is_held === true && input.held_ready_at === null;
}

/** Organizer-facing label + sub-line for each state (font-command microcopy). */
export const HELD_STATE_META: Record<
  Exclude<HeldState, "none">,
  { label: string; tone: "violet" | "emerald" }
> = {
  holding: { label: "HOLDING", tone: "violet" },
  resting: { label: "RESTING", tone: "violet" },
  ready: { label: "READY", tone: "emerald" },
};

/**
 * Milliseconds remaining on the rest fallback. Null when we have no
 * source.completed_at (do not invent a clock). 0 once the window has elapsed.
 */
export function restRemainingMs(input: {
  sourceCompletedAt: string | null;
  now: number;
  restFallbackMs: number;
}): number | null {
  if (!input.sourceCompletedAt) return null;
  const done = new Date(input.sourceCompletedAt).getTime();
  if (Number.isNaN(done)) return null;
  return Math.max(0, done + input.restFallbackMs - input.now);
}

/** mm:ss for the RESTING countdown chip. */
export function formatRestCountdown(remainingMs: number): string {
  const totalSec = Math.ceil(remainingMs / 1000);
  const clamped = Math.max(0, totalSec);
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export type HeldQueueChip = {
  state: "holding" | "resting";
  pulledName: string | null;
};

/**
 * Queue-row chips for players parked on an unpublished unready hold.
 * READY holds stay the ordinary "Drafted" chip.
 */
export function heldQueueChipsForDrafts(
  drafts: Array<{
    is_held: boolean;
    held_ready_at: string | null;
    pulled_player_ids: string[] | null;
    pulled_from_match_id: string | null;
    players: Array<{ player_id: string; profile?: { display_name?: string | null } | null }>;
  }>,
  inProgressMatchIds: ReadonlySet<string>
): Map<string, HeldQueueChip> {
  const map = new Map<string, HeldQueueChip>();
  for (const draft of drafts) {
    if (!draft.is_held || draft.held_ready_at !== null) continue;
    const state = deriveHeldState({
      isHeld: true,
      heldReadyAt: null,
      sourceStillPlaying:
        draft.pulled_from_match_id != null && inProgressMatchIds.has(draft.pulled_from_match_id),
    });
    if (state !== "holding" && state !== "resting") continue;
    const pulledId = draft.pulled_player_ids?.[0] ?? null;
    const pulledName =
      draft.players.find((p) => p.player_id === pulledId)?.profile?.display_name ?? null;
    for (const seat of draft.players) {
      map.set(seat.player_id, { state, pulledName });
    }
  }
  return map;
}
