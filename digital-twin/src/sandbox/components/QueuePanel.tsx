// ─────────────────────────────────────────────────────────────────────────────
// QueuePanel — sortable queue list.
//
// Wraps QueueRow children in a DndContext + SortableContext. Drag is
// constrained to the vertical axis with a small distance threshold so a
// click on action buttons doesn't accidentally start a drag.
// ─────────────────────────────────────────────────────────────────────────────
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { Player } from "../state/types";
import QueueRow from "./QueueRow";

type Props = {
  queueOrder: string[];
  players: Record<string, Player>;
  onReorder: (from: number, to: number) => void;
  onTogglePause: (playerId: string) => void;
  onLeave: (playerId: string) => void;
  onAddPlayer: () => void;
  onGenerate: () => void;
};

export default function QueuePanel({
  queueOrder,
  players,
  onReorder,
  onTogglePause,
  onLeave,
  onAddPlayer,
  onGenerate,
}: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const fromIdx = queueOrder.indexOf(String(active.id));
    const toIdx = queueOrder.indexOf(String(over.id));
    if (fromIdx === -1 || toIdx === -1) return;
    onReorder(fromIdx, toIdx);
  };

  const waitingCount = queueOrder.filter((id) => players[id]?.status === "waiting").length;
  const draftedCount = queueOrder.filter((id) => players[id]?.status === "drafted").length;
  const pausedCount = queueOrder.filter((id) => players[id]?.status === "paused").length;
  const onDeckCount = queueOrder.filter((id) => players[id]?.status === "on_deck").length;

  return (
    <section className="dt-card overflow-visible">
      {/* Header */}
      <header className="flex items-center justify-between gap-3 border-b border-edge-dim px-4 py-3">
        <div className="flex items-baseline gap-3">
          <h3 className="font-heading text-sm font-bold text-ink">Queue</h3>
          <div className="flex items-center gap-3 font-mono text-[11px] text-ink-4">
            <span>
              <span className="text-ink-2">{waitingCount}</span> waiting
            </span>
            {draftedCount > 0 && (
              <span>
                <span className="text-ink-2">{draftedCount}</span> drafted
              </span>
            )}
            {pausedCount > 0 && (
              <span>
                <span className="text-ink-2">{pausedCount}</span> paused
              </span>
            )}
            {onDeckCount > 0 && (
              <span>
                <span className="text-warn">{onDeckCount}</span> on deck
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onAddPlayer}
            className="rounded-md border border-edge bg-raised px-2.5 py-1 font-mono text-[11px] text-ink-3 transition-colors hover:border-edge-hi hover:text-ink-2"
          >
            + add player
          </button>
          <button
            type="button"
            onClick={onGenerate}
            className="rounded-md border border-accent-ring bg-accent-wash px-3 py-1 font-mono text-[11px] font-medium text-accent-hi transition-colors hover:border-accent hover:bg-accent-wash hover:text-accent"
          >
            ▸ generate matches
          </button>
        </div>
      </header>

      {/* List */}
      <div className="px-2 py-2">
        {queueOrder.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-ink-4">
            Queue is empty. Click <span className="text-ink-3">+ add player</span> to seed someone.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={queueOrder} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col gap-1">
                {queueOrder.map((id, i) => {
                  const player = players[id];
                  if (!player) return null;
                  return (
                    <li key={id}>
                      <QueueRow
                        player={player}
                        position={i + 1}
                        onTogglePause={() => onTogglePause(id)}
                        onLeave={() => onLeave(id)}
                      />
                    </li>
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </section>
  );
}
