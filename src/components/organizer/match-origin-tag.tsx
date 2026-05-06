// ============================================================
// MatchOriginTag — inline label for non-auto match origins
// ============================================================
// Design rationale:
//   • auto  → renders nothing  (the 90%+ default; silence = no noise)
//   • manual → amber label     (matches the app's amber = organizer action)
//   • modified → muted label   (informational; engine match that was edited)
//
// Typography-only: no icons, no badges, no borders. A 10px
// font-black ALL-CAPS label with generous tracking — readable
// at a glance on a court card without fighting for attention.
// ============================================================

import type { MatchOrigin } from "@/types/database";

type Props = {
  origin: MatchOrigin;
};

export function MatchOriginTag({ origin }: Props) {
  // Silent default — auto is by far the most common case. Rendering
  // nothing here means the card stays clean for the vast majority of matches.
  if (origin === "auto") return null;

  const isManual = origin === "manual";

  return (
    <span
      className={
        isManual
          ? "text-[10px] font-black uppercase tracking-[0.16em] leading-none text-amber-600 dark:text-amber-400"
          : "text-[10px] font-black uppercase tracking-[0.16em] leading-none text-muted-foreground"
      }
      aria-label={
        isManual
          ? "Manually composed match"
          : "Engine match edited after creation"
      }
      title={isManual ? "Manually composed" : "Edited after creation"}
    >
      {isManual ? "Manual" : "Edited"}
    </span>
  );
}
