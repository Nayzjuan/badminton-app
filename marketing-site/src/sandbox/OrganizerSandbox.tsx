// ─────────────────────────────────────────────────────────────────────────────
// OrganizerSandbox — marketing demo island.
//
// Mirrors the digital twin's three-lane match board (Draft → On Deck → Active)
// and tap-to-swap player interaction. All state is in-memory; no backend.
//
// SECURITY CONTRACT (do not break):
//   ✗  No `use server` directive
//   ✗  No Supabase / createClient imports
//   ✗  No backend action imports
//   ✓  Pure client-side useReducer
//   ✓  Fake data, fake algorithm, visual only
// ─────────────────────────────────────────────────────────────────────────────
import { useReducer, useState, useEffect } from "react";
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

// Three-stage match lifecycle matching the real app's Draft Mode flow
type MatchStatus = "draft" | "on_deck" | "active" | "completed";

type Player = {
  id: string;
  name: string;
  skill: Skill;
  status: PlayerStatus;
  gamesPlayed: number;
};

type Match = {
  id: string;
  teamA: readonly [string, string];
  teamB: readonly [string, string];
  status: MatchStatus;
  createdAt: number; // used for auto-promote ordering (oldest on_deck promotes first)
  scoreA?: number;
  scoreB?: number;
};

// Identifies a specific player slot within a match (for tap-to-swap)
type SwapTarget = { matchId: string; team: "teamA" | "teamB"; idx: 0 | 1 };

type State = {
  players: Record<string, Player>;
  queue: string[]; // ordered player ids
  matches: Match[];
  matchCounter: number;
  swapPick: SwapTarget | null; // first tap in a swap interaction
};

type Action =
  | { type: "REORDER"; from: number; to: number }
  | { type: "GENERATE" }
  | { type: "PUBLISH"; matchId: string }
  | { type: "START"; matchId: string }
  | { type: "FINISH"; matchId: string; scoreA: number; scoreB: number }
  | { type: "CANCEL"; matchId: string }
  | { type: "SWAP_TAP"; target: SwapTarget }
  | { type: "SWAP_CANCEL" }
  | { type: "RESET" };

// ── Demo config — mirrors the real app defaults ───────────────────────────────
const COURTS = 2; // max concurrent active matches
const MAX_AUTO_DRAFTS = 2; // max (drafts + on_deck) at any time

// ── autoPromote — fills free courts from on_deck, oldest first ────────────────
// Mirrors promoteOnDeckMatchInternal in the real app. Fires after PUBLISH and
// FINISH so courts fill automatically without a manual "Start" click.
function autoPromote(state: State): State {
  const activeCount = state.matches.filter((m) => m.status === "active").length;
  const freeCourts = COURTS - activeCount;
  if (freeCourts <= 0) return state;

  const pending = state.matches
    .filter((m) => m.status === "on_deck")
    .sort((a, b) => a.createdAt - b.createdAt);

  if (pending.length === 0) return state;

  let s = state;
  for (const match of pending.slice(0, freeCourts)) {
    const players = { ...s.players };
    [...match.teamA, ...match.teamB].forEach((id) => {
      players[id] = { ...players[id], status: "playing" };
    });
    s = {
      ...s,
      players,
      matches: s.matches.map((m) => (m.id === match.id ? { ...m, status: "active" as const } : m)),
    };
  }
  return s;
}

// ── Seed data ─────────────────────────────────────────────────────────────────
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
  return { players, queue, matches: [], matchCounter: 0, swapPick: null };
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
      // Cap: (existing drafts + on_deck) must be < MAX_AUTO_DRAFTS to open slots.
      // Active courts don't count — they're already committed.
      const existingDrafts = state.matches.filter((m) => m.status === "draft").length;
      const existingOnDeck = state.matches.filter((m) => m.status === "on_deck").length;
      const slotsAvailable = MAX_AUTO_DRAFTS - (existingDrafts + existingOnDeck);
      if (slotsAvailable <= 0) return state;

      const waiting = state.queue.filter((id) => state.players[id]?.status === "waiting");
      if (waiting.length < 4) return state;

      // Generate as many drafts as slots allow, each consuming 4 players
      const newMatches: Match[] = [];
      let counter = state.matchCounter;
      const ts = Date.now();
      for (let i = 0; i < slotsAvailable; i++) {
        const pool = waiting.slice(i * 4, i * 4 + 4);
        if (pool.length < 4) break;
        counter++;
        newMatches.push({
          id: `m${counter}`,
          teamA: [pool[0], pool[1]],
          teamB: [pool[2], pool[3]],
          status: "draft",
          createdAt: ts + i, // small offset ensures stable oldest-first ordering
        });
      }
      if (newMatches.length === 0) return state;
      return { ...state, matches: [...state.matches, ...newMatches], matchCounter: counter };
    }

    case "PUBLISH": {
      const match = state.matches.find((m) => m.id === action.matchId);
      if (!match || match.status !== "draft") return state;
      const players = { ...state.players };
      [...match.teamA, ...match.teamB].forEach((id) => {
        players[id] = { ...players[id], status: "on_deck" };
      });
      const publishedState = {
        ...state,
        players,
        matches: state.matches.map((m) =>
          m.id === action.matchId ? { ...m, status: "on_deck" as const } : m
        ),
      };
      // Auto-promote: if a court is free, start this match immediately.
      // Mirrors promoteOnDeckMatchInternal in the real app.
      return autoPromote(publishedState);
    }

    case "START": {
      // Manual override — keep for edge cases but auto-promote handles the normal flow
      const match = state.matches.find((m) => m.id === action.matchId);
      if (!match || match.status !== "on_deck") return state;
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
      // Return players to the back of the queue
      const idSet = new Set(ids);
      const newQueue = [...state.queue.filter((id) => !idSet.has(id)), ...ids];
      const completedState = {
        ...state,
        players,
        queue: newQueue,
        matches: state.matches.map((m) =>
          m.id === action.matchId
            ? { ...m, status: "completed" as const, scoreA: action.scoreA, scoreB: action.scoreB }
            : m
        ),
      };
      // Auto-promote: court just freed — pull in the next on_deck match.
      // Mirrors promoteOnDeckMatchInternal in the real app's endMatchAction.
      return autoPromote(completedState);
    }

    case "CANCEL": {
      const match = state.matches.find((m) => m.id === action.matchId);
      if (!match) return state;
      const wasActive = match.status === "active";
      const players = { ...state.players };
      if (match.status === "on_deck" || match.status === "active") {
        [...match.teamA, ...match.teamB].forEach((id) => {
          players[id] = { ...players[id], status: "waiting" };
        });
      }
      const cancelledState = {
        ...state,
        players,
        matches: state.matches.filter((m) => m.id !== action.matchId),
        swapPick: null,
      };
      // Auto-promote only when an active match is cancelled (court freed).
      return wasActive ? autoPromote(cancelledState) : cancelledState;
    }

    case "SWAP_TAP": {
      const { target } = action;
      const existing = state.swapPick;

      // Same slot tapped again → cancel
      if (
        existing &&
        existing.matchId === target.matchId &&
        existing.team === target.team &&
        existing.idx === target.idx
      ) {
        return { ...state, swapPick: null };
      }

      // No pick yet → select this slot
      if (!existing) return { ...state, swapPick: target };

      // Execute swap: exchange the two player IDs
      const getId = (t: SwapTarget): string | null => {
        const m = state.matches.find((x) => x.id === t.matchId);
        if (!m) return null;
        return m[t.team][t.idx];
      };
      const idA = getId(existing);
      const idB = getId(target);
      if (!idA || !idB || idA === idB) return { ...state, swapPick: null };

      const matches = state.matches.map((m) => {
        if (m.id !== existing.matchId && m.id !== target.matchId) return m;
        const teamA = [...m.teamA] as [string, string];
        const teamB = [...m.teamB] as [string, string];

        if (m.id === existing.matchId && m.id === target.matchId) {
          // Intra-match swap
          (existing.team === "teamA" ? teamA : teamB)[existing.idx] = idB;
          (target.team === "teamA" ? teamA : teamB)[target.idx] = idA;
        } else if (m.id === existing.matchId) {
          (existing.team === "teamA" ? teamA : teamB)[existing.idx] = idB;
        } else {
          (target.team === "teamA" ? teamA : teamB)[target.idx] = idA;
        }
        return { ...m, teamA, teamB };
      });

      return { ...state, matches, swapPick: null };
    }

    case "SWAP_CANCEL":
      return { ...state, swapPick: null };

    default:
      return state;
  }
}

// ── Skill chip styles ─────────────────────────────────────────────────────────
const skillStyle: Record<Skill, string> = {
  beginner: "border-edge text-ink-4",
  intermediate: "border-note/30 text-note",
  advanced: "border-accent-ring text-accent-hi",
};

// ── SortablePlayerRow ─────────────────────────────────────────────────────────
function SortablePlayerRow({ player, position }: { player: Player; position: number | null }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: player.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const isQueueable = player.status === "waiting";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 rounded-lg border px-2 py-2 transition-colors duration-75 ${
        isDragging ? "border-accent-ring bg-raised" : "border-edge-dim bg-overlay hover:border-edge"
      }`}
    >
      {/* Drag handle — large hit area, always visible */}
      {isQueueable ? (
        <button
          type="button"
          aria-label={`Drag to reorder ${player.name}`}
          className="flex h-8 w-6 shrink-0 cursor-grab items-center justify-center rounded text-ink-3 transition-colors hover:bg-raised hover:text-ink-2 active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
            <circle cx="2" cy="2" r="1.2" />
            <circle cx="2" cy="7" r="1.2" />
            <circle cx="2" cy="12" r="1.2" />
            <circle cx="8" cy="2" r="1.2" />
            <circle cx="8" cy="7" r="1.2" />
            <circle cx="8" cy="12" r="1.2" />
          </svg>
        </button>
      ) : (
        <span className="flex h-8 w-6 shrink-0 items-center justify-center text-ink-4 font-mono text-xs">
          ·
        </span>
      )}

      {/* Position */}
      <span className="w-5 shrink-0 font-mono text-[10px] tabular-nums text-ink-4 text-right">
        {position !== null ? String(position).padStart(2, "0") : ""}
      </span>

      <span className="flex-1 min-w-0 text-sm font-medium text-ink-2 truncate">{player.name}</span>

      <span
        className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${skillStyle[player.skill]}`}
      >
        {player.skill.slice(0, 3)}
      </span>

      {player.status !== "waiting" && (
        <span
          className={`shrink-0 font-mono text-[9px] uppercase tracking-wider ${
            player.status === "on_deck" ? "text-warn" : "text-accent"
          }`}
        >
          {player.status === "on_deck" ? "deck" : "play"}
        </span>
      )}

      {player.gamesPlayed > 0 && player.status === "waiting" && (
        <span className="shrink-0 font-mono text-[10px] text-ink-4">{player.gamesPlayed}G</span>
      )}
    </div>
  );
}

// ── TeamSlot — player name, optionally tappable for swap ──────────────────────
function TeamSlot({
  id,
  players,
  target,
  swapPick,
  onSwapTap,
  swappable,
  align,
}: {
  id: string;
  players: Record<string, Player>;
  target: SwapTarget;
  swapPick: SwapTarget | null;
  onSwapTap: (t: SwapTarget) => void;
  swappable: boolean;
  align: "left" | "right";
}) {
  const name = players[id]?.name ?? "?";
  const isSelected =
    swapPick?.matchId === target.matchId &&
    swapPick?.team === target.team &&
    swapPick?.idx === target.idx;
  const isSwapMode = swapPick !== null;
  const alignClass = align === "right" ? "text-right" : "text-left";

  if (!swappable) {
    return (
      <span className={`text-sm font-semibold text-ink-2 truncate block ${alignClass}`}>
        {name}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSwapTap(target)}
      className={`rounded px-1 py-0.5 text-sm font-semibold truncate w-full transition-colors duration-75 ${alignClass} ${
        isSelected
          ? "bg-warn/10 text-warn ring-1 ring-warn/50"
          : isSwapMode
            ? "text-ink-2 hover:text-warn hover:bg-warn/5"
            : "text-ink-2 hover:text-accent hover:bg-accent/5"
      }`}
    >
      {name}
    </button>
  );
}

// ── Shared: teams grid used inside every match card ───────────────────────────
function TeamsGrid({
  match,
  players,
  swapPick,
  onSwapTap,
  swappable,
}: {
  match: Match;
  players: Record<string, Player>;
  swapPick: SwapTarget | null;
  onSwapTap: (t: SwapTarget) => void;
  swappable: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
      {/* Team A — right aligned */}
      <div className="flex flex-col gap-0.5">
        {match.teamA.map((id, i) => (
          <TeamSlot
            key={id}
            id={id}
            players={players}
            target={{ matchId: match.id, team: "teamA", idx: i as 0 | 1 }}
            swapPick={swapPick}
            onSwapTap={onSwapTap}
            swappable={swappable}
            align="right"
          />
        ))}
      </div>

      <span className="font-heading text-[10px] uppercase tracking-widest text-ink-4 px-0.5 text-center">
        vs
      </span>

      {/* Team B — left aligned */}
      <div className="flex flex-col gap-0.5">
        {match.teamB.map((id, i) => (
          <TeamSlot
            key={id}
            id={id}
            players={players}
            target={{ matchId: match.id, team: "teamB", idx: i as 0 | 1 }}
            swapPick={swapPick}
            onSwapTap={onSwapTap}
            swappable={swappable}
            align="left"
          />
        ))}
      </div>
    </div>
  );
}

// ── DraftCard ─────────────────────────────────────────────────────────────────
function DraftCard({
  match,
  players,
  onPublish,
  onCancel,
}: {
  match: Match;
  players: Record<string, Player>;
  onPublish: () => void;
  onCancel: () => void;
}) {
  const noop = () => {};
  return (
    <div className="rounded-lg border border-edge bg-overlay p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-ink-4">#{match.id}</span>
        <span className="rounded border border-edge bg-raised px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ink-3">
          draft
        </span>
      </div>

      <TeamsGrid
        match={match}
        players={players}
        swapPick={null}
        onSwapTap={noop}
        swappable={false}
      />

      <div className="flex gap-1.5 border-t border-edge-dim pt-2">
        <button
          type="button"
          onClick={onPublish}
          className="flex-1 rounded-md bg-accent py-1.5 font-mono text-xs font-medium transition-colors hover:bg-accent-hi"
          style={{ color: "var(--color-base)" }}
        >
          ▸ publish → call to court
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1.5 font-mono text-xs text-ink-4 transition-colors hover:text-ink-3"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

// ── OnDeckCard ────────────────────────────────────────────────────────────────
function OnDeckCard({
  match,
  players,
  swapPick,
  onSwapTap,
  onStart,
  onCancel,
}: {
  match: Match;
  players: Record<string, Player>;
  swapPick: SwapTarget | null;
  onSwapTap: (t: SwapTarget) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-lg border border-warn/25 bg-warn-wash/30 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-ink-4">#{match.id}</span>
        <span className="rounded border border-warn/30 bg-warn-wash px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-warn">
          on deck
        </span>
      </div>

      <TeamsGrid
        match={match}
        players={players}
        swapPick={swapPick}
        onSwapTap={onSwapTap}
        swappable
      />

      <div className="flex gap-1.5 border-t border-edge-dim pt-2">
        <button
          type="button"
          onClick={onStart}
          className="flex-1 rounded-md bg-accent py-1.5 font-mono text-xs font-medium transition-colors hover:bg-accent-hi"
          style={{ color: "var(--color-base)" }}
        >
          ▸ start match
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1.5 font-mono text-xs text-ink-4 transition-colors hover:text-ink-3"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

// ── ActiveCard ────────────────────────────────────────────────────────────────
function ActiveCard({
  match,
  players,
  swapPick,
  onSwapTap,
  onFinish,
  onCancel,
}: {
  match: Match;
  players: Record<string, Player>;
  swapPick: SwapTarget | null;
  onSwapTap: (t: SwapTarget) => void;
  onFinish: (scoreA: number, scoreB: number) => void;
  onCancel: () => void;
}) {
  const [scoreA, setScoreA] = useState("");
  const [scoreB, setScoreB] = useState("");
  const canSubmit = scoreA !== "" && scoreB !== "";

  const handleSubmit = () => {
    const sa = parseInt(scoreA, 10);
    const sb = parseInt(scoreB, 10);
    if (isNaN(sa) || isNaN(sb) || sa < 0 || sb < 0) return;
    onFinish(sa, sb);
  };

  return (
    <div className="rounded-lg border border-accent-ring/40 bg-accent/5 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-ink-4">#{match.id}</span>
        <span className="rounded border border-accent-ring/50 bg-accent-wash px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-accent-hi">
          ▶ playing
        </span>
      </div>

      <TeamsGrid
        match={match}
        players={players}
        swapPick={swapPick}
        onSwapTap={onSwapTap}
        swappable
      />

      {/* Score inputs */}
      <div className="flex items-center justify-center gap-2 border-t border-edge-dim pt-2">
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="–"
          value={scoreA}
          onChange={(e) => setScoreA(e.target.value.replace(/\D/g, "").slice(0, 2))}
          aria-label="Team A score"
          className="h-8 w-11 rounded border border-edge bg-base text-center font-mono text-sm font-bold text-accent-hi tabular-nums outline-none transition-colors focus:border-accent placeholder:text-ink-4"
        />
        <span className="font-mono text-xs text-ink-4">—</span>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="–"
          value={scoreB}
          onChange={(e) => setScoreB(e.target.value.replace(/\D/g, "").slice(0, 2))}
          aria-label="Team B score"
          className="h-8 w-11 rounded border border-edge bg-base text-center font-mono text-sm font-bold text-accent-hi tabular-nums outline-none transition-colors focus:border-accent placeholder:text-ink-4"
        />
      </div>

      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex-1 rounded-md bg-accent py-1.5 font-mono text-xs font-medium transition-colors hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-40"
          style={{ color: "var(--color-base)" }}
        >
          submit score
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2.5 py-1.5 font-mono text-xs text-ink-4 transition-colors hover:text-ink-3"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

// ── BoardColumn ───────────────────────────────────────────────────────────────
function BoardColumn({
  title,
  subtitle,
  count,
  tone,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  tone: "default" | "warn" | "accent";
  children: ReactNode;
}) {
  const headColor =
    tone === "accent" ? "text-accent-hi" : tone === "warn" ? "text-warn" : "text-ink-2";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-1 px-0.5">
        <div className="flex items-baseline gap-1.5">
          <h4 className={`font-heading text-xs font-bold uppercase tracking-wider ${headColor}`}>
            {title}
          </h4>
          <span className="font-mono text-[10px] tabular-nums text-ink-4">{count}</span>
        </div>
        <span className="text-[9px] uppercase tracking-wider text-ink-4">{subtitle}</span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

// ── EmptyLane ─────────────────────────────────────────────────────────────────
function EmptyLane({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-edge-dim bg-base/40 px-3 py-6 text-center text-[11px] text-ink-4 leading-relaxed">
      {children}
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

  // Esc dismisses swap mode
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "SWAP_CANCEL" });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Derived state
  const waitingCount = state.queue.filter((id) => state.players[id]?.status === "waiting").length;
  const onDeckPlayerCount = state.queue.filter(
    (id) => state.players[id]?.status === "on_deck"
  ).length;

  const drafts = state.matches.filter((m) => m.status === "draft");
  const onDeckMatches = state.matches.filter((m) => m.status === "on_deck");
  const activeMatches = state.matches.filter((m) => m.status === "active");
  const recent = [...state.matches.filter((m) => m.status === "completed")].reverse().slice(0, 3);

  const liveCount = drafts.length + onDeckMatches.length + activeMatches.length;

  // Generate is available whenever there are open draft slots AND enough waiting players.
  // Cap mirrors the real engine: (existingDrafts + onDeck) < MAX_AUTO_DRAFTS.
  const draftSlotsFree = MAX_AUTO_DRAFTS - (drafts.length + onDeckMatches.length);
  const canGenerate = waitingCount >= 4 && draftSlotsFree > 0;

  const generateTitle = !canGenerate
    ? draftSlotsFree <= 0
      ? "Draft queue full — publish or start a match to open a slot"
      : `Need ${Math.max(0, 4 - waitingCount)} more waiting player${Math.max(0, 4 - waitingCount) === 1 ? "" : "s"}`
    : "Generate a draft match";

  return (
    <div className="rounded-2xl border border-edge bg-surface p-4 sm:p-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 pb-3 border-b border-edge-dim">
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
          className="rounded-md border border-edge-hi bg-raised px-3 py-1 font-mono text-[10px] text-ink-3 hover:text-warn hover:border-warn/30 transition-colors"
        >
          ↺ reset
        </button>
      </div>

      {/* Swap mode banner */}
      {state.swapPick && (
        <div className="flex items-center justify-between gap-3 mb-4 rounded-lg border border-warn/30 bg-warn-wash/50 px-3 py-2">
          <span className="font-mono text-[11px] text-warn">
            ↕ Swap mode — tap another player to swap positions · Esc to cancel
          </span>
          <button
            type="button"
            onClick={() => dispatch({ type: "SWAP_CANCEL" })}
            className="shrink-0 font-mono text-sm text-warn hover:text-warn/70 transition-colors"
          >
            ×
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-5">
        {/* ── Left: Queue ── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <h4 className="font-heading text-xs font-bold uppercase tracking-wider text-ink-2">
                Player Queue
              </h4>
              <div className="flex items-center gap-2 font-mono text-[10px] text-ink-3">
                <span>
                  <span className="text-ink-2">{waitingCount}</span> waiting
                </span>
                {onDeckPlayerCount > 0 && (
                  <span>
                    <span className="text-warn">{onDeckPlayerCount}</span> on deck
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => dispatch({ type: "GENERATE" })}
              disabled={!canGenerate}
              title={generateTitle}
              className="shrink-0 rounded-md bg-accent px-3 py-1.5 font-mono text-xs font-medium transition-colors hover:bg-accent-hi disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: "var(--color-base)" }}
            >
              ▸ Generate
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

          <p className="text-[10px] text-ink-3 font-mono">
            ⠿ Drag to reorder · Engine picks top 4 waiting players
          </p>
        </div>

        {/* ── Right: Match Board ── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <h4 className="font-heading text-xs font-bold uppercase tracking-wider text-ink-2">
              Match Board
            </h4>
            <span className="font-mono text-[10px] text-ink-3">
              {liveCount} live
              {recent.length > 0 && ` · ${recent.length} completed`}
            </span>
          </div>

          {/* Swap hint */}
          {!state.swapPick && (onDeckMatches.length > 0 || activeMatches.length > 0) && (
            <p className="text-[10px] text-ink-4 font-mono -mt-1">
              Tap a player name to swap positions between matches
            </p>
          )}

          {/* Three-lane board */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <BoardColumn title="Drafts" subtitle="not visible" count={drafts.length} tone="default">
              {drafts.length === 0 ? (
                <EmptyLane>
                  Click <span className="text-accent">▸ Generate</span> to create a draft.
                </EmptyLane>
              ) : (
                drafts.map((m) => (
                  <DraftCard
                    key={m.id}
                    match={m}
                    players={state.players}
                    onPublish={() => dispatch({ type: "PUBLISH", matchId: m.id })}
                    onCancel={() => dispatch({ type: "CANCEL", matchId: m.id })}
                  />
                ))
              )}
            </BoardColumn>

            <BoardColumn
              title="On Deck"
              subtitle="published"
              count={onDeckMatches.length}
              tone="warn"
            >
              {onDeckMatches.length === 0 ? (
                <EmptyLane>Publish a draft to put a match on deck.</EmptyLane>
              ) : (
                onDeckMatches.map((m) => (
                  <OnDeckCard
                    key={m.id}
                    match={m}
                    players={state.players}
                    swapPick={state.swapPick}
                    onSwapTap={(t) => dispatch({ type: "SWAP_TAP", target: t })}
                    onStart={() => dispatch({ type: "START", matchId: m.id })}
                    onCancel={() => dispatch({ type: "CANCEL", matchId: m.id })}
                  />
                ))
              )}
            </BoardColumn>

            <BoardColumn
              title="Active"
              subtitle="on court"
              count={activeMatches.length}
              tone="accent"
            >
              {activeMatches.length === 0 ? (
                <EmptyLane>Start an on-deck match to fill a court.</EmptyLane>
              ) : (
                activeMatches.map((m) => (
                  <ActiveCard
                    key={m.id}
                    match={m}
                    players={state.players}
                    swapPick={state.swapPick}
                    onSwapTap={(t) => dispatch({ type: "SWAP_TAP", target: t })}
                    onFinish={(sa, sb) =>
                      dispatch({ type: "FINISH", matchId: m.id, scoreA: sa, scoreB: sb })
                    }
                    onCancel={() => dispatch({ type: "CANCEL", matchId: m.id })}
                  />
                ))
              )}
            </BoardColumn>
          </div>

          {/* Recent strip */}
          {recent.length > 0 && (
            <div className="border-t border-edge-dim pt-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-ink-4">
                Recent
              </div>
              <div className="flex flex-wrap gap-2">
                {recent.map((m) => {
                  const aNames = m.teamA.map((id) => state.players[id]?.name ?? "?").join(" + ");
                  const bNames = m.teamB.map((id) => state.players[id]?.name ?? "?").join(" + ");
                  return (
                    <div
                      key={m.id}
                      className="flex items-center gap-2 rounded border border-edge-dim bg-overlay px-2 py-1 font-mono text-[10px] text-ink-3"
                    >
                      <span className="text-ink-4">#{m.id}</span>
                      <span>{aNames}</span>
                      <span className="text-ink-4">vs</span>
                      <span>{bNames}</span>
                      {m.scoreA !== undefined && m.scoreB !== undefined && (
                        <span className="font-bold text-accent-hi">
                          {m.scoreA}–{m.scoreB}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
