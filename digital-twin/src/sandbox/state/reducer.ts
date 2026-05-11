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

// ─────────────────────────────────────────────────────────────────────────────
// promoteOnDeck — mirrors promoteOnDeckMatchInternal in matchmaking.ts.
//
// When a court frees up (match ends or is cancelled), the real app
// automatically promotes the oldest published pending match to in_progress.
// This helper replicates that cascade so the sandbox behaves identically
// without any manual "start match" click from the user.
//
// Order: oldest createdAt first (matches real app's `ORDER BY created_at ASC`).
// Guard: only published (isPublished=true) pending matches are eligible —
//        same as the real `is_published=true` filter in promoteOnDeckMatchInternal.
// ─────────────────────────────────────────────────────────────────────────────
function promoteOnDeck(state: SandboxState): SandboxState {
  const eligible = state.matches
    .filter((m) => m.status === "pending" && m.isPublished)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (eligible.length === 0) {
    // Check whether unpublished drafts are holding up the queue —
    // mirrors the hasDraftsBlocking signal the real app surfaces.
    const hasDrafts = state.matches.some((m) => m.status === "draft");
    if (hasDrafts) {
      return withLog(state, {
        level: "warn",
        msg: "[engine] court freed — drafts are blocking the queue; publish drafts to continue",
      });
    }
    return withLog(state, {
      level: "engine",
      msg: "[engine] court freed — no on-deck match to promote",
    });
  }

  const toPromote = eligible[0];
  const allIds = [...toPromote.teamA, ...toPromote.teamB];
  const aNames = toPromote.teamA.map((id) => state.players[id]?.name ?? "?").join(" + ");
  const bNames = toPromote.teamB.map((id) => state.players[id]?.name ?? "?").join(" + ");

  // Defensive: skip if a roster player somehow left between publish and now.
  if (allIds.some((id) => state.players[id]?.status === "left")) {
    return withLog(state, {
      level: "warn",
      msg: `[engine] auto-promote skipped — a roster player in ${shortId(toPromote.id)} has left; cancel and regenerate`,
    });
  }

  const players = { ...state.players };
  allIds.forEach((id) => {
    const p = players[id];
    if (p) players[id] = { ...p, status: "in_progress" };
  });

  return withLog(
    {
      ...state,
      players,
      matches: state.matches.map((m) =>
        m.id === toPromote.id ? { ...m, status: "in_progress" } : m
      ),
    },
    {
      level: "engine",
      msg: `[engine] ✓ auto-promoted ${shortId(toPromote.id)} → in_progress (${aNames}  vs  ${bNames})`,
    }
  );
}

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
      // A player locked into a draft, on-deck, or active match cannot leave
      // without first cancelling that match — prevents dangling references.
      if (
        player.status === "drafted" ||
        player.status === "in_progress" ||
        player.status === "on_deck"
      ) {
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
      // Mark every player earmarked in a new draft as "drafted" so they are
      // excluded from the waiting pool on subsequent engine runs without
      // requiring the TypeScript-side committedSet workaround.
      const draftedIds = new Set(newMatches.flatMap((m) => [...m.teamA, ...m.teamB]));
      const players = { ...state.players };
      draftedIds.forEach((id) => {
        const p = players[id];
        if (p && p.status === "waiting") players[id] = { ...p, status: "drafted" };
      });
      const next = { ...state, players, matches: [...state.matches, ...newMatches] };
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
      // Transition: drafted → on_deck (mirrors the DB: publish sets status='on_deck')
      allIds.forEach((id) => {
        const p = players[id];
        if (p && p.status === "drafted") players[id] = { ...p, status: "on_deck" };
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
          msg: `[match] ${shortId(match.id)} published — 4 players drafted → on_deck`,
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
      const wasOnCourt = match.status === "in_progress";
      const players = { ...state.players };
      // Return players to waiting for all cancellable states:
      //   draft     → drafted players freed back to waiting pool
      //   pending   → on_deck players freed
      //   in_progress → playing players freed
      if (
        match.status === "draft" ||
        match.status === "pending" ||
        match.status === "in_progress"
      ) {
        [...match.teamA, ...match.teamB].forEach((id) => {
          const p = players[id];
          if (p && p.status !== "left") players[id] = { ...p, status: "waiting" };
        });
      }

      const cancelledState = withLog(
        {
          ...state,
          players,
          matches: state.matches.map((m) =>
            m.id === match.id ? { ...m, status: "cancelled" } : m
          ),
        },
        { level: "warn", msg: `[match] ${shortId(match.id)} cancelled` }
      );

      // Only trigger the court-free cascade when an active match is cancelled —
      // a draft or pending match was not occupying a court so there's nothing
      // to promote into. Mirrors cancelMatchAction which gates on match.court_id.
      if (!wasOnCourt) return cancelledState;

      // Step 2 — promote oldest on-deck match to the freed court.
      //   Mirrors: promoteOnDeckMatchInternal() in cancelMatchAction.
      const promotedState = promoteOnDeck(cancelledState);

      // Step 3 — refill the on-deck slot.
      //   Mirrors: runEngineForSession() after cancelMatchAction.
      const { newMatches, logs } = runMockEngine(promotedState);
      if (newMatches.length === 0 && logs.length === 0) return promotedState;
      return withLog(
        { ...promotedState, matches: [...promotedState.matches, ...newMatches] },
        ...logs
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

      // Step 1 — record the completed result and return players to the queue.
      const completedState = withLog(
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

      // Step 2 — promote oldest on-deck match to the freed court.
      //   Mirrors: promoteOnDeckMatchInternal() in endMatchAction.
      const promotedState = promoteOnDeck(completedState);

      // Step 3 — refill the on-deck slot with a new engine run.
      //   Mirrors: runEngineForSession() after endMatchAction.
      const { newMatches, logs } = runMockEngine(promotedState);
      if (newMatches.length === 0 && logs.length === 0) return promotedState;
      return withLog(
        { ...promotedState, matches: [...promotedState.matches, ...newMatches] },
        ...logs
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
