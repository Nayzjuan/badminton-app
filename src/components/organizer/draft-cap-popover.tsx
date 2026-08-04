"use client";

// ============================================================
// DraftCapPopover — Max-draft cap selector for the organizer header
// ============================================================
// A compact chip sitting next to the Auto toggle. Clicking it
// opens a popover with:
//   • Dynamic   — engine scales cap automatically (3/5/6 by pool size)
//   • 1–5       — explicit organizer ceiling
//
// The chip itself shows only the active value ("Dynamic" or the
// number), not the full list. This keeps the header uncluttered.
//
// Loading states while a cap reset is in progress:
//   'clearing'   → chip shows "⟳ Clearing…"
//   'generating' → chip shows "⟳ Generating…"
//   Both disable the chip and the popover cannot open.
//
// The phase is authored SERVER-side (applyDraftCapOverride emits it on the
// session broadcast channel) and reaches this chip through
// useOrganizerDashboard, so a co-organizer's reset disables it too.
//
// The chip is dimmed (not hidden) when Auto is OFF so the
// organizer can see their saved preference.
// ============================================================

import { useRef, useState, useEffect } from "react";
import type { CapPhase } from "@/hooks/use-organizer-session";

// ── Props ─────────────────────────────────────────────────────

interface DraftCapPopoverProps {
  /** Current stored override. null = Dynamic. */
  value: number | null;
  /** Whether auto-matchmaking is currently ON. */
  autoIsOn: boolean;
  /**
   * Whether auto-publish mode is ON. The same cap column means different things
   * by mode (D2): the review-queue size in draft mode vs the live on-deck queue
   * size in auto-publish mode. Only the label/copy swaps — the value does not.
   */
  autoPublishIsOn?: boolean;
  /** Phase of an in-progress cap-reset. null = idle. */
  capPhase: CapPhase;
  /**
   * Called when the organizer picks a new cap value. Async in practice
   * (it runs a server action); the returned promise settles on its own and
   * is deliberately not awaited here — the chip's loading state comes from
   * `capPhase`, not from this call.
   */
  onChange: (cap: number | null) => void | Promise<void>;
  /** Whether to render the mobile-compact variant (no caret label). */
  compact?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────

function chipLabel(value: number | null): string {
  return value === null ? "Dynamic" : String(value);
}

function chipLabelCompact(value: number | null): string {
  return value === null ? "DYN" : String(value);
}

const CAP_OPTIONS: Array<{ label: string; sub?: string; value: number | null }> = [
  { label: "Dynamic", sub: "Auto-scales", value: null },
  { label: "1", value: 1 },
  { label: "2", value: 2 },
  { label: "3", value: 3 },
  { label: "4", value: 4 },
  { label: "5", value: 5 },
];

// ── Component ─────────────────────────────────────────────────

export function DraftCapPopover({
  value,
  autoIsOn,
  autoPublishIsOn = false,
  capPhase,
  onChange,
  compact = false,
}: DraftCapPopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const isLoading = capPhase === "clearing" || capPhase === "generating";
  const isDisabled = isLoading || !autoIsOn;

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  function handleSelect(cap: number | null) {
    setOpen(false);
    if (cap !== value) void onChange(cap);
  }

  // ── Chip rendering ────────────────────────────────────────

  const chipBase = [
    "inline-flex items-center gap-[5px]",
    "font-command text-[9px] uppercase tracking-[0.13em]",
    "border transition-all",
    compact ? "px-2 py-0 h-[28px]" : "px-[10px] py-0 h-[28px]",
    "clip-path-[polygon(0_0,calc(100%_-_5px)_0,100%_5px,100%_100%,5px_100%,0_calc(100%_-_5px))]",
  ];

  if (isLoading) {
    return (
      <button
        disabled
        data-testid="draft-cap-chip"
        data-cap-phase={capPhase}
        className={[
          ...chipBase,
          "border-cc-border-hi bg-cc-bg-3 text-cc-t2 cursor-not-allowed gap-[7px]",
        ].join(" ")}
        style={{
          clipPath:
            "polygon(0 0,calc(100% - 5px) 0,100% 5px,100% 100%,5px 100%,0 calc(100% - 5px))",
        }}
      >
        <span className="inline-block h-[9px] w-[9px] shrink-0 rounded-full border border-current border-t-transparent animate-spin" />
        <span>{capPhase === "clearing" ? "Clearing…" : "Generating…"}</span>
      </button>
    );
  }

  const isDynamic = value === null;

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        onClick={() => !isDisabled && setOpen((v) => !v)}
        disabled={isDisabled}
        data-testid="draft-cap-chip"
        data-cap-phase="idle"
        title={
          !autoIsOn
            ? "Turn on Auto matchmaking to change the cap"
            : autoPublishIsOn
              ? "Set how many published matches to keep On Deck at once"
              : "Set maximum number of auto-generated drafts"
        }
        className={[
          ...chipBase,
          isDisabled
            ? "opacity-30 cursor-not-allowed border-cc-border bg-cc-bg-3 text-cc-t3"
            : open
              ? "border-cc-border-hi bg-cc-bg-3 text-cc-t1"
              : "border-cc-border bg-cc-bg-3 text-cc-t2 hover:border-cc-border-hi hover:text-cc-t1",
        ].join(" ")}
        style={{
          clipPath:
            "polygon(0 0,calc(100% - 5px) 0,100% 5px,100% 100%,5px 100%,0 calc(100% - 5px))",
        }}
      >
        <span className="text-cc-t3 text-[8px] tracking-[0.18em]">
          {autoPublishIsOn ? "DECK" : "MAX"}
        </span>
        <span
          className="font-semibold"
          style={{ color: isDynamic && !isDisabled ? "var(--cc-accent)" : undefined }}
        >
          {compact ? chipLabelCompact(value) : chipLabel(value)}
        </span>
        {!compact && <span className="text-cc-t3 text-[8px]">{open ? "▴" : "▾"}</span>}
      </button>

      {/* ── Popover ─────────────────────────────────────────── */}
      {open && (
        <div
          className="absolute right-0 top-[calc(100%+6px)] z-50 min-w-[148px]
                     bg-cc-bg-2 border border-cc-border-hi shadow-xl"
          style={{
            clipPath:
              "polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,8px 100%,0 calc(100% - 8px))",
          }}
        >
          <div className="px-3 pt-2.5 pb-1">
            <p className="font-command text-[8px] uppercase tracking-[0.20em] text-cc-t3">
              {autoPublishIsOn ? "On-deck cap" : "Max drafts"}
            </p>
          </div>

          {CAP_OPTIONS.map((opt, i) => {
            const isActive = opt.value === value;
            const isFirst = i === 0;
            return (
              <div key={String(opt.value)}>
                {isFirst && <div className="mx-3 mb-1 h-px bg-cc-border" aria-hidden="true" />}
                <button
                  onClick={() => handleSelect(opt.value)}
                  data-testid={`draft-cap-option-${opt.value ?? "dynamic"}`}
                  className={[
                    "w-full text-left px-3 py-[7px] flex items-center gap-2",
                    "font-command text-[10px] font-semibold tracking-[0.08em] transition-colors",
                    isActive
                      ? "bg-cc-accent-dim text-cc-accent"
                      : "text-cc-t2 hover:bg-cc-bg-3 hover:text-cc-t1",
                  ].join(" ")}
                >
                  <span className="flex-1">
                    {opt.label}
                    {opt.sub && (
                      <span className="ml-2 font-sans text-[8px] font-normal text-cc-t3 tracking-normal">
                        {opt.sub}
                      </span>
                    )}
                  </span>
                  {isActive && (
                    <span className="text-cc-accent text-[10px]" aria-label="selected">
                      ✓
                    </span>
                  )}
                </button>
                {isFirst && <div className="mx-3 mt-1 h-px bg-cc-border" aria-hidden="true" />}
              </div>
            );
          })}

          <div className="pb-1" />
        </div>
      )}
    </div>
  );
}
