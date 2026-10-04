"use client";

import { COURTSIDE_OFFLINE_COPY } from "@/lib/courtside-action";

const CHIP =
  "inline-flex min-h-[44px] min-w-[44px] flex-1 items-center justify-center px-3 " +
  "clip-cut-sm font-command text-[10px] uppercase tracking-[0.10em] " +
  "sm:flex-none";

export function OrganizerOfflineBanner() {
  return (
    <p
      role="status"
      className="mb-3 clip-cut-sm border border-cc-red/40 bg-cc-red-dim px-3 py-2.5 text-sm leading-snug text-cc-red"
    >
      {COURTSIDE_OFFLINE_COPY} Mutations are paused until you reconnect.
    </p>
  );
}

export function OrganizerDraftStrip({
  message,
  showClear,
  onReview,
  onClear,
}: {
  message: string;
  showClear: boolean;
  onReview: () => void;
  onClear: () => void;
}) {
  return (
    <div
      className="mb-3 clip-cut-sm border border-cc-amber/35 bg-cc-amber-dim px-3 py-2.5"
      role="status"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <p className="min-w-0 flex-1 text-sm leading-snug text-cc-t1">{message}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReview}
            className={`${CHIP} bg-cc-amber text-cc-btn-on-accent`}
          >
            Review
          </button>
          {showClear && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear unpublished drafts"
              className={`${CHIP} border border-cc-amber/50 text-cc-amber`}
            >
              <span className="sm:hidden" aria-hidden="true">
                Clear
              </span>
              <span className="hidden sm:inline" aria-hidden="true">
                Clear unpublished
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
