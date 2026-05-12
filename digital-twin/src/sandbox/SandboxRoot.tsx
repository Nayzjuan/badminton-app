// ─────────────────────────────────────────────────────────────────────────────
// SandboxRoot — final composition.
//
// Three-panel layout on desktop:
//   left   → SimulationFrame { Queue + MatchBoard }   (organizer view)
//   center → PlayerPhone                              (player view, phone frame)
//   right  → ActionLogger                             (event log)
//
// The PlayerPhone and the organizer panel share the same useSandbox state —
// actions on the left (Publish, Start Match) drive state transitions visible
// in real-time on the phone (ON DECK alert, PLAYING court view).
//
// Auto-play: cycles Alex through waiting→on_deck→playing→reset on a timer.
// Pauses when the user clicks anything in the organizer panel.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useState } from "react";
import { useSandbox } from "./state/useSandbox";
import { useAutoPlay } from "./player/useAutoPlay";
import { unlockAudio } from "./player/audio";
import type { Player } from "./state/types";
import SimulationFrame from "./components/SimulationFrame";
import QueuePanel from "./components/QueuePanel";
import MatchBoard from "./components/MatchBoard";
import ActionLogger from "./components/ActionLogger";
import PlayerPhone from "./player/PlayerPhone";

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
  const [autoPlayActive, setAutoPlayActive] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(false);

  // Auto-play drives Alex through the demo loop until the user interacts.
  useAutoPlay({ state, actions, enabled: autoPlayActive });

  // Pause auto-play when user interacts with the organizer panel.
  const pauseAutoPlay = useCallback(() => {
    if (autoPlayActive) setAutoPlayActive(false);
  }, [autoPlayActive]);

  // "+ add player" picks the first unused name and an alternating skill so
  // the pool stays balanced; falls back to a numbered handle if all names
  // are taken.
  const handleAddPlayer = useCallback(() => {
    const usedNames = new Set(Object.values(state.players).map((p) => p.name));
    const fresh = ADDITIONAL_NAMES.find((n) => !usedNames.has(n));
    const name = fresh ?? `Guest ${Object.keys(state.players).length + 1}`;
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
    <div className="flex flex-col gap-6">
      {/* ── Two-view header ── */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-accent dt-pulse"
              aria-hidden="true"
            />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-3">
              Organizer
            </span>
          </div>
          <span className="text-ink-4 font-mono text-[10px]">+</span>
          <div className="flex items-center gap-2">
            <span
              style={{ background: "oklch(78% 0.16 70)" }}
              className="inline-block h-1.5 w-1.5 rounded-full"
              aria-hidden="true"
            />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-3">
              Player view
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Sound toggle — unlocks AudioContext on first enable (browser autoplay policy) */}
          <button
            type="button"
            onClick={() => {
              const next = !soundEnabled;
              setSoundEnabled(next);
              if (next) unlockAudio();
            }}
            title={soundEnabled ? "Mute alerts" : "Enable alert sounds"}
            className="flex items-center gap-2 rounded-md border border-edge bg-raised px-3 py-1.5 font-mono text-[10px] transition-colors hover:border-edge-hi"
            style={{
              color: soundEnabled ? "oklch(78% 0.16 70)" : "oklch(48% 0.01 245)",
            }}
          >
            {soundEnabled ? "🔊" : "🔇"}
            <span>{soundEnabled ? "Sound on" : "Sound off"}</span>
          </button>

          {/* Auto-play toggle */}
          <button
            type="button"
            onClick={() => setAutoPlayActive((p) => !p)}
            className="flex items-center gap-2 rounded-md border border-edge bg-raised px-3 py-1.5 font-mono text-[10px] transition-colors hover:border-edge-hi"
            style={{
              color: autoPlayActive ? "oklch(76% 0.17 155)" : "oklch(48% 0.01 245)",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: autoPlayActive ? "oklch(76% 0.17 155)" : "oklch(32% 0.012 245)",
                flexShrink: 0,
                animation: autoPlayActive ? "dt-pulse 2s ease-in-out infinite" : "none",
              }}
            />
            {autoPlayActive ? "Auto-play on" : "Auto-play off"}
          </button>
        </div>
      </div>

      {/* ── Main 3-column layout ── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_auto_minmax(280px,340px)]">
        {/* ── Left: Organizer panel ── */}
        {/* Wrapping in a div with onClick pauses auto-play on any interaction */}
        <div className="min-w-0" onClick={pauseAutoPlay}>
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

        {/* ── Center: Player phone mockup — hidden below lg breakpoint ── */}
        <div
          className="hidden lg:flex"
          style={{
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
          }}
        >
          {/* Phone label */}
          <div
            className="flex items-center gap-2"
            style={{ alignSelf: "stretch", justifyContent: "center" }}
          >
            <span className="font-mono text-[10px] text-ink-4">Alex · player view</span>
          </div>

          <PlayerPhone state={state} soundEnabled={soundEnabled} />

          {/* Alex's status indicator below phone */}
          <div className="flex items-center gap-2">
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: alexStatusColor(state.players["p1"]?.status),
                flexShrink: 0,
              }}
            />
            <span className="font-mono text-[10px] text-ink-3">
              Alex:{" "}
              <span style={{ color: alexStatusColor(state.players["p1"]?.status) }}>
                {state.players["p1"]?.status ?? "—"}
              </span>
            </span>
          </div>
        </div>

        {/* ── Right: Action logger ── */}
        <aside className="min-w-0 lg:sticky lg:top-6 lg:self-start">
          <ActionLogger entries={state.log} onClear={actions.clearLog} />
        </aside>
      </div>
    </div>
  );
}

function alexStatusColor(status: string | undefined): string {
  switch (status) {
    case "waiting":
      return "oklch(48% 0.01 245)";
    case "drafted":
      return "oklch(70% 0.15 245)";
    case "on_deck":
      return "oklch(78% 0.16 70)";
    case "in_progress":
      return "oklch(76% 0.17 155)";
    default:
      return "oklch(32% 0.012 245)";
  }
}
