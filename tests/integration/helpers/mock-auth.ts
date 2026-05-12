// ============================================================
// mock-auth.ts — Per-Test Auth Identity Control
// ============================================================
// The @/utils/supabase/server mock (installed in setup.ts) reads
// authState.currentUserId to decide what auth.getUser() returns.
//
// Usage in a test:
//
//   import { mockAuthAs } from "../helpers/mock-auth";
//
//   it("organizer can close session", async () => {
//     const restore = mockAuthAs(organizerId);
//     const result = await closeSession(sessionId);
//     restore();
//     expect(result.success).toBe(true);
//   });
//
// Or with beforeEach/afterEach:
//
//   let restore: () => void;
//   beforeEach(() => { restore = mockAuthAs(organizerId); });
//   afterEach(() => restore());
//
// The returned restore() MUST always be called — use try/finally
// or afterEach to guarantee cleanup even when tests fail.
// ============================================================

import { authState } from "../setup";

/**
 * Sets the mocked authenticated user for the duration of a test.
 *
 * @param userId - The Supabase user ID to impersonate.
 *                 Must match an existing row in profiles.
 * @returns A restore function that clears the mock identity.
 *          Always call it (in afterEach or try/finally).
 */
export function mockAuthAs(userId: string): () => void {
  authState.currentUserId = userId;
  return () => {
    authState.currentUserId = null;
  };
}

/**
 * Clears the mocked auth identity (sets to unauthenticated).
 * Equivalent to calling the restore function returned by mockAuthAs().
 */
export function clearMockAuth(): void {
  authState.currentUserId = null;
}
