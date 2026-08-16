// ============================================================
// Unit Tests: deriveHeldState — cross-court held-draft view state
// ============================================================
// Distinct id prefix CC-DHS-* (NOT CC-PURE-*, which the pure-core suite owns —
// senior-QA QA-IDS-01 collision fix).
// ============================================================

import { describe, it, expect } from "vitest";
import {
  deriveHeldState,
  isHeldAwaitingReadiness,
  HELD_STATE_META,
  type HeldState,
} from "@/lib/cross-court/derive-held-state";

describe("deriveHeldState", () => {
  it("CC-DHS-01: not held → 'none' regardless of other fields", () => {
    expect(
      deriveHeldState({
        isHeld: false,
        heldReadyAt: "2026-06-07T12:00:00Z",
        sourceStillPlaying: true,
      })
    ).toBe("none");
  });

  it("CC-DHS-02: held + source still playing + not stamped → 'holding'", () => {
    expect(deriveHeldState({ isHeld: true, heldReadyAt: null, sourceStillPlaying: true })).toBe(
      "holding"
    );
  });

  it("CC-DHS-03: held + source finished + not yet stamped → 'resting'", () => {
    expect(deriveHeldState({ isHeld: true, heldReadyAt: null, sourceStillPlaying: false })).toBe(
      "resting"
    );
  });

  it("CC-DHS-04: held + held_ready_at stamped → 'ready' (overrides source state)", () => {
    expect(
      deriveHeldState({
        isHeld: true,
        heldReadyAt: "2026-06-07T12:00:00Z",
        sourceStillPlaying: false,
      })
    ).toBe("ready");
    // Even if the source somehow still reads in_progress, a stamp wins.
    expect(
      deriveHeldState({
        isHeld: true,
        heldReadyAt: "2026-06-07T12:00:00Z",
        sourceStillPlaying: true,
      })
    ).toBe("ready");
  });

  it("CC-DHS-05: every non-none state has accessible label + tone meta (icon+text, never color-only)", () => {
    for (const state of ["holding", "resting", "ready"] as const) {
      expect(HELD_STATE_META[state].label).toMatch(/^[A-Z]+$/);
      expect(["violet", "emerald"]).toContain(HELD_STATE_META[state].tone);
    }
    // READY is the single emerald (go) state; HOLDING/RESTING share the violet identity.
    expect(HELD_STATE_META.ready.tone).toBe("emerald");
    expect(HELD_STATE_META.holding.tone).toBe("violet");
    expect(HELD_STATE_META.resting.tone).toBe("violet");
  });
});

// ─────────────────────────────────────────────────────────────
// isHeldAwaitingReadiness — the publish rule
// ─────────────────────────────────────────────────────────────
// Every layer that has to agree on "can the organizer publish this?" — the
// card's Publish button, the on-deck panel's review-queue count, the engine's
// draft-mode cap count, the JS RPC fallbacks, the Publish All snapshot filter —
// agrees by CALLING this rather than re-spelling it. Do not restate the list
// here or anywhere else; it has already rotted twice. `grep -rn
// "isHeldAwaitingReadiness" src/` is the list. The DB enforces the same
// partition independently in publish_match / publish_all_drafts (migration
// 20260816000000), spelled in SQL. These cases pin the predicate itself; the
// callers are pinned in their own suites.

describe("isHeldAwaitingReadiness", () => {
  it("CC-DHS-06: the full 2×2 truth table over (is_held, held_ready_at)", () => {
    const STAMP = "2026-08-16T00:00:00.000Z";

    // Held and unstamped — the only true case. Covers BOTH unready states:
    // HOLDING (body on court, publish_match would return CONFLICT) and RESTING
    // (source ended, publish would SUCCEED and strand the match on deck,
    // un-promotable, after firing a premature ON_DECK_WARNING push).
    expect(isHeldAwaitingReadiness({ is_held: true, held_ready_at: null })).toBe(true);

    // Held and stamped = READY. Publishable and promotable — the whole point of
    // the stamp. Counting this as "awaiting" would make a resolved hold
    // permanently unpublishable, which is the original bug with the sign flipped.
    expect(isHeldAwaitingReadiness({ is_held: true, held_ready_at: STAMP })).toBe(false);

    // Not held ⇒ never awaiting, whatever held_ready_at says. The column is
    // meaningless off a held row, and a plain draft must stay publishable.
    expect(isHeldAwaitingReadiness({ is_held: false, held_ready_at: null })).toBe(false);
    expect(isHeldAwaitingReadiness({ is_held: false, held_ready_at: STAMP })).toBe(false);
  });

  it("CC-DHS-07: agrees with deriveHeldState on every state — true iff holding|resting", () => {
    // The two functions must not be able to drift: whatever deriveHeldState calls
    // holding or resting is exactly what this refuses to publish. deriveHeldState
    // needs sourceStillPlaying to separate those two; this predicate does not,
    // which is why it takes a different input shape — but the PARTITION is shared.
    const cases: { input: Parameters<typeof deriveHeldState>[0]; state: HeldState }[] = [
      { input: { isHeld: false, heldReadyAt: null, sourceStillPlaying: false }, state: "none" },
      { input: { isHeld: true, heldReadyAt: null, sourceStillPlaying: true }, state: "holding" },
      { input: { isHeld: true, heldReadyAt: null, sourceStillPlaying: false }, state: "resting" },
      {
        input: { isHeld: true, heldReadyAt: "2026-08-16T00:00:00.000Z", sourceStillPlaying: false },
        state: "ready",
      },
    ];

    for (const { input, state } of cases) {
      expect(deriveHeldState(input)).toBe(state);
      expect(
        isHeldAwaitingReadiness({ is_held: input.isHeld, held_ready_at: input.heldReadyAt })
      ).toBe(state === "holding" || state === "resting");
    }
  });

  // `is_held` is GENERATED ALWAYS AS (cardinality(pulled_player_ids) > 0) over a
  // `uuid[] NOT NULL DEFAULT '{}'` column, so it is never NULL in the DB, and
  // `database.ts` accordingly declares it `boolean` — not `boolean | null`. That
  // declaration is an ASSERTION, not a validation: nothing checks a PostgREST
  // payload against it at runtime (types are erased and supabase-js casts), and
  // every caller reads `is_held` straight off a select. So the null is
  // unreachable only for as long
  // as the generated column stays generated. The `=== true` is what makes that
  // case fall to "not held" (publishable) rather than to a truthiness accident,
  // and the cast below is the only way to reach it precisely BECAUSE the type
  // says it cannot happen. Same fail-open direction as hasFeedableCapacity's
  // CCT-FEED-7, and the same reason matchmaking-db.ts:730 refuses to route its
  // unready-hold count through a `is_held: boolean` helper — that would launder
  // the null instead of testing it.
  it("CC-DHS-08: a null is_held is not held — it does not block publishing", () => {
    expect(
      isHeldAwaitingReadiness({
        is_held: null as unknown as boolean,
        held_ready_at: null,
      })
    ).toBe(false);
  });
});
