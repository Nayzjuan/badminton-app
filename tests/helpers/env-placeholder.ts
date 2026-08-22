// ============================================================
// env-placeholder.ts — shared "is this actually filled in?" test
// ============================================================
// Both the E2E fixture (tests/fixtures/auth.ts) and the sandbox
// initialiser (tests/helpers/init-sandbox.ts) validate the same
// three organizer-bot variables. They MUST agree on what counts
// as unset, or a value one accepts and the other rejects turns a
// clear startup error into a confusing mid-run auth failure.
//
// .env.test.example carries two placeholder shapes, neither of
// them a usable value:
//   TEST_ORGANIZER_PASSWORD=<generate-a-fresh-password>
//   SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
//
// The second is detected by its trailing ellipsis rather than by
// the base64 of {"alg":"HS256","typ":"JWT"}: keying on that exact
// header meant an example file that switched `alg`, or moved to
// Supabase's non-JWT `sb_secret_*` keys, would silently stop
// matching. No real secret ends in an ellipsis, so this cannot
// misread a genuine value as a placeholder.
// ============================================================

export function isPlaceholderValue(value: string | undefined): boolean {
  return !value || /^<.*>$/.test(value) || value.endsWith("...");
}

// Same test, expressed as a type guard so a caller that throws on a placeholder
// keeps a narrowed `string` afterwards. Defined as the negation rather than
// restated, so the two can never disagree — which is the whole point of this
// module.
export function isFilledValue(value: string | undefined): value is string {
  return !isPlaceholderValue(value);
}
