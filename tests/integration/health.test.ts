// ============================================================
// health.test.ts — Integration Test Smoke Test (Phase 1)
// ============================================================
// One trivial test that validates the entire integration harness:
//   • Local Supabase is reachable (caught by global-setup)
//   • The service-role client can insert a profile row
//   • The same row is readable back from the DB
//   • truncateTracked() cleans up the row in afterEach
//
// Phase 1 exit criteria: this test must pass locally AND in CI.
// No business logic is tested here — only the harness itself.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { Faker, en } from "@faker-js/faker";
import { makeProfile, makeSession } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";

// ── Faker seeded for reproducibility ─────────────────────────
// Each describe block uses its own faker instance with a fixed seed.
// Seed any integer — the value doesn't matter as long as it's constant.
const faker = new Faker({ locale: [en] });
faker.seed(1001);

// ── Cleanup after every test ──────────────────────────────────
// truncateTracked() deletes all auth.users created by makeProfile()
// in this test run, then wipes domain tables. This is Layer B isolation.
afterEach(async () => {
  await truncateTracked();
});

// ── Suite ─────────────────────────────────────────────────────

describe("Integration harness smoke test", () => {
  it("can connect to local Supabase and read the profiles table", async () => {
    // If we can query profiles without an error, the DB connection works.
    const client = serviceClient();
    const { error } = await client.from("profiles").select("count").limit(1);

    expect(error).toBeNull();
  });

  it("makeProfile creates a profile row that is visible in the DB", async () => {
    const { id, displayName } = await makeProfile({
      faker,
      skill: "intermediate",
    });

    // Assert the row exists
    const client = serviceClient();
    const { data, error } = await client
      .from("profiles")
      .select("id, display_name, skill_level")
      .eq("id", id)
      .single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.id).toBe(id);
    expect(data!.display_name).toBe(displayName);
    expect(data!.skill_level).toBe("intermediate");
  });

  it("makeSession creates a session row with the organizer in session_organizers", async () => {
    const organizer = await makeProfile({ faker, skill: "advanced" });
    const session = await makeSession({
      faker,
      organizer: organizer.id,
      scoring: "single",
    });

    const client = serviceClient();

    // Session row exists
    const { data: sessionRow, error: sessionError } = await client
      .from("sessions")
      .select("id, name, created_by, is_active")
      .eq("id", session.id)
      .single();

    expect(sessionError).toBeNull();
    expect(sessionRow!.id).toBe(session.id);
    expect(sessionRow!.created_by).toBe(organizer.id);
    expect(sessionRow!.is_active).toBe(true);

    // Organizer row exists in session_organizers
    const { data: orgRow, error: orgError } = await client
      .from("session_organizers")
      .select("user_id")
      .eq("session_id", session.id)
      .eq("user_id", organizer.id)
      .single();

    expect(orgError).toBeNull();
    expect(orgRow!.user_id).toBe(organizer.id);
  });

  it("truncateTracked removes created rows after the test", async () => {
    // Create a profile, capture its ID, then manually call truncateTracked.
    // We then check the row is gone.
    const { id } = await makeProfile({ faker, skill: "beginner" });

    // Truncate now (without waiting for afterEach)
    await truncateTracked();

    const client = serviceClient();
    const { data } = await client.from("profiles").select("id").eq("id", id).maybeSingle();

    // Row should be gone
    expect(data).toBeNull();
  });
});
