// ============================================================
// MatchOriginTag — inline provenance label for a match
// ============================================================
// Drives off `final_classification` (created_method × modified?). Design:
//   • auto (clean)    → renders nothing  (the silent default; no noise)
//   • manual          → amber "Manual"   (amber = organizer action)
//   • held            → violet "Held"    (cross-court held draft; matches cc-violet)
//   • …_modified      → appends a muted "· Edited" suffix
//
// Typography-only: no icons, no borders. A 10px font-black ALL-CAPS label.
// ============================================================

import type { MatchClassification, MatchCreatedMethod } from "@/types/database";

type Props = {
  classification: MatchClassification;
};

function parse(c: MatchClassification): { method: MatchCreatedMethod; modified: boolean } {
  const modified = c.endsWith("_modified");
  const method = c.replace(/_(clean|modified)$/, "") as MatchCreatedMethod;
  return { method, modified };
}

export function MatchOriginTag({ classification }: Props) {
  const { method, modified } = parse(classification);

  // Silent default — a clean auto match is by far the most common case.
  if (method === "auto" && !modified) return null;

  const base = "text-[10px] font-black uppercase tracking-[0.16em] leading-none";

  // The primary label reflects how the match was BORN.
  let label: string | null = null;
  let labelClass = "";
  let title = "";
  if (method === "manual") {
    label = "Manual";
    labelClass = "text-amber-600 dark:text-amber-400";
    title = "Manually composed";
  } else if (method === "held") {
    label = "Held";
    labelClass = "text-violet-600 dark:text-violet-400";
    title = "Cross-court held draft";
  }

  const aria = [
    method === "manual"
      ? "Manually composed match"
      : method === "held"
        ? "Cross-court held draft"
        : "Engine match",
    modified ? "edited after creation" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <span className={`inline-flex items-center gap-1 ${base}`} aria-label={aria}>
      {label && (
        <span className={labelClass} title={title}>
          {label}
        </span>
      )}
      {modified && (
        <span className="text-muted-foreground" title="Roster edited after creation">
          {label ? "· Edited" : "Edited"}
        </span>
      )}
    </span>
  );
}
