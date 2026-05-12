// ─────────────────────────────────────────────────────────────────────────────
// MatchCard — single match in the board.
//
// Renders teams + status-specific actions:
//   draft       → publish · cancel
//   pending     → start   · cancel
//   in_progress → score inputs · submit · cancel
//   completed   → final score readout
//   cancelled   → terminal state, no actions
// ─────────────────────────────────────────────────────────────────────────────
import { useState } from "react";
import type { Match, Player } from "../state/types";

type Props = {
  match: Match;
  players: Record<string, Player>;
  onPublish: () => void;
  onCancel: () => void;
  onStart: () => void;
  onSubmitScore: (a: number, b: number) => void;
};

const statusBadge: Record<Match["status"], { label: string; tone: string }> = {
  draft: { label: "draft", tone: "border-edge bg-raised text-ink-3" },
  pending: { label: "on deck", tone: "border-warn/30 bg-warn-wash text-warn" },
  in_progress: {
    label: "playing",
    tone: "border-accent-ring bg-accent-wash text-accent-hi",
  },
  completed: { label: "completed", tone: "border-edge-dim bg-overlay text-ink-3" },
  cancelled: { label: "cancelled", tone: "border-err/30 bg-err-wash text-err" },
};

function names(team: Match["teamA"], players: Record<string, Player>) {
  return team.map((id) => players[id]?.name ?? "?");
}

export default function MatchCard({
  match,
  players,
  onPublish,
  onCancel,
  onStart,
  onSubmitScore,
}: Props) {
  const [scoreA, setScoreA] = useState<string>("");
  const [scoreB, setScoreB] = useState<string>("");

  const badge = statusBadge[match.status];
  const a = names(match.teamA, players);
  const b = names(match.teamB, players);
  const isTerminal = match.status === "completed" || match.status === "cancelled";

  const handleSubmit = () => {
    const sa = Number(scoreA);
    const sb = Number(scoreB);
    if (!Number.isFinite(sa) || !Number.isFinite(sb) || sa < 0 || sb < 0) return;
    onSubmitScore(sa, sb);
  };

  return (
    <article
      className={`flex flex-col gap-2 rounded-lg border bg-overlay p-3 transition-colors ${
        isTerminal ? "border-edge-dim opacity-70" : "border-edge"
      }`}
    >
      {/* Header: id + status */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-ink-4">
          #{match.id.slice(-4)} · {match.origin}
        </span>
        <span
          className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${badge.tone}`}
        >
          {badge.label}
        </span>
      </div>

      {/* Teams */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="flex flex-col text-right">
          <span className="text-sm font-medium text-ink-2">{a[0]}</span>
          <span className="text-sm font-medium text-ink-2">{a[1]}</span>
        </div>
        <span className="font-heading text-[10px] uppercase tracking-widest text-ink-4">vs</span>
        <div className="flex flex-col text-left">
          <span className="text-sm font-medium text-ink-2">{b[0]}</span>
          <span className="text-sm font-medium text-ink-2">{b[1]}</span>
        </div>
      </div>

      {/* Score readout for completed */}
      {match.status === "completed" && match.scoreA !== undefined && match.scoreB !== undefined && (
        <div className="flex items-center justify-center gap-3 border-t border-edge-dim pt-2 font-mono text-base font-bold text-accent-hi tabular-nums">
          <span>{match.scoreA}</span>
          <span className="text-ink-4">—</span>
          <span>{match.scoreB}</span>
        </div>
      )}

      {/* Score inputs for in_progress */}
      {match.status === "in_progress" && (
        <div className="flex items-center justify-center gap-2 border-t border-edge-dim pt-2">
          <ScoreInput value={scoreA} onChange={setScoreA} ariaLabel="Team A score" />
          <span className="font-mono text-xs text-ink-4">—</span>
          <ScoreInput value={scoreB} onChange={setScoreB} ariaLabel="Team B score" />
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-edge-dim pt-2">
        {match.status === "draft" && (
          <>
            <ActionBtn onClick={onPublish} variant="accent">
              publish
            </ActionBtn>
            <ActionBtn onClick={onCancel} variant="ghost">
              cancel
            </ActionBtn>
          </>
        )}
        {match.status === "pending" && (
          <>
            <ActionBtn onClick={onStart} variant="accent">
              start match
            </ActionBtn>
            <ActionBtn onClick={onCancel} variant="ghost">
              cancel
            </ActionBtn>
          </>
        )}
        {match.status === "in_progress" && (
          <>
            <ActionBtn onClick={handleSubmit} variant="accent" disabled={!scoreA || !scoreB}>
              submit score
            </ActionBtn>
            <ActionBtn onClick={onCancel} variant="ghost">
              cancel
            </ActionBtn>
          </>
        )}
        {isTerminal && (
          <span className="font-mono text-[10px] text-ink-4">terminal — no actions</span>
        )}
      </div>
    </article>
  );
}

function ScoreInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      aria-label={ariaLabel}
      placeholder="–"
      value={value}
      onChange={(e) => {
        const next = e.currentTarget.value.replace(/[^0-9]/g, "").slice(0, 2);
        onChange(next);
      }}
      className="h-8 w-12 rounded border border-edge bg-base text-center font-mono text-sm font-bold tabular-nums text-accent-hi outline-none transition-colors focus:border-accent placeholder:text-ink-4"
    />
  );
}

function ActionBtn({
  onClick,
  children,
  variant = "default",
  disabled = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  variant?: "default" | "accent" | "ghost";
  disabled?: boolean;
}) {
  const tone =
    variant === "accent"
      ? "border-accent-ring bg-accent-wash text-accent-hi hover:border-accent hover:text-accent"
      : variant === "ghost"
        ? "border-transparent bg-transparent text-ink-4 hover:text-ink-3"
        : "border-edge bg-raised text-ink-3 hover:border-edge-hi hover:text-ink-2";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {children}
    </button>
  );
}
