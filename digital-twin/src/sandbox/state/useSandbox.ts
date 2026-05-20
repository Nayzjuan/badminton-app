// ─────────────────────────────────────────────────────────────────────────────
// useSandbox — React hook that wraps the reducer and exposes a fluent
// `actions` object so consumer components don't have to construct action
// objects by hand.
// ─────────────────────────────────────────────────────────────────────────────
import { useMemo, useReducer } from "react";
import type { Player } from "./types";
import { reducer } from "./reducer";
import { initialState } from "./seed";

export function useSandbox() {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState());

  // Memo so referential equality holds across renders — prevents spurious
  // re-renders when actions are passed as props to child components.
  const actions = useMemo(
    () => ({
      reset: () => dispatch({ type: "RESET" }),
      reorderQueue: (from: number, to: number) => dispatch({ type: "REORDER_QUEUE", from, to }),
      togglePause: (playerId: string) => dispatch({ type: "TOGGLE_PAUSE", playerId }),
      leaveQueue: (playerId: string) => dispatch({ type: "LEAVE_QUEUE", playerId }),
      joinQueue: (player: Player) => dispatch({ type: "JOIN_QUEUE", player }),
      generateMatches: () => dispatch({ type: "GENERATE_MATCHES" }),
      publishMatch: (matchId: string) => dispatch({ type: "PUBLISH_MATCH", matchId }),
      publishAllDrafts: () => dispatch({ type: "PUBLISH_ALL_DRAFTS" }),
      cancelMatch: (matchId: string) => dispatch({ type: "CANCEL_MATCH", matchId }),
      startMatch: (matchId: string) => dispatch({ type: "START_MATCH", matchId }),
      submitScore: (matchId: string, scoreA: number, scoreB: number) =>
        dispatch({ type: "SUBMIT_SCORE", matchId, scoreA, scoreB }),
      clearLog: () => dispatch({ type: "CLEAR_LOG" }),
      // `log` deliberately narrows LogLevel — "engine" is reserved for the
      // matchmaking engine output so the right-column logger can colour those
      // entries distinctively. UI components shouldn't synthesise engine logs.
      log: (msg: string, level: "info" | "warn" | "error" | "debug" = "info") =>
        dispatch({ type: "LOG", entry: { level, msg } }),
    }),
    []
  );

  return { state, actions };
}

export type SandboxActions = ReturnType<typeof useSandbox>["actions"];
