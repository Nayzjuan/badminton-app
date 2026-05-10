// ─────────────────────────────────────────────────────────────────────────────
// OrganizerSandbox — marketing demo island.
//
// SECURITY CONTRACT (do not break):
//   ✗  No `use server` directive
//   ✗  No Supabase / createClient imports
//   ✗  No backend action imports
//   ✗  No ActionLogger / engine narration
//   ✓  Pure client-side useReducer
//   ✓  Fake data, fake algorithm, visual only
// ─────────────────────────────────────────────────────────────────────────────
import { useReducer } from "react";
import type { ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";

// ── Types ─────────────────────────────────────────────────────────────────────
type Skill = "beginner" | "intermediate" | "advanced";
type PlayerStatus = "waiting" | "on_deck" | "playing";

type Player = {
  id: string;
  name: string;
  skill: Skill;
  status: PlayerStatus;
  gamesPlayed: number;
};

type MatchStatus = "pending" | "active";

type Match = {
  id: string;
  teamA: readonly [string, string];
  teamB: readonly [string, string];
  status: MatchStatus;
};

type State = {
  players: Record<string, Player>;
  queue: string[]; // ordered player ids
  matches: Match[];
  matchCounter: number; // monotonic — lives in state so reducer stays pure
};

type Action =
  | { type: "REORDER"; from: number; to: number }
  | { type: "GENERATE" }
  | { type: "START"; matchId: string }
  | { type: "FINISH"; matchId: string }
  | { type: "RESET" };

// ── Seed data ────────────────────────────────────────────────────────────────
const SEED: ReadonlyArray<{ name: string; skill: Skill }> = [
  { name: "Alex", skill: "intermediate" },
  { name: "Bria", skill: "advanced" },
  { name: "Carlos", skill: "beginner" },
  { name: "Dani", skill: "intermediate" },
  { name: "Esmé", skill: "advanced" },
  { name: "Fariq", skill: "beginner" },
  { name: "Gita", skill: "intermediate" },
  { name: "Hiro", skill: "intermediate" },
];

function mkInitialState(): State {
  const players: Record<string, Player> = {};
  const queue: string[] = [];
  SEED.forEach((s, i) => {
    const id = `p${i + 1}`;
    players[id] = { id, name: s.name, skill: s.skill, status: "waiting", gamesPlayed: 0 };
    queue.push(id);
  });
  return { players, queue, matches: [], matchCounter: 0 };
}

// ── Reducer ───────────────────────────────────────────────────────────────────
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "RESET":
      return mkInitialState();

    case "REORDER": {
      const { from, to } = action;
      if (from === to) return state;
      const next = [...state.queue];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...state, queue: next };
    }

    case "GENERATE": {
      // Pick first 4 waiting players in queue order.
      const waiting = state.queue.filter((id) => state.players[id]?.status === "waiting");
      if (waiting.length < 4) return state;

      // Hard cap: max 2 pending/active matches visible at once.
      const live = state.matches.filter((m) => m.status === "pending" || m.status === "active");
      if (live.length >= 2) return state;

      const [a0, a1, b0, b1] = waiting;
      const nextCounter = state.matchCounter + 1;
      const match: Match = {
        id: `m${nextCounter}`,
        teamA: [a0, a1],
        teamB: [b0, b1],
        status: "pending",
      };

      const players = { ...state.players };
      [a0, a1, b0, b1].forEach((id) => {
        players[id] = { ...players[id], status: "on_deck" };
      });

      return { ...state, players, matches: [...state.matches, match], matchCounter: nextCounter };
    }

    case "START": {
      const match = state.matches.find((m) => m.id === action.matchId);
      if (!match || match.status !== "pending") return state;

      const players = { ...state.players };
      [...match.teamA, ...match.teamB].forEach((id) => {
        players[id] = { ...players[id], status: "playing" };
      });

      return {
        ...state,
        players,
        matches: state.matches.map((m) =>
          m.id === action.matchId ? { ...m, status: "active" } : m
        ),
      };
    }

    case "FINISH": {
      const match = state.matches.find((m) => m.id === action.matchId);
      if (!match || match.status !== "active") return state;

      const players = { ...state.players };
      const ids = [...match.teamA, ...match.teamB];
      ids.forEach((id) => {
        players[id] = {
          ...players[id],
          status: "waiting",
          gamesPlayed: players[id].gamesPlayed + 1,
        };
      });

      // Return players to back of queue.
      const idSet = new Set(ids);
      const newQueue = [...state.queue.filter((id) => !idSet.has(id)), ...ids];

      return {
        ...state,
        players,
        queue: newQueue,
        matches: state.matches.filter((m) => m.id !== action.matchId),
      };
    }

    default:
      return state;
  }
}

// ── Skill chip styles ─────────────────────────────────────────────────────────
const skillStyle: Record<Skill, string> = {
  beginner: "border-edge    text-ink-4",
  intermediate: "border-note/30 text-note",
  advanced: "border-accent-ring text-accent-hi",
};

// ── SortablePlayerRow ─────────────────────────────────────────────────────────
function SortablePlayerRow({
  player,
  position,
}: {
  player: Player;
  position: number | null; // null for on_deck / playing — not in the waiting line
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: player.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    position: "relative",
    zIndex: isDragging ? 10 : undefined,
  };

  const isQueueable = player.status === "waiting";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-75 ${
        isDragging ? "border-accent-ring bg-raised" : "border-edge-dim bg-overlay hover:border-edge"
      }`}
    >
      {/* Drag handle */}
      {isQueueable ? (
        <button
          type="button"
          aria-label={`Reorder ${player.name}`}
          className="cursor-grab active:cursor-grabbing text-ink-4 hover:text-ink-3 flex-shrink-0"
          {...attributes}
          {...listeners}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
            <circle cx="2" cy="2.5" r="1.2" />
            <circle cx="2" cy="7" r="1.2" />
            <circle cx="2" cy="11.5" r="1.2" />
            <circle cx="8" cy="2.5" r="1.2" />
            <circle cx="8" cy="7" r="1.2" />
            <circle cx="8" cy="11.5" r="1.2" />
          </svg>
        </button>
      ) : (
        <span className="w-[10px] flex-shrink-0" />
      )}

      <span className="w-5 text-[10px] font-mono text-ink-4 tabular-nums text-right flex-shrink-0">
        {position !== null ? String(position).padStart(2, "0") : "·"}
      </span>

      <span className="flex-1 min-w-0 text-sm font-medium text-ink-2 truncate">{player.name}</span>

      <span
        className={`flex-shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${skillStyle[player.skill]}`}
      >
        {player.skill.slice(0, 3)}
      </span>

      {player.status !== "waiting" && (
        <span
          className={`flex-shrink-0 font-mono text-[9px] uppercase tracking-wider ${
            player.status === "on_deck" ? "text-warn" : "text-accent"
          }`}
        >
          {player.status === "on_deck" ? "on deck" : "playing"}
        </span>
      )}

      {player.gamesPlayed > 0 && player.status === "waiting" && (
        <span className="flex-shrink-0 font-mono text-[10px] text-ink-4">
          {player.gamesPlayed}G
        </span>
      )}
    </div>
  );
}

// ── MatchCard ─────────────────────────────────────────────────────────────────
function MatchCard({
  match,
  players,
  onStart,
  onFinish,
}: {
  match: Match;
  players: Record<string, Player>;
  onStart: () => void;
  onFinish: () => void;
}) {
  const aNames = match.teamA.map((id) => players[id]?.name ?? "?");
  const bNames = match.teamB.map((id) => players[id]?.name ?? "?");
  const isActive = match.status === "active";

  return (
    <div
      className={`rounded-xl border p-4 transition-colors duration-150 ${
        isActive ? "border-accent-ring bg-accent-wash/40" : "border-edge bg-overlay"
      }`}
    >
      {/* Status badge */}
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[10px] text-ink-4">Court #{match.id.slice(1)}</span>
        <span
          className={`rounded border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
            isActive
              ? "border-accent-ring/50 bg-accent-wash text-accent-hi"
              : "border-warn/30 bg-warn-wash text-warn"
          }`}
        >
          {isActive ? "▶ playing" : "on deck"}
        </span>
      </div>

      {/* Teams */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 mb-4">
        <div className="space-y-0.5 min-w-0">
          {aNames.map((n, i) => (
            <p key={i} className="text-sm font-semibold text-ink-2 text-right truncate">
              {n}
            </p>
          ))}
        </div>
        <span className="font-heading text-xs uppercase tracking-widest text-ink-4 px-1 flex-shrink-0">
          vs
        </span>
        <div className="space-y-0.5 min-w-0">
          {bNames.map((n, i) => (
            <p key={i} className="text-sm font-semibold text-ink-2 text-left truncate">
              {n}
            </p>
          ))}
        </div>
      </div>

      {/* Action */}
      {!isActive ? (
        <button
          type="button"
          onClick={onStart}
          className="w-full rounded-lg border border-accent-ring bg-accent-wash py-2 font-mono text-xs font-medium text-accent-hi transition-colors hover:border-accent hover:text-accent"
        >
          ▸ Start Match
        </button>
      ) : (
        <button
          type="button"
          onClick={onFinish}
          className="w-full rounded-lg border border-edge bg-raised py-2 font-mono text-xs text-ink-3 transition-colors hover:border-edge-hi hover:text-ink-2"
        >
          ✓ Finish & Return Players
        </button>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function OrganizerSandbox() {
  const [state, dispatch] = useReducer(reducer, undefined, mkInitialState);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = state.queue.indexOf(String(active.id));
    const to = state.queue.indexOf(String(over.id));
    if (from !== -1 && to !== -1) dispatch({ type: "REORDER", from, to });
  };

  const waitingCount = state.queue.filter((id) => state.players[id]?.status === "waiting").length;
  const liveMatches = state.matches.filter((m) => m.status === "pending" || m.status === "active");
  const canGenerate = waitingCount >= 4 && liveMatches.length < 2;

  return (
    <div className="rounded-2xl border border-edge bg-surface p-5 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5 pb-4 border-b border-edge-dim">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-accent">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-accent dt-pulse"
              aria-hidden="true"
            />
            live demo
          </span>
          <h3 className="font-heading font-bold text-sm text-ink">Organizer Dashboard</h3>
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: "RESET" })}
          className="rounded-md border border-edge bg-raised px-3 py-1 font-mono text-[10px] text-ink-3 hover:text-warn hover:border-warn/30 transition-colors"
        >
          ↺ reset
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ── Left: Queue ── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <h4 className="font-heading text-xs font-bold uppercase tracking-wider text-ink-2">
                Player Queue
              </h4>
              <span className="font-mono text-[10px] text-ink-4 tabular-nums">
                {waitingCount} waiting
              </span>
            </div>
            <button
              type="button"
              onClick={() => dispatch({ type: "GENERATE" })}
              disabled={!canGenerate}
              className="rounded-md border border-accent-ring bg-accent-wash px-3 py-1.5 font-mono text-xs font-medium text-accent-hi transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              ▸ Generate Match
            </button>
          </div>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={state.queue} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-1">
                {(() => {
                  // Compute waiting-only rank so position numbers reflect the
                  // actual queue position, not the visual row index (which
                  // includes on_deck / playing rows that don't count as waiting).
                  let waitingRank = 0;
                  return state.queue.map((id) => {
                    const player = state.players[id];
                    if (!player) return null;
                    const pos = player.status === "waiting" ? ++waitingRank : null;
                    return <SortablePlayerRow key={id} player={player} position={pos} />;
                  });
                })()}
              </div>
            </SortableContext>
          </DndContext>

          <p className="text-[10px] text-ink-4 font-mono mt-1">
            Drag ⠿ to reorder · Engine picks top 4 waiting players
          </p>
        </div>

        {/* ── Right: Match Board ── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <h4 className="font-heading text-xs font-bold uppercase tracking-wider text-ink-2">
              Match Board
            </h4>
            <span className="font-mono text-[10px] text-ink-4 tabular-nums">
              {liveMatches.length}/2 courts
            </span>
          </div>

          {liveMatches.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center rounded-xl border border-dashed border-edge-dim bg-base/40 py-12 px-6 text-center">
              <p className="text-ink-4 text-sm mb-1">No matches yet</p>
              <p className="text-ink-4 text-[11px] font-mono">
                Click <span className="text-accent">▸ Generate Match</span> to create one
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {liveMatches.map((m) => (
                <MatchCard
                  key={m.id}
                  match={m}
                  players={state.players}
                  onStart={() => dispatch({ type: "START", matchId: m.id })}
                  onFinish={() => dispatch({ type: "FINISH", matchId: m.id })}
                />
              ))}
            </div>
          )}

          {/* Hint when both courts are full */}
          {liveMatches.length >= 2 && (
            <p className="text-[10px] text-ink-4 font-mono">
              Both courts occupied · Finish a match to generate the next one
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
