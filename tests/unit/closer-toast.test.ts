import { describe, it, expect } from "vitest";
import { closerToastMessage } from "@/lib/closer-toast";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FALLBACK = "This session was closed.";

describe("closerToastMessage", () => {
  it("CT-1: another organizer is named", () => {
    expect(closerToastMessage(FALLBACK, VIEWER, { actorId: OTHER, actorName: "Miggy" })).toBe(
      "Miggy closed the session."
    );
  });

  it("CT-2: the closer's other tab keeps the fallback", () => {
    expect(closerToastMessage(FALLBACK, VIEWER, { actorId: VIEWER, actorName: "Miggy" })).toBe(
      FALLBACK
    );
  });

  it("CT-3: a nameless signal keeps the fallback", () => {
    expect(closerToastMessage(FALLBACK, VIEWER, { actorId: OTHER })).toBe(FALLBACK);
    expect(closerToastMessage(FALLBACK, VIEWER, {})).toBe(FALLBACK);
    expect(closerToastMessage(FALLBACK, VIEWER)).toBe(FALLBACK);
  });
});
