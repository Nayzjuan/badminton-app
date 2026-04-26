"use client";

// ============================================================
// CourtTimePopover — per-session court time limit picker
// ============================================================
// A compact pill trigger that opens a Radix Popover with preset
// minute options. Selecting a preset calls onSave immediately.
//
// Error handling: on save failure the popover stays open and
// shows an inline error message — it never silently closes with
// a stale displayed value.
//
// Trigger appearance:
//   "⏱ 30m"  when a limit is set
//   "⏱ Off"  when no limit (null)
//
// Presets: 15 | 20 | 25 | 30 | 35 | 40 | Off
// ============================================================

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Timer, X } from "lucide-react";

interface CourtTimePopoverProps {
  timeLimitMinutes: number | null;
  onSave: (minutes: number | null) => Promise<{ error?: string }>;
}

const PRESETS = [15, 20, 25, 30, 35, 40] as const;

export function CourtTimePopover({
  timeLimitMinutes,
  onSave,
}: CourtTimePopoverProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSelect(minutes: number | null) {
    setSaving(true);
    setSaveError(null);
    const result = await onSave(minutes);
    setSaving(false);
    if (result.error) {
      // Keep popover open and surface the error inline — never silently close
      setSaveError("Couldn't save — tap to retry.");
    } else {
      setOpen(false);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setSaveError(null); // clear error when dismissed via X or outside click
  }

  const label = timeLimitMinutes != null ? `${timeLimitMinutes}m` : "Off";
  const isActive = timeLimitMinutes != null;

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          data-testid="court-time-trigger"
          disabled={saving}
          aria-label={`Court time limit: ${label}. Click to change.`}
          className={[
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5",
            "text-xs font-semibold border transition-colors",
            isActive
              ? "bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100 dark:bg-amber-500/10 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/20"
              : "bg-slate-100 border-slate-200 text-slate-500 hover:bg-slate-200 dark:bg-white/5 dark:border-white/10 dark:text-white/40 dark:hover:bg-white/10",
            "disabled:opacity-60 disabled:cursor-not-allowed",
          ].join(" ")}
        >
          <Timer className="h-3 w-3 shrink-0" aria-hidden="true" />
          {saving ? "…" : label}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className={[
            "z-50 rounded-2xl border bg-white dark:bg-card shadow-xl",
            "border-slate-200 dark:border-border",
            "p-3 w-56",
            "animate-in fade-in slide-in-from-top-1 duration-150",
          ].join(" ")}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400 dark:text-muted-foreground">
              Court Time Limit
            </p>
            <Popover.Close asChild>
              <button
                aria-label="Close"
                className="rounded-lg p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-muted transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Popover.Close>
          </div>

          {/* Preset grid */}
          <div className="grid grid-cols-3 gap-1.5 mb-2">
            {PRESETS.map((min) => {
              const isSelected = timeLimitMinutes === min;
              return (
                <button
                  key={min}
                  data-testid={`court-time-preset-${min}`}
                  disabled={saving}
                  onClick={() => handleSelect(min)}
                  className={[
                    "rounded-xl py-2 text-sm font-bold transition-colors",
                    isSelected
                      ? "bg-amber-500 text-white shadow-sm"
                      : "bg-slate-100 text-slate-700 hover:bg-amber-50 hover:text-amber-800 dark:bg-muted dark:text-foreground dark:hover:bg-amber-500/15 dark:hover:text-amber-300",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                  ].join(" ")}
                >
                  {min}m
                </button>
              );
            })}
          </div>

          {/* Off button — full width */}
          <button
            data-testid="court-time-off"
            disabled={saving}
            onClick={() => handleSelect(null)}
            className={[
              "w-full rounded-xl py-2 text-sm font-bold transition-colors",
              timeLimitMinutes === null
                ? "bg-slate-700 text-white dark:bg-white/15 dark:ring-1 dark:ring-white/25"
                : "bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-muted dark:text-muted-foreground dark:hover:bg-muted/80",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            ].join(" ")}
          >
            Off (no limit)
          </button>

          {/* Threshold hint */}
          <p
            data-testid="court-time-threshold-hint"
            className="mt-2.5 text-[10px] text-slate-400 dark:text-muted-foreground text-center leading-snug"
          >
            Card glows amber at the limit, red at +10 min
          </p>

          {/* Inline save error */}
          {saveError && (
            <p
              data-testid="court-time-save-error"
              className="mt-2 text-[11px] text-red-500 dark:text-red-400 text-center font-medium"
            >
              {saveError}
            </p>
          )}

          <Popover.Arrow className="fill-slate-200 dark:fill-card" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
