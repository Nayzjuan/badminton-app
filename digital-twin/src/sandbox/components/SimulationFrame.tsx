// ─────────────────────────────────────────────────────────────────────────────
// SimulationFrame — visual wrapper that signals "this is a sandbox, not real."
//
// Top tag with a pulsing dot + a small "live mock" indicator strip.
// Avoids the AI-template aesthetic (no glassmorphism, no left-border stripe,
// no gradient). Just a clean card with a corner label and a thin status rail.
// ─────────────────────────────────────────────────────────────────────────────
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  reset: () => void;
  config: {
    courts: number;
    maxAutoDrafts: number;
    maxPartnershipRepeats: number;
  };
};

export default function SimulationFrame({ children, reset, config }: Props) {
  return (
    <div className="relative rounded-2xl border border-edge bg-surface p-4 sm:p-5">
      {/* Corner tag */}
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-edge-dim pb-3">
        <div className="flex items-center gap-2.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-accent dt-pulse"
            aria-hidden="true"
          />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">
            simulation
          </span>
          <span className="font-mono text-[10px] text-ink-4">no real data · in-memory only</span>
        </div>
        <div className="flex items-center gap-3">
          {/* Config readout — mirrors the real app's organizer config bar */}
          <div className="hidden items-center gap-2 font-mono text-[10px] text-ink-4 sm:flex">
            <ConfigChip label="courts" value={config.courts} />
            <ConfigChip label="cap" value={config.maxAutoDrafts} />
            <ConfigChip label="partner cap" value={config.maxPartnershipRepeats} />
          </div>
          <button
            type="button"
            onClick={reset}
            title="Reset simulation"
            className="rounded-md border border-edge bg-raised px-2.5 py-1 font-mono text-[10px] text-ink-3 transition-colors hover:border-warn/40 hover:text-warn"
          >
            ↺ reset
          </button>
        </div>
      </div>

      {children}
    </div>
  );
}

function ConfigChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded border border-edge-dim bg-overlay px-1.5 py-0.5">
      <span className="text-ink-4">{label}=</span>
      <span className="text-ink-2 tabular-nums">{value}</span>
    </span>
  );
}
