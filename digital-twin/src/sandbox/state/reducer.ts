// ─────────────────────────────────────────────────────────────────────────────
// Sandbox reducer — pure function (state, action) → state.
//
// All log emission flows through `withLog` so the action logger gets a
// consistent stream. The reducer never throws; invalid actions become no-ops
// with a warn-level log entry where useful.
// ─────────────────────────────────────────────────────────────────────────────
import type { LogEntry, SandboxAction, SandboxState } from "./types";
import { pairKey } from "./types";
import { initialState } from "./seed";
import { runMockEngine } from "../engine/mockMatchmaking";

// Log IDs use crypto.randomUUID() so the reducer stays pure (no module-scoped
// counter). The fallback handles older Safari/test envs where randomUUID isn't
// available — Math.random + ts is collision-resistant enough for an in-memory
// session-scoped log.
function makeLog(entry: Omit<LogEntry, "id" | "ts">): LogEntry {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `l_${crypto.randomUUID().slice(0, 8)}`
      : `l_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return { ...entry, id, ts: Date.now() };
}

function withLog(state: SandboxState, ...entries: Omit<LogEntry, "id" | "ts">[]): SandboxState {
  if (entries.length === 0) return state;
  return { ...state, log: [...state.log, ...entries.map(makeLog)] };
}

const shortId = (id: string) => id.slice(-4);

export function reducer(state: SandboxState, action: SandboxAction): SandboxState {
  switch (action.type) {
    // ── Reset ────────────────────────────────────────────────────────────────
    case "RESET":
      return initialState();

    // ── Queue mutations ──────────────────────────────────────────────────────
    case "REORDER_QUEUE": {
      const { from, to } = action;
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= state.queueOrder.length ||
        to >= state.queueOrder.length
      ) {
        return state;
      }
      const next = [...state.queueOrder];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      const name = state.players[moved]?.name ?? moved;
      return withLog(
        { ...state, queueOrder: next },
        { level: "info", msg: `[queue] reordered: ${name} → position ${to + 1}` }
      );
    }

    case "TOGGLE_PAUSE": {
      const player = state.players[action.playerId];
      if (!player) return state;
      // Only meaningful for players in the queue (waiting/paused).
      if (player.status !== "waiting" && player.status !== "paused") {
        return withLog(state, {
          level: "warn",
          msg: `[queue] ${player.name} cannot toggle pause — current status: ${player.status}`,
        });
      }
      const newStatus = player.status === "paused" ? "waiting" : "paused";
      return withLog(
        {
          ...state,
          players: { ...state.players, [player.id]: { ...player, status: newStatus } },
        },
        {
          level: "info",
          msg: `[queue] ${player.name} ${newStatus === "paused" ? "paused" : "unpaused"}`,
        }
      );
    }

    case "LEAVE_QUEUE": {
      const player = state.players[action.playerId];
      if (!player) return state;
      // A player locked into an active or pending match cannot leave without
      // first cancelling that match — prevents dangling references that
      // START_MATCH / SUBMIT_SCORE would have to clean up.
      if (player.status === "in_progress" || player.status === "on_deck") {
        return withLog(state, {
          level: "warn",
          msg: `[queue] ${player.name} cannot leave — currently ${player.status}; cancel the match first`,
        });
      }
      return withLog(
        {
          ...state,
          players: { ...state.players, [player.id]: { ...player, status: "left" } },
          queueOrder: state.queueOrder.filter((id) => id !== player.id),
        },
        { level: "info", msg: `[queue] ${player.name} checked out` }
      );
    }

    case "JOIN_QUEUE": {
      const p = action.player;
      if (state.players[p.id]) {
        return withLog(state, {
          level: "warn",
          msg: `[queue] join ignored — player id ${p.id} already exists`,
        });
      }
      return withLog(
        {
          ...state,
          players: { ...state.players, [p.id]: p },
          queueOrder: [...state.queueOrder, p.id],
        },
        { level: "info", msg: `[queue] ${p.name} joined the queue` }
      );
    }

    // ── Match lifecycle ──────────────────────────────────────────────────────
    case "GENERATE_MATCHES": {
      const { newMatches, logs } = runMockEngine(state);
      const next = { ...state, matches: [...state.matches, ...newMatches] };
      return withLog(next, ...logs);
    }

    case "PUBLISH_MATCH": {
      const match = state.matches.find((m) => m.id === action.matchId);
      if (!match) return state;
      if (match.status !== "draft") {
        return withLog(state, {
          level: "warn",
          msg: `[match] ${shortId(match.id)} not a draft — publish ignored`,
        });
      }
      const players = { ...state.players };
      const allIds = [...match.teamA, ...match.teamB];
      // Refuse to publish if any player has left the queue (mirrors BUG-002 fix).
      const hasLeftPlayer = allIds.some((id) => players[id]?.status === "left");
      if (hasLeftPlayer) {
        return withLog(state, {
          level: "error",
          msg: `[match] ${shortId(match.id)} cannot publish — at least one player has left the queue`,
        });
      }
      allIds.forEach((id) => {
        const p = players[id];
        if (p) players[id] = { ...p, status: "on_deck" };
      });
      return withLog(
        {
          ...state,
          players,
          matches: state.matches.map((m) =>
            m.id === match.id ? { ...m, status: "pending", isPublished: true } : m
          ),
        },
        {
          level: "info",
          msg: `[match] ${shortId(match.id)} published — 4 players → on_deck`,
        }
      );
    }

    case "PUBLISH_ALL_DRAFTS": {
      const drafts = state.matches.filter((m) => m.status === "draft");
      if (drafts.length === 0) {
        return withLog(state, {
          level: "warn",
          msg: "[match] no drafts to publish",
        });
      }
      // Apply each publish sequentially through the reducer to reuse all guards.
      let next = state;
      for (const d of drafts) {
        next = reducer(next, { type: "PUBLISH_MATCH", matchId: d.id });
      }
      return next;
    }

    case "CANCEL_MATCH": {
      const match = state.matches.find((m) => m.id === action.matchId);
      if (!match) return state;
      if (match.status === "completed" || match.status === "cancelled") {
        return withLog(state, {
          level: "warn",
          msg: `[match] ${shortId(match.id)} already terminal — cancel ignored`,
        });
      }
      const players = { ...state.players };
      // If the match was published or in progress, return its players to the queue.
      if (match.status === "pending" || match.status === "in_progress") {
        [...match.teamA, ...match.teamB].forEach((id) => {
          const p = players[id];
          if (p && p.status !== "left") players[id] = { ...p, status: "waiting" };
        });
      }
      return withLog(
        {
          ...state,
          players,
          matches: state.matches.map((m) =>
            m.id === match.id ? { ...m, status: "cancelled" } : m
          ),
        },
        { level: "warn", msg: `[match] ${shortId(match.id)} cancelled` }
      );
    }

    case "START_MATCH": {
      const match = state.matches.find((m) => m.id === action.matchId);
      if (!match) return state;
      if (match.status !== "pending") {
        return withLog(state, {
          level: "warn",
          msg: `[match] ${shortId(match.id)} not pending — start ignored`,
        });
      }
      const players = { ...state.players };
      const allIds = [...match.teamA, ...match.teamB];
      // Mirrors PUBLISH_MATCH guard: refuse to start if any roster player has
      // checked out between publish and start (real-app BUG-002 hazard).
      if (allIds.some((id) => players[id]?.status === "left")) {
        return withLog(state, {
          level: "error",
          msg: `[match] ${shortId(match.id)} cannot start — a roster player has left the queue`,
        });
      }
      allIds.forEach((id) => {
        const p = players[id];
        if (p) players[id] = { ...p, status: "in_progress" };
      });
      return withLog(
        {
          ...state,
          players,
          matches: state.matches.map((m) =>
            m.id === match.id ? { ...m, status: "in_progress" } : m
          ),
        },
        { level: "info", msg: `[match] ${shortId(match.id)} started — 4 players → in_progress` }
      );
    }

    case "SUBMIT_SCORE": {
      const { matchId, scoreA, scoreB } = action;
      const match = state.matches.find((m) => m.id === matchId);
      if (!match) return state;
      if (match.status !== "in_progress") {
        return withLog(state, {
          level: "warn",
          msg: `[match] ${shortId(match.id)} not in progress — score ignored`,
        });
      }
      if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA < 0 || scoreB < 0) {
        return withLog(state, {
          level: "error",
          msg: `[match] ${shortId(match.id)} invalid scores: ${scoreA}-${scoreB}`,
        });
      }

      const players = { ...state.players };
      const partnershipCounts = { ...state.partnershipCounts };
      const playersInMatch = [...match.teamA, ...match.teamB];

      // Return players to waiting + bump games_played.
      playersInMatch.forEach((id) => {
        const p = players[id];
        if (p && p.status !== "left") {
          players[id] = { ...p, status: "waiting", gamesPlayed: p.gamesPlayed + 1 };
        }
      });

      // Increment partnership counters (drives the cap).
      const keyA = pairKey(match.teamA[0], match.teamA[1]);
      const keyB = pairKey(match.teamB[0], match.teamB[1]);
      partnershipCounts[keyA] = (partnershipCounts[keyA] ?? 0) + 1;
      partnershipCounts[keyB] = (partnershipCounts[keyB] ?? 0) + 1;

      // Re-add players to the back of the queue so they cycle naturally.
      const playersInMatchSet = new Set(playersInMatch);
      const newQueueOrder = [
        ...state.queueOrder.filter((id) => !playersInMatchSet.has(id)),
        ...playersInMatch.filter((id) => players[id]?.status === "waiting"),
      ];

      const winner = scoreA > scoreB ? "A" : scoreB > scoreA ? "B" : "tie";

      return withLog(
        {
          ...state,
          players,
          partnershipCounts,
          queueOrder: newQueueOrder,
          matches: state.matches.map((m) =>
            m.id === match.id ? { ...m, status: "completed", scoreA, scoreB } : m
          ),
        },
        {
          level: "info",
          msg: `[match] ${shortId(match.id)} → completed (${scoreA}-${scoreB}, ${winner === "tie" ? "tied" : `team ${winner} wins`})`,
        },
        {
          level: "debug",
          msg: `[partnerships] ${keyA}=${partnershipCounts[keyA]}, ${keyB}=${partnershipCounts[keyB]}`,
        }
      );
    }

    // ── Log control ──────────────────────────────────────────────────────────
    case "CLEAR_LOG":
      return {
        ...state,
        log: [
          {
            id: `l_clear_${Date.now().toString(36)}`,
            ts: Date.now(),
            level: "info",
            msg: "[log] cleared",
          },
        ],
      };

    case "LOG":
      return withLog(state, action.entry);

    default: {
      // Exhaustiveness check — TypeScript will flag unhandled cases at compile time.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
