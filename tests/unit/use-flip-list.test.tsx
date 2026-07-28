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
// IDs: FLIP-1 … FLIP-5
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
});
