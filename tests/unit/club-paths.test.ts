// ============================================================
// Unit tests: src/lib/club-paths.ts  (case ids: CP-*)
// Pure path builders — guards against slug-prefix drift across the ~25
// client navigation sites that move under /c/[clubSlug] in Phase 2.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  clubBase,
  clubPlay,
  clubOrganizer,
  clubAdmin,
  clubTv,
  clubWrapped,
  clubLeaderboard,
  clubJoin,
} from "@/lib/club-paths";

describe("club-paths", () => {
  it("CP-1: clubBase", () => {
    expect(clubBase("chillax")).toBe("/c/chillax");
  });

  it("CP-2: clubPlay with and without session", () => {
    expect(clubPlay("chillax")).toBe("/c/chillax/play");
    expect(clubPlay("chillax", "sess-1")).toBe("/c/chillax/play/sess-1");
  });

  it("CP-3: clubOrganizer with and without session", () => {
    expect(clubOrganizer("chillax")).toBe("/c/chillax/organizer");
    expect(clubOrganizer("chillax", "sess-1")).toBe("/c/chillax/organizer/sess-1");
  });

  it("CP-4: clubAdmin", () => {
    expect(clubAdmin("chillax")).toBe("/c/chillax/admin");
  });

  it("CP-5: clubTv", () => {
    expect(clubTv("chillax", "sess-1")).toBe("/c/chillax/tv/sess-1");
  });

  it("CP-6: clubWrapped", () => {
    expect(clubWrapped("chillax", "sess-1", "player-9")).toBe("/c/chillax/wrapped/sess-1/player-9");
  });

  it("CP-7: clubLeaderboard with and without session", () => {
    expect(clubLeaderboard("chillax")).toBe("/c/chillax/leaderboard");
    expect(clubLeaderboard("chillax", "sess-1")).toBe("/c/chillax/leaderboard/sess-1");
  });

  it("CP-8: clubJoin with and without session (session is query-encoded)", () => {
    expect(clubJoin("chillax")).toBe("/c/chillax/join");
    expect(clubJoin("chillax", "sess-1")).toBe("/c/chillax/join?session=sess-1");
  });

  it("CP-9: every builder is prefixed with /c/<slug>", () => {
    const slug = "manila-badminton";
    const all = [
      clubBase(slug),
      clubPlay(slug),
      clubPlay(slug, "s"),
      clubOrganizer(slug),
      clubOrganizer(slug, "s"),
      clubAdmin(slug),
      clubTv(slug, "s"),
      clubWrapped(slug, "s", "p"),
      clubLeaderboard(slug),
      clubLeaderboard(slug, "s"),
      clubJoin(slug),
      clubJoin(slug, "s"),
    ];
    for (const path of all) {
      expect(path.startsWith(`/c/${slug}`)).toBe(true);
    }
  });
});
