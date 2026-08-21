// @vitest-environment happy-dom
// ============================================================
// Suite LU — cn + createUnknownProfile
// ============================================================
// WHY THIS FILE EXISTS
//
// Two exports, both load-bearing, neither tested until now.
//
// createUnknownProfile is the fallback that keeps the queue rendering when
// a match row references a player whose profile has not arrived yet. Its
// own docstring states the reason it is centralised: "adding a new required
// column to Profile only needs one update, not three scattered inline
// objects." Nothing enforced that. Add a required column to Profile and
// `npx tsc --noEmit` DOES fail here — the object literal stops satisfying
// the return type — so the type system covers the add case. What it does
// not cover is the values, which is where the real bug lives: this stub is
// rendered to a human, and every one of its fields is a lie that must be a
// SAFE lie. LU-6 pins the whole shape at once for exactly that reason.
//
// Recompute the call sites with:
//
//     rg -n 'createUnknownProfile' src/
//
// cn is a clsx + tailwind-merge wrapper. The wrapper is not decoration:
// clsx alone concatenates, so `cn("p-2", "p-4")` would emit both and the
// winner would depend on stylesheet order. LU-1 is the test that would go
// red if someone "simplified" cn to plain clsx or to a template string —
// which is the only realistic way this file breaks.
//
//   LU-1..LU-5   cn: conflict resolution, falsy filtering, arrays, objects
//   LU-6..LU-10  createUnknownProfile: exact shape, id binding, purity
//
// WHAT THIS FILE DOES NOT PROVE
//   - That the classes cn emits actually style anything. That needs a
//     browser with the compiled stylesheet; these assertions are about
//     string composition only.
//   - That callers USE the fallback for the right rows. That belongs to
//     the hook suites — see SD-5 in use-session-data.test.ts, which pins
//     that the stub is built with the row's OWN player id.
// ============================================================

import { describe, it, expect } from "vitest";
import { cn, createUnknownProfile } from "@/lib/utils";
import type { Profile } from "@/types/database";

describe("Suite LU — cn", () => {
  it("LU-1: a later Tailwind class WINS over an earlier conflicting one", () => {
    // The whole reason twMerge is in the chain. Plain clsx returns
    // "p-2 p-4" and leaves the outcome to stylesheet order.
    expect(
      cn("p-2", "p-4"),
      "tailwind-merge is not being applied — conflicting classes both survive"
    ).toBe("p-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("LU-2: non-conflicting classes are all kept, in order", () => {
    // The positive control for LU-1: twMerge must not be dropping classes
    // it merely fails to recognise as conflicting.
    expect(cn("flex", "items-center", "gap-2")).toBe("flex items-center gap-2");
  });

  it("LU-3: falsy conditionals are dropped rather than stringified", () => {
    // `${cond && "x"}` in a template literal emits the word "false".
    expect(cn("base", false && "hidden", null, undefined, "")).toBe("base");
    expect(cn("base", true && "block")).toBe("base block");
  });

  it("LU-4: accepts arrays and nested arrays", () => {
    expect(cn(["flex", "gap-2"], [["p-2"]])).toBe("flex gap-2 p-2");
  });

  it("LU-5: accepts the object form, keeping only truthy keys", () => {
    expect(cn({ flex: true, hidden: false, "gap-2": true })).toBe("flex gap-2");
  });
});

describe("Suite LU — createUnknownProfile", () => {
  const ID = "3367d4c6-1f2a-4b8e-9c0d-5e6f7a8b9c0d";

  it("LU-6: returns EXACTLY the documented shape, with no extra and no missing key", () => {
    // toEqual, not toMatchObject: a subset match is satisfied by a stub that
    // silently gained a field, and the point of this assertion is that the
    // shape is pinned in one place. Each value is a claim about what the UI
    // shows for a player whose profile has not loaded:
    //   display_name "Unknown"  — visible text, must not be "" or the raw id
    //   skill_level  "beginner" — the LOWEST tier; a stub must never seed a
    //                             player into a higher bracket by accident
    //   vip_tag/theme null      — a stub must never render a VIP badge
    //   needs_rename false      — a stub must never trigger the rename gate
    //   flagged_at   null       — a stub must never look like a dupe
    //   pin          null       — a stub must never carry a credential
    expect(createUnknownProfile(ID)).toEqual({
      id: ID,
      display_name: "Unknown",
      skill_level: "beginner",
      pin: null,
      vip_tag: null,
      vip_theme: null,
      needs_rename: false,
      collided_name: null,
      flagged_at: null,
      created_at: "",
      updated_at: "",
    } satisfies Profile);
  });

  it("LU-7: the id argument is what lands on the id field, unmodified", () => {
    // Binding, not presence. A stub built with the wrong id renders under
    // the wrong player's slot and is indistinguishable from a real profile
    // at the call site.
    for (const id of [ID, "00000000-0000-0000-0000-000000000000", "arbitrary"]) {
      expect(createUnknownProfile(id).id, `id ${id} was not passed through`).toBe(id);
    }
  });

  it("LU-8: never carries a PIN — the stub must not look like a credential", () => {
    // Called out on its own because `pin` is the one field on Profile that
    // is a secret. LU-6 covers it in the whole-shape match; this exists so
    // the reason survives a future edit to LU-6.
    expect(createUnknownProfile(ID).pin).toBeNull();
  });

  it("LU-9: returns a FRESH object each call — no shared module-level singleton", () => {
    // A cached singleton would be a plausible "optimisation" and would be
    // catastrophic: three hooks enrich concurrently, and mutating one
    // rendered row would mutate every unknown player on screen.
    const a = createUnknownProfile(ID);
    const b = createUnknownProfile(ID);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);

    a.display_name = "mutated";
    expect(
      createUnknownProfile(ID).display_name,
      "the stub is shared between calls — mutating one rendered row mutates all of them"
    ).toBe("Unknown");
  });

  it("LU-10: two different ids produce two independent stubs", () => {
    const a = createUnknownProfile("id-a");
    const b = createUnknownProfile("id-b");
    expect(a.id).toBe("id-a");
    expect(b.id).toBe("id-b");
  });
});
