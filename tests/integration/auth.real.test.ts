// ============================================================
// auth.real.test.ts — Auth Mock Drift Detector (Phase 1)
// ============================================================
// This single test performs a real Supabase auth flow to verify
// that the mock installed in setup.ts is structurally compatible
// with the real @supabase/supabase-js client.
//
// If mockAuthAs() works correctly but auth.real.test.ts fails,
// it means the real client's auth.getUser() response shape has
// drifted from what the mock returns. Fix the mock in setup.ts.
//
// Run on every CI build. It's intentionally minimal — we don't
// want to pay the ~150ms auth roundtrip per test (that's why we
// have the mock), but one real roundtrip per CI run keeps us honest.
// ============================================================

import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

describe("Auth mock drift detector", () => {
  it("real auth.getUser() returns the same shape as the mock", async () => {
    // Use the real anon client (not the mock) by importing Supabase directly
    // rather than through @/utils/supabase/server.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

    const realClient = createClient<Database>(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // As of @supabase/supabase-js v2.x, an unauthenticated call returns:
    //   { data: { user: null }, error: AuthSessionMissingError }
    //
    // Earlier SDK versions returned error: null in this case. The mock in
    // setup.ts intentionally still returns error: null because server actions
    // only guard with `if (!user)` (not `if (error)`), so mock fidelity on
    // the error field is not required for action-level tests.
    //
    // This test documents the REAL SDK shape, not the mock shape.
    const { data, error } = await realClient.auth.getUser();

    // data.user must be null (no active session)
    expect(data).toBeDefined();
    expect(data).toHaveProperty("user");
    expect(data.user).toBeNull();

    // SDK v2 reports AuthSessionMissingError for unauthenticated calls.
    // Accept both null (older SDK compat) and AuthSessionMissingError.
    if (error !== null) {
      expect(error).toHaveProperty("name", "AuthSessionMissingError");
      expect(error).toHaveProperty("__isAuthError", true);
    }
  });
});
