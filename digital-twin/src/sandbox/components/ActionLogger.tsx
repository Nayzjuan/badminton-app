// ─────────────────────────────────────────────────────────────────────────────
// ActionLogger — the right-column terminal-style console.
//
// Mirrors the structured log entries the reducer + engine emit. Each entry
// has a level-coloured prompt (engine = emerald accent, info = neutral,
// warn = amber, error = red) and a HH:mm:ss.sss timestamp.
//
// Auto-scroll: anchored to bottom unless the user has scrolled up (sticky-tail
// pattern). When new entries arrive while not at the bottom, a "↓ jump" pill
// appears.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, LogLevel } from "../state/types";

type Props = {
  entries: LogEntry[];
  onClear: () => void;
};

const levelTone: Record<LogLevel, { dot: string; text: string; prompt: string }> = {
  engine: { dot: "bg-accent", text: "text-accent-hi", prompt: ">" },
  info: { dot: "bg-ink-3", text: "text-ink-2", prompt: "·" },
  warn: { dot: "bg-warn", text: "text-warn", prompt: "⚠" },
  error: { dot: "bg-err", text: "text-err", prompt: "✗" },
  debug: { dot: "bg-ink-4", text: "text-ink-4", prompt: "·" },
};

const levelOrder: LogLevel[] = ["engine", "info", "warn", "error", "debug"];

function fmtTime(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export default function ActionLogger({ entries, onClear }: Props) {
  const [filter, setFilter] = useState<Set<LogLevel>>(
    new Set<LogLevel>(["engine", "info", "warn", "error", "debug"])
  );
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastEntryIdRef = useRef<string | null>(null);

  const visible = useMemo(() => entries.filter((e) => filter.has(e.level)), [entries, filter]);

  // Sticky-tail: when the user scrolls up, stop auto-scrolling. Resume when
  // they hit the bottom again.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setPinnedToBottom(distanceFromBottom < 8);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // useLayoutEffect prevents a visible "jump" — we scroll before paint.
  // Also re-evaluates pinnedToBottom whenever the visible list mutates
  // (filter chips, clear, etc.) so the "jump to latest" pill doesn't get
  // stuck after a content-size change.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const last = entries[entries.length - 1];
    const isNew = last && last.id !== lastEntryIdRef.current;
    if (last) lastEntryIdRef.current = last.id;
    if (isNew && pinnedToBottom) {
      el.scrollTop = el.scrollHeight;
    }
    // Refresh pinnedToBottom against the current scroll geometry — handles
    // the case where toggling a filter shrinks the list and moves the
    // bottom up under the user's scrollTop.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 8;
    if (atBottom !== pinnedToBottom) setPinnedToBottom(atBottom);
  }, [entries, visible.length, pinnedToBottom]);

  const toggleFilter = (level: LogLevel) => {
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setPinnedToBottom(true);
    }
  };

  return (
    <section className="dt-card flex h-full max-h-[calc(100vh-180px)] min-h-[420px] flex-col lg:max-h-[calc(100vh-140px)]">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-edge-dim px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <h3 className="font-heading text-sm font-bold text-ink">Action log</h3>
          <span className="font-mono text-[11px] text-ink-4 tabular-nums">
            {visible.length}/{entries.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="rounded-md border border-edge bg-raised px-2 py-0.5 font-mono text-[10px] text-ink-4 transition-colors hover:border-edge-hi hover:text-ink-3"
        >
          clear
        </button>
      </header>

      {/* Filter chips */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-edge-dim px-3 py-2">
        {levelOrder.map((level) => {
          const active = filter.has(level);
          const tone = levelTone[level];
          const count = entries.filter((e) => e.level === level).length;
          return (
            <button
              key={level}
              type="button"
              onClick={() => toggleFilter(level)}
              className={`flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                active
                  ? `border-edge bg-overlay ${tone.text}`
                  : "border-edge-dim bg-transparent text-ink-4 hover:border-edge"
              }`}
            >
              <span
                className={`inline-block h-1 w-1 rounded-full ${tone.dot}`}
                aria-hidden="true"
              />
              {level}
              <span className="tabular-nums opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Scroll body */}
      <div
        ref={scrollRef}
        className="relative flex-1 overflow-y-auto bg-base px-3 py-2 font-mono text-[11px] leading-relaxed"
      >
        {visible.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-ink-4">
            No log entries match the current filter.
          </p>
        ) : (
          // role="log" + aria-live="polite" so a screen reader announces new
          // entries without interrupting other speech. We also rely on it as
          // the implicit landmark for assistive tech navigating the page.
          <ol
            className="flex flex-col"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="Sandbox action log"
          >
            {visible.map((e) => {
              const tone = levelTone[e.level];
              return (
                <li key={e.id} className="grid grid-cols-[auto_auto_1fr] gap-2 py-0.5">
                  <span className="text-ink-4 tabular-nums">{fmtTime(e.ts)}</span>
                  <span className={`text-center ${tone.text}`} aria-hidden="true">
                    {tone.prompt}
                  </span>
                  <span className={tone.text}>
                    <span className="sr-only">{e.level}: </span>
                    {e.msg}
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {/* Jump-to-bottom pill — only when user scrolled up */}
        {!pinnedToBottom && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="sticky bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-accent-ring bg-accent-wash px-3 py-1 font-mono text-[10px] text-accent-hi shadow-lg transition-colors hover:border-accent hover:text-accent"
          >
            ↓ jump to latest
          </button>
        )}
      </div>

      {/* Footer status */}
      <footer className="flex shrink-0 items-center justify-between border-t border-edge-dim px-3 py-1.5 font-mono text-[9px] text-ink-4">
        <span>tail = {pinnedToBottom ? "live" : "paused"}</span>
        <span>memory · session-scoped</span>
      </footer>
    </section>
  );
}
