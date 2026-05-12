// ─────────────────────────────────────────────────────────────────────────────
// MatchBoard — three-column lane view: Drafts · On Deck · Active.
//
// Completed and cancelled matches collapse into a "Recent" footer so the
// board stays focused on actionable state without losing history entirely.
// ─────────────────────────────────────────────────────────────────────────────
import type { Match, Player } from "../state/types";
import MatchCard from "./MatchCard";
import type { SandboxActions } from "../state/useSandbox";

type Props = {
  matches: Match[];
  players: Record<string, Player>;
  actions: SandboxActions;
};

export default function MatchBoard({ matches, players, actions }: Props) {
  const drafts = matches.filter((m) => m.status === "draft");
  const pending = matches.filter((m) => m.status === "pending");
  const inProgress = matches.filter((m) => m.status === "in_progress");
  const recent = matches
    .filter((m) => m.status === "completed" || m.status === "cancelled")
    .slice(-3) // last 3 only
    .reverse();

  const hasAnyDraft = drafts.length > 0;

  return (
    <section className="dt-card">
      <header className="flex items-center justify-between gap-3 border-b border-edge-dim px-4 py-3">
        <div className="flex items-baseline gap-3">
          <h3 className="font-heading text-sm font-bold text-ink">Match board</h3>
          <span className="font-mono text-[11px] text-ink-4">
            {(() => {
              const live = drafts.length + pending.length + inProgress.length;
              const done = matches.filter((m) => m.status === "completed").length;
              const cancelled = matches.filter((m) => m.status === "cancelled").length;
              const parts: string[] = [`${live} live`];
              if (done > 0) parts.push(`${done} done`);
              if (cancelled > 0) parts.push(`${cancelled} cancelled`);
              return parts.join(" · ");
            })()}
          </span>
        </div>
        {hasAnyDraft && (
          <button
            type="button"
            onClick={actions.publishAllDrafts}
            className="rounded-md border border-accent-ring bg-accent-wash px-2.5 py-1 font-mono text-[11px] text-accent-hi transition-colors hover:border-accent hover:text-accent"
          >
            ▸ publish all drafts ({drafts.length})
          </button>
        )}
      </header>

      <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-3">
        <Column title="Drafts" subtitle="invisible to players" count={drafts.length} tone="default">
          {drafts.length === 0 ? (
            <Empty>
              No drafts yet. Click <span className="text-accent">▸ generate matches</span>.
            </Empty>
          ) : (
            drafts.map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                players={players}
                onPublish={() => actions.publishMatch(m.id)}
                onCancel={() => actions.cancelMatch(m.id)}
                onStart={() => actions.startMatch(m.id)}
                onSubmitScore={(a, b) => actions.submitScore(m.id, a, b)}
              />
            ))
          )}
        </Column>

        <Column
          title="On deck"
          subtitle="published, awaiting court"
          count={pending.length}
          tone="warn"
        >
          {pending.length === 0 ? (
            <Empty>Publish a draft to put a match on deck.</Empty>
          ) : (
            pending.map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                players={players}
                onPublish={() => actions.publishMatch(m.id)}
                onCancel={() => actions.cancelMatch(m.id)}
                onStart={() => actions.startMatch(m.id)}
                onSubmitScore={(a, b) => actions.submitScore(m.id, a, b)}
              />
            ))
          )}
        </Column>

        <Column title="Active" subtitle="being played now" count={inProgress.length} tone="accent">
          {inProgress.length === 0 ? (
            <Empty>Start an on-deck match to fill a court.</Empty>
          ) : (
            inProgress.map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                players={players}
                onPublish={() => actions.publishMatch(m.id)}
                onCancel={() => actions.cancelMatch(m.id)}
                onStart={() => actions.startMatch(m.id)}
                onSubmitScore={(a, b) => actions.submitScore(m.id, a, b)}
              />
            ))
          )}
        </Column>
      </div>

      {/* Recent strip */}
      {recent.length > 0 && (
        <footer className="border-t border-edge-dim px-4 py-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-ink-4">
            Recent ({recent.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {recent.map((m) => {
              const aNames = m.teamA.map((id) => players[id]?.name ?? "?").join(" + ");
              const bNames = m.teamB.map((id) => players[id]?.name ?? "?").join(" + ");
              const score =
                m.status === "completed" && m.scoreA !== undefined && m.scoreB !== undefined
                  ? `${m.scoreA}–${m.scoreB}`
                  : "cancelled";
              return (
                <div
                  key={m.id}
                  className="flex items-center gap-2 rounded border border-edge-dim bg-overlay px-2 py-1 font-mono text-[10px] text-ink-3"
                >
                  <span className="text-ink-4">#{m.id.slice(-4)}</span>
                  <span>{aNames}</span>
                  <span className="text-ink-4">vs</span>
                  <span>{bNames}</span>
                  <span className="font-bold text-accent-hi">{score}</span>
                </div>
              );
            })}
          </div>
        </footer>
      )}
    </section>
  );
}

function Column({
  title,
  subtitle,
  count,
  tone,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  tone: "default" | "accent" | "warn";
  children: React.ReactNode;
}) {
  const headTone =
    tone === "accent" ? "text-accent-hi" : tone === "warn" ? "text-warn" : "text-ink-2";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <div className="flex items-baseline gap-2">
          <h4 className={`font-heading text-xs font-bold uppercase tracking-wider ${headTone}`}>
            {title}
          </h4>
          <span className="font-mono text-[10px] tabular-nums text-ink-4">{count}</span>
        </div>
        <span className="hidden text-[9px] uppercase tracking-wider text-ink-4 sm:inline">
          {subtitle}
        </span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-edge-dim bg-base/40 px-3 py-6 text-center text-[11px] text-ink-4">
      {children}
    </div>
  );
}
