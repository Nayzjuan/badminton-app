// @vitest-environment happy-dom
// ============================================================
// useClubSlug — the anchored parse every club-scoped link is built from (CS)
// ============================================================
// src/hooks/use-club-slug.ts is four lines of regex, and it decides which club
// the app thinks you are in. Nothing else does: rather than thread a clubSlug
// prop through PlayerDashboard, OrganizerDashboard, the PWA nav bar and the
// share dialog, every one of those reads it back out of the pathname and hands
// it to a src/lib/club-paths.ts builder —
//
//   const clubSlug = useClubSlug();
//   router.push(clubSlug ? clubPlay(clubSlug, id) : `/play/${id}`);
//
// so this one return value is the ternary condition on ~25 navigation sites.
// It has exactly two ways to be wrong, and they fail in opposite directions:
//
//   null on a club route  → every link on the page falls back to the legacy
//     /play, /organizer, /leaderboard paths. The user is silently ejected from
//     the /c/[clubSlug] namespace mid-session and the club context (which club
//     am I organizing?) is gone until they navigate in from the lobby again.
//   a slug on a NON-club route → the legacy pages start building /c/<x>/… URLs
//     out of a fragment that was never a club slug. The regex is anchored with
//     ^ for exactly this reason: "/organizer/c/x" contains "/c/" and must not
//     match. Drop the anchor and any path segment named "c" becomes a club.
//
// Both failures are invisible to a type checker — the return type is
// `string | null` either way — and invisible to a render test, because the
// wrong link still renders. Only the parse itself can be pinned, so this file
// pins it: one case per branch of the regex, each negative paired with a
// positive control in the same test so a hook that returned null for
// EVERYTHING would satisfy none of them.
//
//   CS-1   /c/<slug> exactly → the slug
//   CS-2   /c/<slug>/deep/nested/path → the slug alone, not the tail
//   CS-3   (edge) a trailing slash — /c/<slug>/ → the slug
//   CS-4   (negative) a legacy /play/<id> route → null (+ positive control)
//   CS-5   (edge) "/" → null (+ positive control)
//   CS-6   (edge) "/c" with no slug segment → null (+ positive control)
//   CS-7   (edge) "/c/" with an EMPTY slug → null, never ""
//   CS-8   the slug is returned verbatim — percent-escapes are not decoded
//          and case is not folded
//   CS-9   (negative) THE ANCHOR — a path that merely CONTAINS /c/ later on
//          does not match (+ positive control on the same slug)
//   CS-10  (edge) a null pathname → null (usePathname can return null)
//   CS-11  (edge) an empty-string pathname → null
//   CS-12  the slug tracks the CURRENT pathname across a re-render
//
// WHAT THIS FILE DOES NOT PROVE
//   - That the parsed slug names a club that exists, or one the caller belongs
//     to. This hook does no lookup at all; membership is enforced server-side
//     (RLS + the /c/[clubSlug] layout's own loader), never by this string.
//   - That a slug is well-formed. slugifyClubName / isValidClubSlug are covered
//     in tests/unit/club-slug.test.ts — which is a DIFFERENT module that also
//     numbers its cases CS-*; the ids here are file-scoped, not shared with it.
//   - That the builders turn a slug into the right URL — tests/unit/club-paths.test.ts.
//   - That any component actually calls the hook rather than hardcoding a path.
//     That is a per-component property; use-leaderboard.test.ts covers one such
//     consumer, the rest are E2E.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useClubSlug } from "@/hooks/use-club-slug";

// ── Mock next/navigation ──────────────────────────────────────
// usePathname is typed `() => string`, but App Router returns null while the
// router is not mounted (and the hook guards for it with `pathname?.match`),
// so the stub is typed to match reality rather than the .d.ts — otherwise
// CS-10 could not be written at all.
let mockPathname: string | null = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

// ── Helper ────────────────────────────────────────────────────

/** Render the hook at `pathname` and return what it parsed. */
function slugAt(pathname: string | null): string | null {
  mockPathname = pathname;
  return renderHook(() => useClubSlug()).result.current;
}

// ── Tests ─────────────────────────────────────────────────────

describe("useClubSlug — Unit Suite", () => {
  beforeEach(() => {
    mockPathname = "/";
  });

  // ── CS-1 ───────────────────────────────────────────────────
  it("CS-1: /c/<slug> exactly → the slug", () => {
    expect(
      slugAt("/c/chillax"),
      "the club lobby itself did not resolve to a club — every link rendered on /c/chillax would fall back to a legacy path and drop the club context"
    ).toBe("chillax");
  });

  // ── CS-2 ───────────────────────────────────────────────────
  it("CS-2: /c/<slug>/deep/nested/path → the slug alone, not the tail", () => {
    expect(
      slugAt("/c/chillax/organizer/2f0a9c14-0000-4000-8000-000000000000"),
      "the slug captured more than the first segment — it is interpolated straight into /c/<slug>/… by the club-paths builders, so a captured tail produces a doubled, 404-ing URL"
    ).toBe("chillax");

    expect(
      slugAt("/c/chillax/wrapped/sess-1/player-9"),
      "a deeper club route stopped resolving to its club — the deeper the route the more nav links it renders, and all of them would leave the namespace"
    ).toBe("chillax");
  });

  // ── CS-3 ───────────────────────────────────────────────────
  it("CS-3: (edge) a trailing slash still resolves to the slug", () => {
    expect(
      slugAt("/c/chillax/"),
      "a trailing slash — which a copied/pasted or QR-scanned club link routinely carries — was not treated as the club lobby"
    ).toBe("chillax");
  });

  // ── CS-4 ───────────────────────────────────────────────────
  it("CS-4: (negative) a legacy /play/<id> route is not a club route", () => {
    // Positive control FIRST: proves this helper can produce a non-null slug at
    // all, so the null below is a decision about /play and not a hook that
    // returns null for everything.
    expect(
      slugAt("/c/chillax/play/sess-1"),
      "positive control failed — the club-scoped twin of the legacy route below did not resolve, so the null assertion that follows proves nothing"
    ).toBe("chillax");

    expect(
      slugAt("/play/2f0a9c14-0000-4000-8000-000000000000"),
      "a legacy /play route reported a club — the legacy routes exist precisely because they have NO club context, and inventing one sends shared links into a namespace the recipient may not be a member of"
    ).toBeNull();

    expect(
      slugAt("/organizer"),
      "the legacy organizer entry reported a club it cannot know"
    ).toBeNull();
  });

  // ── CS-5 ───────────────────────────────────────────────────
  it("CS-5: (edge) the root path is not a club route", () => {
    expect(slugAt("/c/chillax"), "positive control failed").toBe("chillax");
    expect(
      slugAt("/"),
      "the root landing page claimed a club — nav built there would point at a club that was never named"
    ).toBeNull();
  });

  // ── CS-6 ───────────────────────────────────────────────────
  it("CS-6: (edge) '/c' with no slug segment is not a club route", () => {
    expect(slugAt("/c/chillax"), "positive control failed").toBe("chillax");
    expect(
      slugAt("/c"),
      "'/c' alone resolved to a club — there is no slug in that path to resolve to, so whatever it returned was fabricated"
    ).toBeNull();
  });

  // ── CS-7 ───────────────────────────────────────────────────
  it("CS-7: (edge) '/c/' with an empty slug → null, never an empty string", () => {
    expect(slugAt("/c/chillax"), "positive control failed").toBe("chillax");

    const parsed = slugAt("/c/");
    expect(
      parsed,
      "an empty slug segment was captured instead of rejected — the documented contract is 'the slug, or null on a non-club route', and '/c/' names no club"
    ).toBeNull();
    // Stated separately because "" and null are NOT interchangeable here: the
    // ternary callers (`slug ? clubPlay(slug) : legacy`) treat both as absent,
    // but any caller that null-checks explicitly would interpolate "" and build
    // "/c//play" — a URL no route matches.
    expect(
      parsed,
      "the empty-slug path produced an empty string — a caller that checks for null rather than truthiness would build '/c//play'"
    ).not.toBe("");
  });

  // ── CS-8 ───────────────────────────────────────────────────
  it("CS-8: the slug is returned verbatim — not decoded, not case-folded", () => {
    // "café-smash" as it appears in a pathname the browser has encoded.
    expect(
      slugAt("/c/caf%C3%A9-smash/play"),
      "the percent-escapes were decoded — the value goes straight back into a URL via the club-paths builders, and a decoded slug re-encoded (or not) by the next builder is a different, non-matching path"
    ).toBe("caf%C3%A9-smash");

    expect(
      slugAt("/c/CHILLAX/play"),
      "case was folded — slugs are compared byte-for-byte by the route loader, so a normalised slug is a different club than the one in the address bar"
    ).toBe("CHILLAX");
  });

  // ── CS-9 ───────────────────────────────────────────────────
  it("CS-9: (negative) THE ANCHOR — /c/ later in the path does not match", () => {
    // Positive control: the exact same slug, at the front, does resolve. So the
    // nulls below are about POSITION, not about the value "x" being rejected.
    expect(
      slugAt("/c/x/play"),
      "positive control failed — '/c/x' at the front must resolve, otherwise the anchored-negative assertions below are vacuous"
    ).toBe("x");

    expect(
      slugAt("/organizer/c/x"),
      "the regex is no longer anchored — a legacy route with a segment named 'c' now reports a club, and /organizer starts linking into /c/x/… for a club nobody selected"
    ).toBeNull();

    expect(
      slugAt("/play/c/x"),
      "an unanchored match on a legacy player route — same failure, different entry point"
    ).toBeNull();

    // Near-miss prefix: "/club/..." starts with "/c" but not with "/c/".
    expect(
      slugAt("/club/x"),
      "'/club/x' was parsed as club 'x' — the literal that must match is '/c/', not '/c'"
    ).toBeNull();
  });

  // ── CS-10 ──────────────────────────────────────────────────
  it("CS-10: (edge) a null pathname → null, not a crash", () => {
    expect(slugAt("/c/chillax"), "positive control failed").toBe("chillax");
    // usePathname returns null before the App Router has mounted. Every
    // consumer of this hook renders during that window (the nav bar is in the
    // root layout), so an unguarded .match() here is a client-side exception
    // that blanks the whole page rather than a missing link.
    expect(
      slugAt(null),
      "a null pathname did not degrade to 'no club' — if this throws instead, the failure is not a wrong link, it is an unhandled render error in the root layout"
    ).toBeNull();
  });

  // ── CS-11 ──────────────────────────────────────────────────
  it("CS-11: (edge) an empty-string pathname → null", () => {
    expect(slugAt("/c/chillax"), "positive control failed").toBe("chillax");
    expect(
      slugAt(""),
      "an empty pathname resolved to a club — there is nothing in it to resolve"
    ).toBeNull();
  });

  // ── CS-12 ──────────────────────────────────────────────────
  it("CS-12: the slug tracks the CURRENT pathname across a re-render", () => {
    mockPathname = "/c/chillax/play";
    const { result, rerender } = renderHook(() => useClubSlug());
    expect(result.current, "the initial club route did not resolve").toBe("chillax");

    // A client-side navigation into a different club re-renders the subscriber
    // with a new pathname. Anything cached at module scope (or in a ref seeded
    // once) would keep serving the first club here.
    mockPathname = "/c/smashers/play";
    rerender();
    expect(
      result.current,
      "the hook kept serving the club it saw first — after navigating from one club to another, every link on the page would still point at the previous club"
    ).toBe("smashers");

    // …and back out to a legacy route, which must clear it rather than latch.
    mockPathname = "/play/sess-1";
    rerender();
    expect(
      result.current,
      "the club latched after leaving the namespace — legacy pages would keep building /c/smashers/… links for a club the user has navigated away from"
    ).toBeNull();
  });
});
