/**
 * sanitizeScore — input sanitiser for the player score entry field.
 *
 * Strategy: permissive on type, strict on submit.
 *
 *   • Strips anything that isn't a digit (letters, decimals, signs).
 *   • Preserves the empty string so users can clear the field.
 *   • Caps the length at 3 digits to prevent pathological input
 *     ("9999999"), but does NOT clamp the numeric value. This is the
 *     fix for the editing bug: clamping in onChange makes it impossible
 *     to lower a score from e.g. "30" to "29" because the cursor-based
 *     intermediate values silently re-clamp back to "30".
 *
 *   • Range validation (0–30) happens ONLY at submit time in
 *     ScoreInputCard.handleSubmit, where the user sees a clear error
 *     and can correct freely.
 */
export function sanitizeScore(val: string): string {
  if (val === "") return "";
  const digits = val.replace(/\D+/g, "");
  if (digits === "") return "";
  return digits.slice(0, 3);
}
