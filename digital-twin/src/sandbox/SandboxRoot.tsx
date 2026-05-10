// ─────────────────────────────────────────────────────────────────────────────
// SandboxRoot — final composition.
//
// Two-column layout on desktop:
//   left  → SimulationFrame { Queue + MatchBoard }
//   right → ActionLogger
//
// On mobile both columns stack and the logger collapses below the mock app.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback } from "react";
import { useSandbox } from "./state/useSandbox";
import type { Player } from "./state/types";
import SimulationFrame from "./components/SimulationFrame";
import QueuePanel from "./components/QueuePanel";
import MatchBoard from "./components/MatchBoard";
import ActionLogger from "./components/ActionLogger";

// Pool of names used for "+ add player" — picks one not already in the players record.
const ADDITIONAL_NAMES = [
  "Kai",
  "Linh",
  "Mira",
  "Noor",
  "Omar",
  "Pia",
  "Quinn",
  "Rae",
  "Sam",
  "Tessa",
];

const SKILL_CYCLE: Player["skill"][] = ["beginner", "intermediate", "advanced"];

export default function SandboxRoot() {
  const { state, actions } = useSandbox();

  // "+ add player" picks the first unused name and an alternating skill so
  // the pool stays balanced; falls back to a numbered handle if all names
  // are taken.
  const handleAddPlayer = useCallback(() => {
    const usedNames = new Set(Object.values(state.players).map((p) => p.name));
    const fresh = ADDITIONAL_NAMES.find((n) => !usedNames.has(n));
    const name = fresh ?? `Guest ${Object.keys(state.players).length + 1}`;
    // randomUUID suffix — eliminates the rapid-double-click collision where
    // two clicks within the same render cycle would otherwise produce the
    // same id (the reducer's JOIN_QUEUE guard would catch it, but better to
    // never generate the duplicate in the first place).
    const idSuffix =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().slice(0, 6)
        : `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`;
    const id = `p_${idSuffix}`;
    const skill = SKILL_CYCLE[Object.keys(state.players).length % SKILL_CYCLE.length];
    actions.joinQueue({
      id,
      name,
      skill,
      status: "waiting",
      joinedAt: Date.now(),
      gamesPlayed: 0,
    });
  }, [state.players, actions]);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
      {/* ── Left column: Simulation frame containing the mock organizer app ── */}
      <div className="min-w-0">
        <SimulationFrame reset={actions.reset} config={state.config}>
          <div className="flex flex-col gap-4">
            <QueuePanel
              queueOrder={state.queueOrder}
              players={state.players}
              onReorder={actions.reorderQueue}
              onTogglePause={actions.togglePause}
              onLeave={actions.leaveQueue}
              onAddPlayer={handleAddPlayer}
              onGenerate={actions.generateMatches}
            />
            <MatchBoard matches={state.matches} players={state.players} actions={actions} />
          </div>
        </SimulationFrame>
      </div>

      {/* ── Right column: Action logger (sticky on desktop) ── */}
      <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
        <ActionLogger entries={state.log} onClear={actions.clearLog} />
      </aside>
    </div>
  );
}
