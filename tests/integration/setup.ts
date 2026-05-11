// ============================================================
// Per-Worker Setup — Integration Tests
// ============================================================
// Runs inside each Vitest worker process BEFORE every test file.
// (global-setup.ts runs once in the main process; this file runs
// once per worker, after the worker forks.)
//
// Responsibilities:
//   1. Re-load integration env (workers are forked processes;
//      global-setup's dotenv.config() is inherited, but we
//      load again for safety and to surface clear errors).
//   2. Install the @/utils/supabase/server mock (Option B).
//      All Server Actions import createClient() from that module.
//      The mock returns a real service-role Supabase client with
//      auth.getUser() controlled via mockAuthAs().
// ============================================================

import path from "path";
import dotenv from "dotenv";
import { vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// ── 1. Load env ─────────────────────────────────────────────
dotenv.config({
  path: path.resolve(process.cwd(), "tests/integration/.env"),
});

// ── 2. Shared auth identity state ───────────────────────────
// mockAuthAs() writes here; the mocked createClient() reads it.
// Stored on the module so the mock closure captures it by reference.
export const authState: { currentUserId: string | null } = {
  currentUserId: null,
};

// ── 3. Mock @/utils/supabase/server ─────────────────────────
// vi.mock() is hoisted to the top of this file by Vitest's
// transformer, so it applies before any test file imports the
// module under test.
//
// The mock factory is called each time createClient() is invoked.
// It creates a real service-role Supabase client (no RLS) and
// wraps it in a Proxy that intercepts auth.getUser() to return
// the identity set by mockAuthAs().
//
// Why service-role?
//   • RLS is still exercised by default — service-role bypasses
//     nothing unless the query is inside a security-definer RPC.
//   • For seeds and assertions that NEED to bypass RLS, tests
//     import serviceClient() from helpers/truncate.ts directly.
//   • auth.getUser() is the only auth concern we need to fake:
//     "who is calling this action?"
vi.mock("@/utils/supabase/server", () => ({
  createClient: async (): Promise<ReturnType<typeof createSupabaseClient<Database>>> => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      throw new Error(
        "[mock createClient] NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.\n" +
          "Ensure tests/integration/.env is loaded before tests run."
      );
    }

    const supabase = createSupabaseClient<Database>(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Capture the current authState reference (not its value) so
    // that getUser() always reflects the latest mockAuthAs() call.
    const state = authState;

    // Return a Proxy that intercepts auth.getUser() only.
    // All other supabase methods (from, rpc, channel, etc.) pass
    // through transparently to the real service-role client.
    return new Proxy(supabase, {
      get(target, prop, receiver) {
        if (prop === "auth") {
          return new Proxy(Reflect.get(target, prop, receiver), {
            get(authTarget, authProp) {
              if (authProp === "getUser") {
                // Return a function (not the result) so the caller
                // gets a fresh result reflecting the CURRENT state.
                return async () => ({
                  data: {
                    user: state.currentUserId
                      ? {
                          id: state.currentUserId,
                          email: null,
                          app_metadata: {},
                          user_metadata: {},
                          aud: "authenticated",
                          created_at: new Date().toISOString(),
                        }
                      : null,
                  },
                  error: null,
                });
              }
              const val = Reflect.get(authTarget, authProp);
              return typeof val === "function" ? val.bind(authTarget) : val;
            },
          });
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    }) as ReturnType<typeof createSupabaseClient<Database>>;
  },
}));
