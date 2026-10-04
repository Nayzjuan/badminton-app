import { describe, it, expect } from "vitest";
import { clearUnpublishedConfirmCopy, draftStripView } from "@/lib/draft-strip";

describe("draftStripView", () => {
  it("C4-1: hidden on Courts even when drafts exist", () => {
    expect(
      draftStripView({
        visibleCount: 2,
        clearableCount: 2,
        activeTab: "courts",
        sessionActive: true,
      })
    ).toBeNull();
  });

  it("C4-2: hidden when visibleCount is 0", () => {
    expect(
      draftStripView({
        visibleCount: 0,
        clearableCount: 0,
        activeTab: "queue",
        sessionActive: true,
      })
    ).toBeNull();
  });

  it("C4-3: shown on Queue when visibleCount > 0", () => {
    expect(
      draftStripView({
        visibleCount: 2,
        clearableCount: 2,
        activeTab: "queue",
        sessionActive: true,
      })
    ).toEqual({
      message: "2 unpublished drafts — review on Courts",
      showClear: true,
    });
  });

  it("C4-4: held-only copy has no Clear", () => {
    expect(
      draftStripView({
        visibleCount: 1,
        clearableCount: 0,
        activeTab: "queue",
        sessionActive: true,
      })
    ).toEqual({
      message: "1 held draft waiting on a live court",
      showClear: false,
    });
  });
});

describe("clearUnpublishedConfirmCopy", () => {
  it("C4-5: confirm N is clearableCount when mixed held + clearable", () => {
    expect(clearUnpublishedConfirmCopy(2)).toBe(
      "Clear 2 unpublished drafts? Players return to the queue. Held drafts stay."
    );
  });
});
