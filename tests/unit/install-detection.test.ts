// @vitest-environment happy-dom
// ============================================================
// Unit Tests — PWA install detection
// ============================================================
// Covers src/lib/pwa/install-detection.ts:
//   ID-1 isIOS: iPhone / iPad / iPod user agents
//   ID-2 isIOS: iPadOS-on-Mac (MacIntel + touch points)
//   ID-3 isIOS: false on Mac without touch + on Android
//   ID-4 isAndroid: true on Android, false on iPhone
//   ID-5 isStandalone: display-mode standalone OR navigator.standalone
//   ID-6 isStandalone: false when neither signal is set
// ============================================================

import { describe, it, expect, afterEach, vi } from "vitest";
import { isIOS, isAndroid, isStandalone } from "@/lib/pwa/install-detection";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120";

function stubNavigator(nav: Partial<Navigator>) {
  Object.defineProperty(globalThis, "navigator", {
    value: nav,
    writable: true,
    configurable: true,
  });
}

function stubStandalone(displayMatches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    value: (q: string) => ({ matches: q.includes("standalone") ? displayMatches : false }),
    writable: true,
    configurable: true,
  });
}

describe("install-detection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── ID-1 ────────────────────────────────────────────────────
  it("ID-1: isIOS true for iPhone / iPad / iPod UAs", () => {
    stubNavigator({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
    expect(isIOS()).toBe(true);
    stubNavigator({ userAgent: IPAD_UA, platform: "iPad", maxTouchPoints: 5 });
    expect(isIOS()).toBe(true);
  });

  // ── ID-2 ────────────────────────────────────────────────────
  it("ID-2: isIOS true for iPadOS masquerading as MacIntel with touch", () => {
    stubNavigator({ userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 5 });
    expect(isIOS()).toBe(true);
  });

  // ── ID-3 ────────────────────────────────────────────────────
  it("ID-3: isIOS false for a real Mac (no touch) and for Android", () => {
    stubNavigator({ userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 0 });
    expect(isIOS()).toBe(false);
    stubNavigator({ userAgent: ANDROID_UA, platform: "Linux armv8l", maxTouchPoints: 5 });
    expect(isIOS()).toBe(false);
  });

  // ── ID-4 ────────────────────────────────────────────────────
  it("ID-4: isAndroid true on Android, false on iPhone", () => {
    stubNavigator({ userAgent: ANDROID_UA, platform: "Linux armv8l", maxTouchPoints: 5 });
    expect(isAndroid()).toBe(true);
    stubNavigator({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 });
    expect(isAndroid()).toBe(false);
  });

  // ── ID-5 ────────────────────────────────────────────────────
  it("ID-5: isStandalone true via display-mode OR navigator.standalone", () => {
    // display-mode: standalone matches
    stubNavigator({ userAgent: ANDROID_UA });
    stubStandalone(true);
    expect(isStandalone()).toBe(true);

    // iOS navigator.standalone flag
    stubNavigator({ userAgent: IPHONE_UA, standalone: true } as Partial<Navigator>);
    stubStandalone(false);
    expect(isStandalone()).toBe(true);
  });

  // ── ID-6 ────────────────────────────────────────────────────
  it("ID-6: isStandalone false when neither signal is present", () => {
    stubNavigator({ userAgent: IPHONE_UA, standalone: false } as Partial<Navigator>);
    stubStandalone(false);
    expect(isStandalone()).toBe(false);
  });
});
