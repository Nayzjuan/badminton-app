// ─────────────────────────────────────────────────────────────────────────────
// QueueRow — single sortable item in the organizer's queue.
//
// Drag handle is a dedicated button (not the whole row) so users can still
// click the pause/leave actions without accidentally starting a drag.
// ─────────────────────────────────────────────────────────────────────────────
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Player } from "../state/types";

const skillTone: Record<Player["skill"], string> = {
  beginner: "bg-overlay border-edge text-ink-3",
  intermediate: "bg-note-wash border-note/30 text-note",
  advanced: "bg-accent-wash border-accent-ring text-accent-hi",
};

const statusTone: Record<Player["status"], string> = {
  waiting: "text-ink-3",
  paused: "text-ink-4",
  on_deck: "text-warn",
  in_progress: "text-accent",
  left: "text-ink-4 line-through",
};

const statusLabel: Record<Player["status"], string> = {
  waiting: "waiting",
  paused: "paused",
  on_deck: "on deck",
  in_progress: "playing",
  left: "left",
};

function waitedFor(joinedAt: number) {
  const mins = Math.max(0, Math.floor((Date.now() - joinedAt) / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

type Props = {
  player: Player;
  position: number;
  onTogglePause: () => void;
  onLeave: () => void;
};

export default function QueueRow({ player, position, onTogglePause, onLeave }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: player.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : 0,
  };

  const isInQueue = player.status === "waiting" || player.status === "paused";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-3 rounded-lg border bg-overlay px-2 py-2 transition-colors duration-75 ${
        isDragging ? "border-accent-ring" : "border-edge-dim hover:border-edge"
      } ${player.status === "paused" ? "opacity-60" : ""}`}
    >
      {/* Drag handle — only for queueable players */}
      {isInQueue ? (
        <button
          type="button"
          aria-label={`Drag ${player.name}`}
          className="flex h-8 w-6 shrink-0 cursor-grab items-center justify-center rounded text-ink-4 transition-colors hover:bg-raised hover:text-ink-2 active:cursor-grabbing"
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
        <span className="flex h-8 w-6 shrink-0 items-center justify-center text-ink-4">·</span>
      )}

      {/* Position number */}
      <span className="w-6 shrink-0 font-mono text-[11px] tabular-nums text-ink-4">
        {String(position).padStart(2, "0")}
      </span>

      {/* Name + skill chip */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm font-medium text-ink-2 group-hover:text-ink">
          {player.name}
        </span>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${skillTone[player.skill]}`}
        >
          {player.skill.slice(0, 3)}
        </span>
      </div>

      {/* Wait time */}
      <span className="hidden font-mono text-[10px] text-ink-4 sm:inline">
        {waitedFor(player.joinedAt)}
      </span>

      {/* Status */}
      <span
        className={`shrink-0 font-mono text-[10px] uppercase tracking-wider ${statusTone[player.status]}`}
      >
        {statusLabel[player.status]}
      </span>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {isInQueue && (
          <button
            type="button"
            onClick={onTogglePause}
            title={player.status === "paused" ? "Unpause" : "Pause"}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-4 transition-colors hover:bg-raised hover:text-ink-2"
          >
            {player.status === "paused" ? (
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M2 1L9 5L2 9V1Z" />
              </svg>
            ) : (
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="1.5" y="1" width="2.5" height="8" />
                <rect x="6" y="1" width="2.5" height="8" />
              </svg>
            )}
          </button>
        )}
        {isInQueue && (
          <button
            type="button"
            onClick={onLeave}
            title="Check out"
            className="flex h-7 w-7 items-center justify-center rounded text-ink-4 transition-colors hover:bg-raised hover:text-warn"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              aria-hidden="true"
            >
              <path d="M2 2L8 8M8 2L2 8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
