/** Off-Courts draft strip + Clear-unpublished confirm copy. */

export function clearUnpublishedConfirmCopy(clearableCount: number): string {
  return `Clear ${clearableCount} unpublished draft${clearableCount !== 1 ? "s" : ""}? Players return to the queue. Held drafts stay.`;
}

export function draftStripView(input: {
  visibleCount: number;
  clearableCount: number;
  activeTab: string;
  sessionActive: boolean;
}): { message: string; showClear: boolean } | null {
  const { visibleCount, clearableCount, activeTab, sessionActive } = input;
  if (visibleCount <= 0 || activeTab === "courts" || !sessionActive) return null;
  if (clearableCount === 0) {
    return {
      message: `${visibleCount} held draft${visibleCount !== 1 ? "s" : ""} waiting on a live court`,
      showClear: false,
    };
  }
  return {
    message: `${visibleCount} unpublished draft${visibleCount !== 1 ? "s" : ""} — review on Courts`,
    showClear: true,
  };
}
