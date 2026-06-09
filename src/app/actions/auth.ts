"use server";

// ============================================================
// Auth Server Actions
// ============================================================
// Handles anonymous sign-in with PIN, duplicate name check,
// and reconnect flow for returning players.
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { redirect } from "next/navigation";
import type { SkillLevel } from "@/types/database";
import { displayNameSchema, pinSchema, skillLevelSchema } from "@/lib/schemas/auth";
import { isNameTaken } from "@/lib/dup-name";

// Shared friendly message for a globally-taken display name.
const NAME_TAKEN_MESSAGE = 'Name taken. Add an initial (e.g. "Miggy L.").';

// Escape ILIKE special characters so a caller-supplied string is always
// treated as a literal — never as a wildcard pattern.
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

// ── Registration ────────────────────────────────────────────

export async function signInAnonymously(formData: FormData) {
  const rawName = formData.get("display_name") as string | null;
  const rawSkillLevel = formData.get("skill_level");
  const rawPin = formData.get("pin") as string | null;
  // Optional: if joining via QR/link, redirect straight to that session.
  const sessionId = (formData.get("session_id") as string)?.trim() || null;
  const destination = sessionId ? `/play/${sessionId}` : "/play";

  // ── Zod validation ───────────────────────────────────────
  const nameResult = displayNameSchema.safeParse(rawName ?? "");
  if (!nameResult.success) {
    return { success: false, error: nameResult.error.issues[0].message };
  }
  const displayName = nameResult.data; // trimmed + spaces collapsed

  // Validate skillLevel against the canonical SkillLevel enum at runtime —
  // `as SkillLevel` is a compile-time cast only and would silently pass any
  // arbitrary string from a crafted FormData payload.
  const skillLevelResult = skillLevelSchema.safeParse(rawSkillLevel);
  if (!skillLevelResult.success) {
    return { success: false, error: skillLevelResult.error.issues[0].message };
  }
  const skillLevel: SkillLevel = skillLevelResult.data;

  const pinResult = pinSchema.safeParse(rawPin ?? "");
  if (!pinResult.success) {
    return { success: false, error: pinResult.error.issues[0].message };
  }
  const pin = pinResult.data;

  const supabase = await createServerSupabaseClient();

  // Check if already signed in.
  const {
    data: { user: existingUser },
  } = await supabase.auth.getUser();

  const service = createServiceClient();

  if (existingUser) {
    // Already authenticated — upsert the profile. Upsert (not update) so an
    // authed-but-profileless user (e.g. a merged-away ghost's stale cookie)
    // RE-CREATES their missing profile here instead of a no-op update, which is
    // what breaks the profileless redirect loop. The partial UNIQUE index is the
    // authority for global name uniqueness, so a taken name surfaces as 23505.
    const { error: upsertError } = await supabase
      .from("profiles")
      .upsert(
        { id: existingUser.id, display_name: displayName, skill_level: skillLevel, pin },
        { onConflict: "id" }
      );

    if (upsertError) {
      if (upsertError.code === "23505") {
        return { success: false, error: NAME_TAKEN_MESSAGE };
      }
      return { success: false, error: upsertError.message };
    }

    redirect(destination);
  }

  // ── Returning player check (must precede the uniqueness block) ─────────────
  // If a profile already exists with this exact name + PIN, the player is
  // returning and should use Reconnect instead of registering fresh. This runs
  // BEFORE the global-uniqueness check so a legitimate returning player (whose
  // name necessarily already exists) is routed to Reconnect rather than told
  // "name taken". Without it, they'd silently create a duplicate ghost profile.
  const { data: existingProfile } = await service
    .from("profiles")
    .select("id")
    .ilike("display_name", escapeLike(displayName))
    .eq("pin", pin)
    .limit(1)
    .single();

  if (existingProfile) {
    return {
      success: false,
      error:
        'Looks like you\'ve played before! Use "Reconnect" below to pick up where you left off.',
    };
  }

  // ── Global uniqueness check (R2) ──────────────────────────────────────────
  // The display name must be unique across ALL profiles — not merely those
  // currently active in a queue (the previous, weaker rule). Gives a friendly
  // message before an orphan auth user is minted; the partial UNIQUE index is
  // the cross-instance/TOCTOU authority and the upsert below maps its 23505.
  if (await isNameTaken(service, displayName)) {
    return { success: false, error: NAME_TAKEN_MESSAGE };
  }

  // Sign in anonymously. Supabase creates an auth.users row
  // and our trigger auto-creates the profiles row.
  const { data, error } = await supabase.auth.signInAnonymously({
    options: {
      data: {
        display_name: displayName,
        skill_level: skillLevel,
      },
    },
  });

  if (error) {
    return { success: false, error: error.message };
  }

  // The trigger should have created the profile, but if the metadata
  // didn't propagate, fire an upsert as a safety net (with PIN).
  // Awaited so we can surface DB-level errors (e.g. 23505 unique violation).
  if (data.user) {
    const { error: upsertError } = await supabase.from("profiles").upsert(
      {
        id: data.user.id,
        display_name: displayName,
        skill_level: skillLevel,
        pin,
      },
      { onConflict: "id" }
    );

    if (upsertError) {
      // PostgreSQL unique violation — display_name already registered
      if (upsertError.code === "23505") {
        return {
          success: false,
          error: "That name is already taken! Try adding a number or your initial.",
        };
      }
      console.error("[auth] profile upsert safety-net failed:", upsertError);
    }
  }

  redirect(destination);
}

// ── Reconnect ────────────────────────────────────────────────
// Finds an existing player by name + PIN across active sessions,
// creates a new anonymous auth identity, and migrates all DB
// references (profiles, queue_entries, match_players) from the
// old user ID to the new one.

export interface ReconnectResult {
  success: boolean;
  error?: string;
  /** ID of an active session to rejoin, if one was found. */
  sessionId?: string;
  /** Set when the reconnected profile is a flagged duplicate (→ /rename). */
  requiresRename?: boolean;
  /**
   * If the player's most recent session has already closed and Wrapped stats
   * exist, this is set to the /wrapped URL so the caller can redirect them
   * directly to their results instead of dropping them on the lobby.
   */
  wrappedUrl?: string;
}

export async function reconnectPlayer(playerName: string, pin: string): Promise<ReconnectResult> {
  // Validate via Zod — same rules as registration
  const nameResult = displayNameSchema.safeParse(playerName ?? "");
  if (!nameResult.success) {
    return { success: false, error: nameResult.error.issues[0].message };
  }
  const name = nameResult.data; // trimmed + normalized

  const pinResult = pinSchema.safeParse(pin ?? "");
  if (!pinResult.success) {
    return { success: false, error: pinResult.error.issues[0].message };
  }
  const service = createServiceClient();

  // Find the profile by name + PIN (case-insensitive name match).
  const { data: profiles } = await service
    .from("profiles")
    .select("*")
    .ilike("display_name", escapeLike(name))
    .eq("pin", pinResult.data);

  if (!profiles || profiles.length === 0) {
    return { success: false, error: "No match found. Check your name and PIN." };
  }

  // Pick the best profile across all matches, in three phases:
  //
  // Phase 1: active queue entry (waiting / on_deck / playing) → highest priority.
  // Phase 2: pending / in_progress match assignment → still in a live game.
  // Phase 3: most-recently-joined queue entry (any status) → picks the account
  //          with real history rather than a ghost profile that has no data.
  //          Fixes the bug where only profiles[0] was checked, causing reconnect
  //          to target a ghost account and silently migrate nothing.
  //
  // Fall-through: if none of the above match, keep profiles[0] as the target.

  let targetProfile = profiles[0];
  let targetSessionId: string | null = null;

  // Phase 1 — active queue entry.
  for (const profile of profiles) {
    const { data: activeEntry } = await service
      .from("queue_entries")
      .select("session_id, sessions!inner(is_active)")
      .eq("player_id", profile.id)
      .in("status", ["waiting", "drafted", "on_deck", "playing"])
      .limit(1)
      .single();

    if (activeEntry) {
      targetProfile = profile;
      targetSessionId = activeEntry.session_id;
      break;
    }
  }

  // Phase 2 — pending / in_progress match (loop all profiles).
  if (!targetSessionId) {
    for (const profile of profiles) {
      const { data: activeMatch } = await service
        .from("match_players")
        .select("matches!inner(session_id, status)")
        .eq("player_id", profile.id)
        .limit(1)
        .single();

      if (activeMatch && activeMatch.matches) {
        const match = activeMatch.matches as unknown as { session_id: string; status: string };
        if (match.status === "pending" || match.status === "in_progress") {
          targetProfile = profile;
          targetSessionId = match.session_id;
          break;
        }
      }
    }
  }

  // Phase 3 — most recent queue history across ALL profiles (any status).
  // This prevents targeting a ghost profile (0 games) when a real profile
  // with actual data exists but whose queue entry is status="left".
  if (!targetSessionId) {
    let bestJoinedAt: Date | null = null;

    for (const profile of profiles) {
      const { data: anyEntry } = await service
        .from("queue_entries")
        .select("session_id, joined_at, sessions!inner(is_active)")
        .eq("player_id", profile.id)
        .order("joined_at", { ascending: false })
        .limit(1)
        .single();

      if (anyEntry) {
        const joinedAt = new Date(anyEntry.joined_at as string);
        if (!bestJoinedAt || joinedAt > bestJoinedAt) {
          bestJoinedAt = joinedAt;
          targetProfile = profile;
          // If this session is still active, capture it.
          const sessionMeta = anyEntry.sessions as unknown as { is_active: boolean };
          if (sessionMeta?.is_active) {
            targetSessionId = anyEntry.session_id;
          }
        }
      }
    }
  }

  // No active session — proceed with migration so the auth cookie is set,
  // then the caller redirects to the lobby (/play) instead of crashing.
  // targetSessionId remains null here; the return below handles it.

  const oldUserId = targetProfile.id;

  // Create a new anonymous auth session for this browser.
  // IMPORTANT: signInAnonymously returns the EXISTING user unchanged when a
  // session is already present (Supabase documented behaviour). If that happens,
  // newUserId === oldUserId and migrate_player_identity throws its same-UUID
  // safety guard → "Failed to migrate". Sign out first to guarantee a fresh
  // identity is minted, regardless of whether the player still has a cookie.
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();

  const { data: authData, error: authError } = await supabase.auth.signInAnonymously({
    options: {
      data: {
        display_name: targetProfile.display_name,
        skill_level: targetProfile.skill_level,
      },
    },
  });

  if (authError || !authData.user) {
    return { success: false, error: authError?.message ?? "Failed to create session." };
  }

  const newUserId = authData.user.id;

  // Defense-in-depth: if signOut() failed to clear the server-side cookie
  // (e.g. hosting environment quirk), signInAnonymously could still return
  // the existing session, making newUserId === oldUserId.  The SQL function
  // has a same-UUID guard that would throw, but catching it here first gives
  // a cleaner error path and keeps the orphaned new-auth-user cleanup in JS
  // rather than relying on the SQL rollback to surface it.
  if (newUserId === oldUserId) {
    console.error(
      "[reconnectPlayer] signInAnonymously returned the same UUID as the target profile — " +
        "sign-out did not clear the session. Player should retry.",
      { oldUserId }
    );
    return { success: false, error: "Session conflict — please sign out and try again." };
  }

  // ── Migrate all references from old ID to new ID (atomic) ──
  // Steps 1–5 run inside migrate_player_identity(), a single
  // Postgres transaction (migration 20260429000000_wave2_atomicity).
  // Any failure in steps 1–4.5 (the fatal path) rolls back all DB
  // writes so neither player is left in a broken half-migrated state.
  // Steps 4.6 (wrapped_stats) and 4.7 (session_organizers) are
  // wrapped in savepoint blocks and are non-fatal.
  //
  // Step 6 (auth.admin.deleteUser) cannot live in a Postgres function
  // so it remains here, gated on the isActiveOrganizer return value.
  const { data: isActiveOrganizer, error: migrateErr } = await service.rpc(
    "migrate_player_identity",
    { p_old_user_id: oldUserId, p_new_user_id: newUserId }
  );

  if (migrateErr) {
    console.error("[reconnectPlayer] migrate_player_identity RPC failed:", migrateErr.message);
    // The transaction was rolled back — old account is intact.
    // Clean up the newly-created auth user so the player can retry.
    const { error: cleanupErr } = await service.auth.admin.deleteUser(newUserId);
    if (cleanupErr) {
      console.error(
        "[reconnectPlayer] Failed to clean up new auth user after RPC failure — stale auth row:",
        cleanupErr.message,
        { newUserId }
      );
    }
    return { success: false, error: "Failed to migrate account. Please try again." };
  }

  if (isActiveOrganizer) {
    console.log(
      "[reconnectPlayer] Old user is the primary organizer of an active session — " +
        "sessions.created_by, profile, and auth user preserved to keep organizer " +
        "dashboard valid on their other device.",
      { oldUserId, newUserId }
    );
  }

  // ── Refresh all-time leaderboard (non-blocking) ────────────
  // migrate_player_identity reassigns match_players rows to newUserId,
  // which leaves the materialized view stale until the next match ends.
  // Refreshing here eliminates the staleness window so the leaderboard
  // is immediately correct for the reconnected player.
  // Non-fatal: a refresh failure does not affect the reconnect itself.
  void service.rpc("refresh_alltime_leaderboard").then(({ error }) => {
    if (error) {
      console.warn(
        "[reconnectPlayer] refresh_alltime_leaderboard failed (non-fatal):",
        error.message
      );
    }
  });

  // Step 6: Delete old auth user (only when not an active organizer).
  // Cannot be done inside the Postgres function — auth.admin is a
  // Supabase Auth operation, not a DB operation.
  if (!isActiveOrganizer) {
    const { error: deleteErr } = await service.auth.admin.deleteUser(oldUserId);
    if (deleteErr) {
      console.error(
        "[reconnectPlayer] Failed to delete old auth user — stale auth row may remain:",
        deleteErr.message,
        { oldUserId, newUserId }
      );
      // Non-fatal: DB migration succeeded; the player is fully functional.
      // The stale auth.users row has no profile and cannot be used to log in.
    }
  }

  // ── Post-migration reconciliation ──────────────────────────
  // Race condition: if a match ended (endMatchAction) at the exact
  // moment migrate_player_identity was moving match_players from
  // oldUserId → newUserId, endMatchAction's re-queue step operated
  // on oldUserId and found 0 rows (already migrated). The player's
  // newUserId queue entry stays stuck as "playing" or "on_deck"
  // even though the match is already completed or cancelled.
  //
  // Fix: after migration, check the player's queue entry for the
  // active session. If the entry is "playing"/"on_deck" but the
  // associated match is no longer in_progress/pending, reset the
  // entry to "waiting" so the player is re-queued correctly.
  //
  // This runs only when we know the player was in an active session
  // (targetSessionId is set). Non-fatal: any error is logged and
  // silently swallowed — the reconnect itself already succeeded.
  if (targetSessionId) {
    try {
      const { data: queueEntry } = await service
        .from("queue_entries")
        .select("id, status")
        .eq("session_id", targetSessionId)
        .eq("player_id", newUserId)
        .in("status", ["playing", "drafted", "on_deck"])
        .maybeSingle();

      if (queueEntry) {
        // Player's queue entry is stuck in a match-related status.
        // Verify whether they have an active match in THIS session.
        //
        // Query via matches (has session_id) joined to match_players so
        // the result is scoped to the current session. An unscoped
        // match_players query could return a historical in_progress row
        // from a different session and falsely conclude the match is live.
        const { data: activeMatch } = await service
          .from("matches")
          .select("id, status, match_players!inner(player_id)")
          .eq("session_id", targetSessionId)
          .in("status", ["pending", "in_progress"])
          .eq("match_players.player_id", newUserId)
          .maybeSingle();

        const matchIsStillActive = !!activeMatch;

        if (!matchIsStillActive) {
          // Match ended while migration was in flight — reset entry to "waiting".
          console.log(
            "[reconnectPlayer] Post-migration reconciliation: " +
              `queue entry stuck as "${queueEntry.status}" with no active match — ` +
              `resetting to "waiting".`,
            { newUserId, sessionId: targetSessionId }
          );
          await service
            .from("queue_entries")
            .update({ status: "waiting" as const })
            .eq("id", queueEntry.id);
        }
      }
    } catch (reconcileErr) {
      console.warn(
        "[reconnectPlayer] Post-migration reconciliation failed (non-fatal):",
        reconcileErr
      );
    }
  }

  // ── Offline Wrapped redirect ────────────────────────────────
  // If the player isn't rejoining an active session, check whether
  // their most recently closed session has Wrapped stats available.
  // We look for sessions that ended within the last 48 hours so we
  // don't redirect returning players to stale results from weeks ago.
  let wrappedUrl: string | undefined;
  if (!targetSessionId) {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: recentEntry } = await service
      .from("queue_entries")
      .select("session_id, sessions!inner(is_active, ended_at)")
      .eq("player_id", newUserId)
      .order("joined_at", { ascending: false })
      .limit(10);

    if (recentEntry) {
      for (const entry of recentEntry) {
        const sess = entry.sessions as unknown as {
          is_active: boolean;
          ended_at: string | null;
        };
        if (sess.is_active || !sess.ended_at || sess.ended_at < cutoff) continue;

        // Check that Wrapped stats actually exist for this player in this session.
        const { data: statsRow } = await service
          .from("session_wrapped_stats")
          .select("session_id")
          .eq("session_id", entry.session_id)
          .eq("player_id", newUserId)
          .single();

        if (statsRow) {
          wrappedUrl = `/wrapped/${entry.session_id}/${newUserId}`;
          break;
        }
      }
    }
  }

  // Duplicate-name gate: a flagged profile (the flag travels through
  // migrate_player_identity) must resolve their name before continuing. The
  // modal routes a requiresRename result to /rename.
  const { data: renamedProfile } = await service
    .from("profiles")
    .select("needs_rename")
    .eq("id", newUserId)
    .maybeSingle();
  const requiresRename = renamedProfile?.needs_rename ?? false;

  return {
    success: true,
    sessionId: targetSessionId ?? undefined,
    wrappedUrl,
    requiresRename,
  };
}

// ── Sign Out ─────────────────────────────────────────────────

export async function signOut() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/");
}

/**
 * playerLogOut — clears the player's auth session and redirects to the
 * login screen.  Called from the player dashboard "Sign out" escape hatch.
 *
 * Distinct from "Leave Session" (checkoutPlayer) which only removes the
 * player from the queue but keeps them authenticated.  Use this when the
 * player wants to switch accounts or hand the device to someone else.
 */
export async function playerLogOut(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/");
}

// ── Get Current Profile ──────────────────────────────────────

export async function getCurrentProfile() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();

  return profile;
}
