// ============================================================
// install-detection — PWA platform + install-state helpers
// ============================================================
// Browser-only utilities used to decide whether to show an
// "Add to Home Screen" prompt. All functions are SSR-safe and
// return false on the server (typeof window === "undefined").
//
// WHY THIS MATTERS FOR PUSH:
//   iOS only delivers Web Push to an INSTALLED PWA (added to the
//   Home Screen, iOS 16.4+). A player in a Safari tab can't enroll
//   at all. So on iOS-not-installed we show an install hint instead
//   of the (non-functional) "Enable Pings" prompt.
// ============================================================

/**
 * True when the app is running as an installed PWA (standalone display
 * mode on Android/desktop, or `navigator.standalone` on iOS Safari).
 */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const displayModeStandalone =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  // iOS Safari exposes a non-standard `navigator.standalone` boolean.
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayModeStandalone || iosStandalone;
}

/**
 * True on iOS / iPadOS devices, including iPadOS that masquerades as
 * "Macintosh" (reported as MacIntel but with a touch screen).
 */
export function isIOS(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ on Safari reports as a Mac; distinguish via touch points.
  const isIPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return isIPadOS;
}

/** True on Android devices. */
export function isAndroid(): boolean {
  if (typeof window === "undefined") return false;
  return /Android/.test(navigator.userAgent || "");
}
