"use client";

// ============================================================
// useFlipList — dependency-free FLIP animation for keyed lists
// ============================================================
// The queue reorders after every match (games_played / joined_at resort) and
// rows previously teleported to their new slots. This hook animates each
// surviving row from its old vertical position to its new one (FLIP: measure
// First, Last, Invert, Play) and fades new rows in, using the Web Animations
// API directly — no animation library in the bundle.
//
// Positions are measured with offsetTop (layout-relative), NOT
// getBoundingClientRect().top — the viewport-relative value changes when the
// user scrolls, which would read as a phantom reorder on the next commit.
//
// Reduced motion: WAAPI animations are not CSS animations, so the global
// prefers-reduced-motion block in globals.css cannot reach them — checked
// here explicitly instead. jsdom lacks el.animate; guarded for tests.

import { useLayoutEffect, useRef } from "react";

const MOVE_MS = 320;
const ENTER_MS = 240;
// Ease-out-quint-ish: fast start, long settle — reads as "snapping into rank".
const MOVE_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

/**
 * @param orderKey a string that changes exactly when the list's membership or
 *   order changes (e.g. `items.map(i => i.id).join(",")`). Content-only
 *   changes (a stat ticking up in place) intentionally do not animate.
 *
 *   ⚠️ CONTRACT: build it as a bare join over exactly the rows you render, so
 *   that `orderKey === ""` means "the list is genuinely empty" and nothing
 *   else. The zero-row guard below relies on it. Prefixing the key
 *   (`` `skill:${ids.join(",")}` ``) or joining a superset of the rendered rows
 *   makes an empty list produce a non-empty key, and the hook can no longer
 *   tell "empty" from "the host rendered a loading gate".
 * @param opts.animateEnter false when the list's items own their entrance
 *   (e.g. a tailwind `animate-in` on the item root) — FLIP then animates
 *   MOVES only, so the two systems never fight over transform/opacity.
 * @returns `register(key)` — call in render to get the ref callback for that
 *   key's row element.
 */
export function useFlipList(orderKey: string, opts?: { animateEnter?: boolean }) {
  const animateEnter = opts?.animateEnter ?? true;
  const itemEls = useRef(new Map<string, HTMLElement>());
  const prevTops = useRef(new Map<string, number>());
  // First commit only records positions — animating 30+ rows "entering" on
  // mount (and on every return to the tab) would be noise, not feedback.
  // Only armed once we have actually held row positions: arming it on a
  // zero-row commit is what let a loading skeleton fade the whole list in.
  const hasMeasured = useRef(false);
  // Tracked here rather than via the effect's dependency array — see below.
  const prevOrderKey = useRef<string | null>(null);

  const register = (key: string) => (el: HTMLElement | null) => {
    if (el) itemEls.current.set(key, el);
    else itemEls.current.delete(key);
  };

  // Deliberately no dependency array. `orderKey` changing is NOT the same
  // event as "the rows are on screen": every caller renders the list behind a
  // gate (`if (loading)` in waitlist-tab / live-courts-tab, the By-Skill lens
  // in queue-control), so the order can change while nothing is rendered, and
  // the commit that finally paints the rows changes no key at all. Keyed on
  // [orderKey] the effect would never measure them, leave prevTops empty, and
  // make the next genuine reorder read as a set of entrances (240ms fade)
  // instead of moves (320ms translateY). Re-measuring every commit also keeps
  // First honest across non-reordering layout shifts (a badge appearing, a
  // font landing), which a keyed effect silently got wrong.
  useLayoutEffect(() => {
    // This commit rendered none of the list's rows: it is a gate, not a state.
    // Overwriting prevTops here discards every First position. `orderKey === ""`
    // is the genuinely-empty list (every caller joins an array), which MUST
    // still be recorded — otherwise a list that empties out keeps stale tops.
    if (itemEls.current.size === 0 && orderKey !== "") return;

    const orderChanged = prevOrderKey.current !== orderKey;
    prevOrderKey.current = orderKey;

    const nextTops = new Map<string, number>();
    itemEls.current.forEach((el, key) => nextTops.set(key, el.offsetTop));

    // matchMedia is evaluated lazily, inside the guard: without a dependency
    // array this effect runs on EVERY commit of every host, and each call
    // parses the query and allocates a MediaQueryList. Only the animating
    // branch needs the answer.
    if (hasMeasured.current && orderChanged && !prefersReducedMotion()) {
      nextTops.forEach((top, key) => {
        const el = itemEls.current.get(key);
        if (!el || typeof el.animate !== "function") return;
        const prevTop = prevTops.current.get(key);
        if (prevTop === undefined) {
          if (!animateEnter) return;
          // New row — slide-fade into its slot.
          el.animate(
            [
              { opacity: 0, transform: "translateY(-6px)" },
              { opacity: 1, transform: "translateY(0)" },
            ],
            { duration: ENTER_MS, easing: "ease-out" }
          );
        } else {
          const dy = prevTop - top;
          if (Math.abs(dy) > 1) {
            // Surviving row that changed rank — play from the old slot.
            el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
              duration: MOVE_MS,
              easing: MOVE_EASE,
            });
          }
        }
      });
    }

    prevTops.current = nextTops;
    // Trade-off, deliberate — and NARROWER than it looks. `hasMeasured` is
    // never reset, so this only ever costs the FIRST row-holding commit a hook
    // instance ever makes (all of its rows, not one): a list that had rows,
    // emptied, and refills DOES fade the new ones. That first commit is the
    // mount silence this hook has always wanted anyway — see the note on
    // `hasMeasured` above. The cause is that a zero-row commit and a gated
    // commit are indistinguishable from in here, and staying silent on a
    // never-populated list is much cheaper than fading the whole list in on
    // every slow page load. (Arming on `orderKey === ""` instead would make the
    // gated mount look like a real empty list and re-open exactly that bug.)
    if (nextTops.size > 0) hasMeasured.current = true;
  });

  return register;
}
