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

/** Organizer-facing label + sub-line for each state (font-command microcopy). */
export const HELD_STATE_META: Record<
  Exclude<HeldState, "none">,
  { label: string; tone: "violet" | "emerald" }
> = {
  holding: { label: "HOLDING", tone: "violet" },
  resting: { label: "RESTING", tone: "violet" },
  ready: { label: "READY", tone: "emerald" },
};
