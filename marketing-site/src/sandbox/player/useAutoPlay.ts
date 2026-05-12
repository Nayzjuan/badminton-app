// ─────────────────────────────────────────────────────────────────────────────
// useAutoPlay — drives the player phone demo loop automatically.
//
// State machine (state-driven, not timer-driven):
//   waiting/paused  → generateMatches (after 1.5s)
//   drafted         → publishMatch    (after 1.5s)
//   on_deck         → startMatch      (after 4s   — lets the alert breathe)
//   in_progress     → reset           (after 5s   — lets court view register)
//   ↺ repeats from waiting
//
// The effect re-runs on every state change so each step is driven by the
// latest snapshot; cleanup cancels the pending timeout on each cycle.
// This means user interactions (which change state) naturally delay the
// next auto-play step — a deliberate grace period rather than a hard pause.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect } from "react";
import type { SandboxState } from "../state/types";
import type { SandboxActions } from "../state/useSandbox";

/** Player index 0 in the seed — always "Alex". */
export const YOU_ID = "p1";

function findAlexMatch(state: SandboxState, status: "draft" | "pending" | "in_progress") {
  return state.matches.find(
    (m) => m.status === status && ([...m.teamA, ...m.teamB] as string[]).includes(YOU_ID)
  );
}

export function useAutoPlay({
  state,
  actions,
  enabled,
}: {
  state: SandboxState;
  actions: SandboxActions;
  enabled: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;

    const alex = state.players[YOU_ID];
    if (!alex) return;

    let tid: ReturnType<typeof setTimeout>;

    switch (alex.status) {
      case "waiting":
      case "paused": {
        // Either generate a new draft OR publish one already waiting.
        const draft = findAlexMatch(state, "draft");
        if (draft) {
          tid = setTimeout(() => actions.publishMatch(draft.id), 1500);
        } else {
          tid = setTimeout(() => actions.generateMatches(), 1500);
        }
        break;
      }

      case "drafted": {
        const draft = findAlexMatch(state, "draft");
        if (draft) {
          tid = setTimeout(() => actions.publishMatch(draft.id), 1500);
        } else {
          // Draft was already published or cancelled externally — recover by
          // checking for a pending match (already published) or resetting.
          const pending = findAlexMatch(state, "pending");
          if (pending) {
            tid = setTimeout(() => actions.startMatch(pending.id), 1500);
          } else {
            tid = setTimeout(() => actions.reset(), 500);
          }
        }
        break;
      }

      case "on_deck": {
        const pending = findAlexMatch(state, "pending");
        if (pending) {
          // 4 seconds on the ON DECK screen — enough time to read it
          tid = setTimeout(() => actions.startMatch(pending.id), 4000);
        }
        break;
      }

      case "in_progress": {
        // 5 seconds showing the playing state, then loop
        tid = setTimeout(() => actions.reset(), 5000);
        break;
      }

      // "left" → reset to recover
      case "left": {
        tid = setTimeout(() => actions.reset(), 1000);
        break;
      }
    }

    return () => clearTimeout(tid);
    // Re-run whenever state changes (i.e. after every action) so the machine
    // always drives from the latest snapshot. `actions` is stable (useMemo'd).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, state]);
}
