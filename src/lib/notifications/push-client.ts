// ============================================================
// Push Client — Service Worker registration + subscription
// ============================================================
// All functions are safe to call in a browser-only context.
// They return null / false silently on SSR or when the APIs
// are unavailable (iOS Safari without permission, etc.).
// ============================================================

import { createBrowserSupabaseClient } from "@/utils/supabase/client";

// ── Constants ────────────────────────────────────────────────

const SW_PATH = "/sw.js";

// localStorage key used to remember that the user has already
// made a choice (granted OR denied), so we don't re-prompt.
export const PUSH_PROMPT_DISMISSED_KEY = "pocket_ping_prompt_dismissed";

// ── Service Worker registration ─────────────────────────────

/**
 * Register the service worker and return the registration.
 * Safe to call multiple times — the browser deduplicates.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined") return null;
  if (!("serviceWorker" in navigator)) return null;

  try {
    const registration = await navigator.serviceWorker.register(SW_PATH, {
      scope: "/",
    });
    return registration;
  } catch (err) {
    console.error("[push-client] SW registration failed:", err);
    return null;
  }
}

// ── VAPID public key conversion ──────────────────────────────

/**
 * Convert the VAPID public key (base64url) to a Uint8Array
 * for `pushManager.subscribe()`.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// ── Subscribe ────────────────────────────────────────────────

/**
 * Subscribe to Web Push for the current user and persist the
 * subscription to Supabase.
 *
 * Requires NEXT_PUBLIC_VAPID_PUBLIC_KEY in the environment.
 * Returns true on success, false if anything fails.
 */
export async function subscribeAndPersist(userId: string): Promise<boolean> {
  if (typeof window === "undefined") return false;

  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) {
    console.error("[push-client] NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set");
    return false;
  }

  // 1. Register the SW (idempotent).
  const registration = await registerServiceWorker();
  if (!registration) return false;

  // 2. Subscribe via the Push API.
  let subscription: PushSubscription | null = null;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      // Cast needed because TypeScript's lib.dom types parameterize Uint8Array
      // with ArrayBufferLike which is wider than ArrayBuffer. The Push API
      // accepts Uint8Array at runtime regardless of the buffer type.
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as unknown as BufferSource,
    });
  } catch (err) {
    console.error("[push-client] pushManager.subscribe failed:", err);
    return false;
  }

  // 3. Extract encryption keys.
  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (!p256dh || !auth) return false;

  const p256dhBase64 = btoa(String.fromCharCode(...new Uint8Array(p256dh)));
  const authBase64 = btoa(String.fromCharCode(...new Uint8Array(auth)));

  // 4. Persist to Supabase (upsert so re-registrations don't error).
  const supabase = createBrowserSupabaseClient();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint: subscription.endpoint,
      p256dh: p256dhBase64,
      auth_key: authBase64,
      user_agent: navigator.userAgent.slice(0, 200),
    },
    { onConflict: "user_id,endpoint" }
  );

  if (error) {
    console.error("[push-client] Failed to persist subscription:", error);
    return false;
  }

  return true;
}

// ── Unsubscribe ──────────────────────────────────────────────

/**
 * Unsubscribe from Web Push and remove from Supabase.
 */
export async function unsubscribeAndRemove(userId: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();

      const supabase = createBrowserSupabaseClient();
      await supabase
        .from("push_subscriptions")
        .delete()
        .eq("user_id", userId)
        .eq("endpoint", endpoint);
    }
    return true;
  } catch (err) {
    console.error("[push-client] Unsubscribe failed:", err);
    return false;
  }
}

// ── Permission helpers ────────────────────────────────────────

/** Returns true if Web Push is available in this browser. */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

/** Returns the current Notification.permission value, or 'denied' on SSR. */
export function getNotificationPermission(): NotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "denied";
  }
  return Notification.permission;
}

/**
 * Check if the user has already made a decision (dismissed the soft prompt,
 * or previously granted/denied the browser permission).
 */
export function hasUserMadeChoice(): boolean {
  if (typeof window === "undefined") return true; // SSR: treat as decided
  const perm = getNotificationPermission();
  if (perm !== "default") return true; // Browser already has an answer
  try {
    return localStorage.getItem(PUSH_PROMPT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Mark the soft prompt as dismissed (so it won't re-appear this device). */
export function markPromptDismissed(): void {
  try {
    localStorage.setItem(PUSH_PROMPT_DISMISSED_KEY, "1");
  } catch {
    // localStorage may be blocked in private browsing — safe to ignore
  }
}
