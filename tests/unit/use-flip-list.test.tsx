// @vitest-environment happy-dom
// ============================================================
// useFlipList — FLIP reorder animation mechanics
// ============================================================
// jsdom has no layout engine, so offsetTop is faked via a prototype getter
// reading data-top, and el.animate is a prototype spy — the tests verify the
// FLIP decisions (what animates, with which delta, and when nothing must
// animate), not pixels. A real harness component (not renderHook) is used so
// refs attach during commit, before the layout effect — the same timing the
// hook sees in WaitlistTab.
//
// IDs: FLIP-1 … FLIP-8
//
// FLIP-6 … FLIP-8 use the `Gated` harness, which mirrors the shape every real
// caller has (`if (loading) return <skeleton/>` above the list): the order can
// change while zero rows are rendered, and the commit that finally paints them
// changes no key. Those three fail against the pre-2026-08-04 hook.
// ============================================================

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useFlipList } from "@/hooks/use-flip-list";

const animateSpy = vi.fn();
let matchMediaReduced = false;

function Flippy({ items }: { items: { k: string; top: number }[] }) {
  const register = useFlipList(items.map((i) => i.k).join(","));
  return (
    <div>
      {items.map((i) => (
        <div key={i.k} data-k={i.k} data-top={i.top} ref={register(i.k)} />
      ))}
    </div>
  );
}

/**
 * Same list, but behind a loading gate that renders NO refs — the exact shape
 * of waitlist-tab.tsx (`useFlipList` above `if (loading) return <skeleton/>`),
 * live-courts-tab.tsx and queue-control.tsx's By-Skill lens.
 */
function Gated({ items, loading }: { items: { k: string; top: number }[]; loading: boolean }) {
  const register = useFlipList(items.map((i) => i.k).join(","));
  if (loading) return <div data-testid="skeleton" />;
  return (
    <div>
      {items.map((i) => (
        <div key={i.k} data-k={i.k} data-top={i.top} ref={register(i.k)} />
      ))}
    </div>
  );
}

/** The data-k of each element animate() was invoked on, call order preserved. */
function animatedKeys(): (string | null)[] {
  return animateSpy.mock.contexts.map((el) => (el as HTMLElement).getAttribute("data-k"));
}

function keyframesFor(k: string): unknown {
  const idx = animatedKeys().indexOf(k);
  return idx === -1 ? undefined : animateSpy.mock.calls[idx][0];
}

describe("useFlipList — Unit Suite", () => {
  beforeEach(() => {
    animateSpy.mockClear();
    matchMediaReduced = false;
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: matchMediaReduced,
    })) as unknown as typeof window.matchMedia;
    // jsdom's offsetTop is always 0 — fake layout via the data-top attribute.
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        return Number(this.getAttribute("data-top") ?? 0);
      },
    });
    // jsdom has no Web Animations API.
    (HTMLElement.prototype as unknown as { animate: typeof animateSpy }).animate = animateSpy;
  });

  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  });

  it("FLIP-1: first commit only records — nothing animates on mount", () => {
    render(
      <Flippy
        items={[
          { k: "a", top: 0 },
          { k: "b", top: 60 },
        ]}
      />
    );
    expect(animateSpy).not.toHaveBeenCalled();
  });

  it("FLIP-2: a reorder animates surviving rows from their old slot", () => {
    const { rerender } = render(
      <Flippy
        items={[
          { k: "a", top: 0 },
          { k: "b", top: 60 },
        ]}
      />
    );
    // Swap: a 0→60 (plays from -60), b 60→0 (plays from +60).
    rerender(
      <Flippy
        items={[
          { k: "b", top: 0 },
          { k: "a", top: 60 },
        ]}
      />
    );

    expect(animatedKeys().sort()).toEqual(["a", "b"]);
    expect(keyframesFor("a")).toEqual([
      { transform: "translateY(-60px)" },
      { transform: "translateY(0)" },
    ]);
    expect(keyframesFor("b")).toEqual([
      { transform: "translateY(60px)" },
      { transform: "translateY(0)" },
    ]);
  });

  it("FLIP-3: a row that kept its offset does not animate on reorder", () => {
    const { rerender } = render(
      <Flippy
        items={[
          { k: "a", top: 0 },
          { k: "b", top: 60 },
          { k: "c", top: 120 },
        ]}
      />
    );
    // b and c swap; a keeps its slot.
    rerender(
      <Flippy
        items={[
          { k: "a", top: 0 },
          { k: "c", top: 60 },
          { k: "b", top: 120 },
        ]}
      />
    );

    expect(animatedKeys().sort()).toEqual(["b", "c"]);
  });

  it("FLIP-4: a row that joins after first commit gets the enter fade, not a move", () => {
    const { rerender } = render(<Flippy items={[{ k: "a", top: 0 }]} />);
    rerender(
      <Flippy
        items={[
          { k: "a", top: 0 },
          { k: "b", top: 60 },
        ]}
      />
    );

    expect(animatedKeys()).toEqual(["b"]);
    const frames = keyframesFor("b") as Array<Record<string, unknown>>;
    expect(frames[0]).toHaveProperty("opacity", 0);
  });

  it("FLIP-5: prefers-reduced-motion suppresses every animation", () => {
    matchMediaReduced = true;
    const { rerender } = render(
      <Flippy
        items={[
          { k: "a", top: 0 },
          { k: "b", top: 60 },
        ]}
      />
    );
    rerender(
      <Flippy
        items={[
          { k: "b", top: 0 },
          { k: "a", top: 60 },
        ]}
      />
    );

    expect(animateSpy).not.toHaveBeenCalled();
  });

  it("FLIP-6: a reorder that follows a skeleton commit still plays a MOVE, not an enter", () => {
    const three = [
      { k: "a", top: 0 },
      { k: "b", top: 60 },
      { k: "c", top: 120 },
    ];
    // M1: gate up, no data yet.
    const { rerender } = render(<Gated items={[]} loading />);
    // M2: data lands BEFORE the gate opens — the orderKey changes while the
    // skeleton is still rendering, so zero rows are registered. This is the
    // commit that used to wipe prevTops.
    rerender(<Gated items={three} loading />);
    // M3: the gate opens. Rows mount and attach refs, but the orderKey is
    // unchanged — a [orderKey]-keyed effect would never measure them.
    rerender(<Gated items={three} loading={false} />);
    expect(animateSpy, "the gate opening is not an animation event").not.toHaveBeenCalled();

    // M4: the real reorder — "a" leaves, b and c each shift up one slot.
    rerender(
      <Gated
        items={[
          { k: "b", top: 0 },
          { k: "c", top: 60 },
        ]}
        loading={false}
      />
    );

    expect(animatedKeys().sort()).toEqual(["b", "c"]);
    expect(keyframesFor("b")).toEqual([
      { transform: "translateY(60px)" },
      { transform: "translateY(0)" },
    ]);
    expect(keyframesFor("c")).toEqual([
      { transform: "translateY(60px)" },
      { transform: "translateY(0)" },
    ]);
    // A move never touches opacity; an enter always does. This is the assertion
    // the E2E [R-4] move test makes via duration (320 vs 240).
    for (const call of animateSpy.mock.calls) {
      expect((call[0] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("opacity");
    }
  });

  it("FLIP-7: a skeleton-only mount does not arm the enter branch", () => {
    const { rerender } = render(<Gated items={[]} loading />);
    rerender(
      <Gated
        items={[
          { k: "a", top: 0 },
          { k: "b", top: 60 },
          { k: "c", top: 120 },
        ]}
        loading={false}
      />
    );

    // Rows appearing for the first time after a gate is the list's FIRST paint,
    // not three entrances — fading the whole list in on every slow load is the
    // noise `hasMeasured` exists to suppress.
    expect(animateSpy).not.toHaveBeenCalled();
  });

  it("FLIP-8: a non-reordering layout shift is silent but still refreshes First", () => {
    const { rerender } = render(
      <Gated
        items={[
          { k: "a", top: 0 },
          { k: "b", top: 60 },
        ]}
        loading={false}
      />
    );
    // Same order, everything pushed down 20px (a badge appeared above the
    // list). Nothing may animate — the orderKey did not change.
    rerender(
      <Gated
        items={[
          { k: "a", top: 20 },
          { k: "b", top: 80 },
        ]}
        loading={false}
      />
    );
    expect(animateSpy, "a content-only layout shift must not animate").not.toHaveBeenCalled();

    // …but the shift must have been recorded, or the next real reorder plays
    // from a stale First and overshoots by exactly the shift (here: 80 vs 60).
    rerender(
      <Gated
        items={[
          { k: "b", top: 20 },
          { k: "a", top: 80 },
        ]}
        loading={false}
      />
    );
    expect(keyframesFor("a")).toEqual([
      { transform: "translateY(-60px)" },
      { transform: "translateY(0)" },
    ]);
    expect(keyframesFor("b")).toEqual([
      { transform: "translateY(60px)" },
      { transform: "translateY(0)" },
    ]);
  });
});
