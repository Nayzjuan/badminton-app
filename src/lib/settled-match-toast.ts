// ============================================================
// settledMatchToast — copy for a submit that lost the race
// ============================================================
// When the organizer's score submit bounces, the server says WHY via
// MatchActionCode. Two of those codes mean "the match is settled, just not by
// you" — and they need opposite copy:
//
//   already_scored   a score exists and was kept. Nothing to redo.
//   match_cancelled  a co-organizer cancelled the match. NO score exists, and
//                    the game has to be re-run.
//
// The tempting shape is one `settled` boolean and one piece of copy, since both
// codes close the modal the same way. That collapse is what makes a cancelled
// match tell the organizer "the score they entered was kept" — false, and false
// in the direction they act on (they don't re-run the game), arriving next to a
// co-organizer broadcast that says the opposite. Kept out here as a pure
// function so the distinction is pinned by a test instead of by a branch inside
// ActiveCourts, which no unit test mounts.
// ============================================================

import type { MatchActionCode } from "@/app/actions/_shared";

export type SettledMatchToast = {
  title: string;
  body: string;
};

/**
 * Copy for a settled-match outcome, or null when the code is not a settled one
 * (or absent) and the caller should fall through to ordinary error handling.
 */
export function settledMatchToast(code: MatchActionCode | undefined): SettledMatchToast | null {
  if (code === "already_scored") {
    return {
      title: "Already Scored",
      body: "A player submitted this match first — the score they entered was kept.",
    };
  }
  if (code === "match_cancelled") {
    return {
      title: "Match Cancelled",
      body: "This match was cancelled while the score form was open — no score was recorded.",
    };
  }
  return null;
}
