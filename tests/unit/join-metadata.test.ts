// ============================================================
// joinPageMetadata — OG / Twitter card for shareable join links
// ============================================================
// IDs: JM-*
// ============================================================

import { describe, it, expect } from "vitest";
import { joinPageMetadata } from "@/lib/join-metadata";

describe("joinPageMetadata", () => {
  it("JM-1: a session join names the session in title, description, and OG url", () => {
    const m = joinPageMetadata({
      sessionName: "Thursday Night",
      clubName: "CHILLAX",
      canonicalPath: "/j/00000000-0000-4000-8000-000000000001",
    });
    expect(m.title).toBe("Join Thursday Night");
    expect(String(m.description)).toContain("Thursday Night");
    expect(String(m.description)).toContain("CHILLAX");
    expect(m.openGraph?.url).toBe("/j/00000000-0000-4000-8000-000000000001");
    expect(m.openGraph?.title).toBe("Join Thursday Night");
    expect(m.twitter).toEqual(expect.objectContaining({ card: "summary" }));
  });

  it("JM-2: a club-only join falls back to the club name", () => {
    const m = joinPageMetadata({
      clubName: "CHILLAX",
      canonicalPath: "/c/chillax/join",
    });
    expect(m.title).toBe("Join CHILLAX");
    expect(String(m.description)).toContain("CHILLAX");
    expect(m.openGraph?.url).toBe("/c/chillax/join");
  });

  it("JM-3: co-organizer copy names the role and does not mention the queue", () => {
    const m = joinPageMetadata({
      sessionName: "Friday Night",
      clubName: "CHILLAX",
      canonicalPath: "/o/abcdefghijklmnopqrstuvwxyz012345",
      kind: "co-organizer",
    });
    expect(m.title).toBe("Co-organize Friday Night");
    expect(String(m.description)).toContain("co-organizer");
    expect(String(m.description)).not.toMatch(/queue/i);
    expect(m.openGraph?.url).toBe("/o/abcdefghijklmnopqrstuvwxyz012345");
  });
});
