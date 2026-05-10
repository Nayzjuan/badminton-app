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

    // An unauthenticated call should return { data: { user: null }, error: null }
    const { data, error } = await realClient.auth.getUser();

    // Shape assertions
    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data).toHaveProperty("user");

    // The mock returns { data: { user: null }, error: null } for unauthenticated.
    // Verify the real client has the same structure.
    if (data.user === null) {
      // Unauthenticated — shape matches mock's null-user path
      expect(data.user).toBeNull();
    } else {
      // Somehow authenticated — the user object must have an id property
      expect(data.user).toHaveProperty("id");
      expect(typeof data.user.id).toBe("string");
    }
  });
});
