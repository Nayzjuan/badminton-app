// ============================================================
// PIN generation — shared, cryptographically-secure 4-digit PIN
// ============================================================
// Used for reconnect-by-(name + PIN). Centralised so OAuth signups,
// PIN resets, and anonymous registration mint PINs identically.
// Web Crypto (crypto.getRandomValues) is available in both the Node
// runtime and the browser, so this is safe to import from either.
// ============================================================

/** Returns a cryptographically-random 4-digit PIN in the range 1000–9999. */
export function generatePin(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(1000 + (arr[0] % 9000));
}
