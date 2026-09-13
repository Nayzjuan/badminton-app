// ============================================================
// Suite LAS — lookup_active_session, the public join-link RPC
// ============================================================
// /j/[sessionId] and /c/[slug]/join/[sessionId] decide whether to
// render the join form or bounce to /play from this one function.
// A silent grant revoke or a column drop 404s every shared link.
//
//   LAS-1  anon can look up an active factory session and gets
//          id / name / is_active / club_slug
//   LAS-2  closeSession empties the next lookup
//          (the transition OUT of the joinable state)
//   LAS-3  an unknown uuid is empty — not an error, not a leak
//   LAS-4  the row is exactly those four keys (no passcode)
//   LAS-5  catalog pin: anon still holds EXECUTE
//
// Isolation: Layer B — truncateTracked() in afterEach.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { Faker, en } from "@faker-js/faker";
import type { Database } from "@/types/database";
import { makeProfile, makeSession } from "./factories";
import { serviceClient, truncateTracked } from "./helpers/truncate";
import { withTx } from "./helpers/withTx";
import { mockAuthAs, clearMockAuth } from "./helpers/mock-auth";
import { closeSession } from "@/app/actions/sessions";

const faker = new Faker({ locale: [en] });
faker.seed(19013);

afterEach(async () => {
  clearMockAuth();
  await truncateTracked();
});

function anonClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

async function clubSlugFor(sessionId: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("sessions")
    .select("club_id, clubs(slug)")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error(`clubSlugFor: ${error.message}`);
  const club = data?.clubs as unknown as { slug: string } | null;
  if (!club?.slug) throw new Error(`clubSlugFor: session ${sessionId} has no club slug`);
  return club.slug;
}

describe("lookup_active_session — Suite LAS", () => {
  it("LAS-1: anon lookup of an active session returns id, name, is_active, club_slug", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id, name: "Thursday Join" });
    const slug = await clubSlugFor(session.id);

    const { data, error } = await anonClient().rpc("lookup_active_session", {
      p_session_id: session.id,
    });
    expect(error, error?.message).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toEqual({
      id: session.id,
      name: "Thursday Join",
      is_active: true,
      club_slug: slug,
    });
  });

  it("LAS-2: closing the session makes the next lookup empty", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });

    const live = await anonClient().rpc("lookup_active_session", { p_session_id: session.id });
    expect(live.data).toHaveLength(1);

    const restore = mockAuthAs(organizer.id);
    try {
      const closed = await closeSession(session.id);
      expect(closed.success, closed.message).toBe(true);
    } finally {
      restore();
    }

    const { data, error } = await anonClient().rpc("lookup_active_session", {
      p_session_id: session.id,
    });
    expect(error, error?.message).toBeNull();
    expect(data).toEqual([]);
  });

  it("LAS-3: an unknown uuid is empty, not an error", async () => {
    const { data, error } = await anonClient().rpc("lookup_active_session", {
      p_session_id: "00000000-0000-4000-8000-00000000dead",
    });
    expect(error, error?.message).toBeNull();
    expect(data).toEqual([]);
  });

  it("LAS-4: the row is exactly four keys — no organizer_passcode, no created_by", async () => {
    const organizer = await makeProfile({ faker });
    const session = await makeSession({ faker, organizer: organizer.id });
    const { data } = await anonClient().rpc("lookup_active_session", {
      p_session_id: session.id,
    });
    expect(data).toHaveLength(1);
    expect(Object.keys(data![0]).sort()).toEqual(["club_slug", "id", "is_active", "name"]);
  });

  it("LAS-5: anon still holds EXECUTE on lookup_active_session(uuid)", async () => {
    await withTx(async (db) => {
      const { rows } = await db.query<{ ok: boolean }>(
        `select has_function_privilege('anon', 'public.lookup_active_session(uuid)', 'EXECUTE') as ok`
      );
      expect(rows[0]?.ok).toBe(true);
    });
  });
});
