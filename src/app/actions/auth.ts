"use server";

// ============================================================
// Auth Server Actions
// ============================================================
// Handles anonymous sign-in with PIN, duplicate name check,
// and reconnect flow for returning players.
// ============================================================

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { redirect } from "next/navigation";
import type { SkillLevel } from "@/types/database";
import { displayNameSchema, pinSchema } from "@/lib/schemas/auth";

// ── Registration ────────────────────────────────────────────

export async function signInAnonymously(formData: FormData) {
  const rawName = formData.get("display_name") as string | null;
  const skillLevel = formData.get("skill_level") as SkillLevel;
  const rawPin = formData.get("pin") as string | null;
  // Optional: if joining via QR/link, redirect straight to that session.
  const sessionId = (formData.get("session_id") as string)?.trim() || null;
  const destination = sessionId ? `/play/${sessionId}` : "/play";

  // ── Zod validation ───────────────────────────────────────
  const nameResult = displayNameSchema.safeParse(rawName ?? "");
  if (!nameResult.success) {
    return { error: nameResult.error.issues[0].message };
  }
  const displayName = nameResult.data; // trimmed + spaces collapsed

  if (!skillLevel) {
    return { error: "Please select your skill level." };
  }

  const pinResult = pinSchema.safeParse(rawPin ?? "");
  if (!pinResult.success) {
    return { error: pinResult.error.issues[0].message };
  }
  const pin = pinResult.data;

  const supabase = await createClient();

  // Check if already signed in.
  const {
    data: { user: existingUser },
  } = await supabase.auth.getUser();

  if (existingUser) {
    // Already authenticated — just update the profile.
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ display_name: displayName, skill_level: skillLevel, pin })
      .eq("id", existingUser.id);

    if (updateError) {
      return { error: updateError.message };
    }

    redirect(destination);
  }

  // ── Duplicate name check ──────────────────────────────────
  // Check if this name is already in use by a player who is
  // actively in any session (waiting, on_deck, or playing).
  const service = createServiceClient();

  const { data: activeEntries } = await service
    .from("queue_entries")
    .select("player_id, profiles!inner(display_name)")
    .in("status", ["waiting", "on_deck", "playing"])
    .ilike("profiles.display_name", displayName);

  if (activeEntries && activeEntries.length > 0) {
    return { error: "Name taken. Add an initial (e.g. \"Miggy L.\")." };
  }

  // ── Returning player check ────────────────────────────────────
  // If a profile already exists with this exact name + PIN, the player
  // is returning and should use Reconnect instead of registering fresh.
  // Without this check, they'd silently create a duplicate (ghost) profile
  // every time they open the app between sessions.
  const { data: existingProfile } = await service
    .from("profiles")
    .select("id")
    .ilike("display_name", displayName)
    .eq("pin", pin)
    .limit(1)
    .single();

  if (existingProfile) {
    return {
      error: "Looks like you've played before! Use \"Reconnect\" below to pick up where you left off.",
    };
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
    return { error: error.message };
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
        return { error: "That name is already taken! Try adding a number or your initial." };
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
  /**
   * If the player's most recent session has already closed and Wrapped stats
   * exist, this is set to the /wrapped URL so the caller can redirect them
   * directly to their results instead of dropping them on the lobby.
   */
  wrappedUrl?: string;
}

export async function reconnectPlayer(
  playerName: string,
  pin: string
): Promise<ReconnectResult> {
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
    .ilike("display_name", name)
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
      .in("status", ["waiting", "on_deck", "playing"])
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
  const supabase = await createClient();
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

  // ── Migrate all references from old ID to new ID ──────────
  // P1-1 REORDERED STEPS (safest sequence to minimise data-loss window):
  //
  //  Old order (dangerous):          New order (safer):
  //  1. Update queue_entries          1. Delete auto-created new profile
  //  2. Update match_players          2. Insert new profile with newUserId
  //  3. Delete new profile            3. Update queue_entries old→new
  //  4. Insert new profile ← crash!  4. Update match_players old→new
  //  5. Delete old profile            5. Delete old profile
  //  6. Delete old auth user          6. Delete old auth user
  //
  // With the old order: if step 4 (insert) failed after step 3 (delete),
  // neither profile existed and the player was locked out permanently.
  //
  // With the new order: the new profile is created BEFORE any FK references
  // are migrated. If a later step fails:
  //   - Steps 3-4 fail → profile is correct; queue/match still point to old
  //     ID, but old auth user + profile still exist → player can retry reconnect.
  //   - Step 5 fails → both profiles temporarily exist; no data lost.
  //
  // NOTE: A true atomic migration requires a Postgres stored procedure
  // (RPC) wrapped in a transaction. This is the safest app-layer ordering
  // but does NOT eliminate the window entirely.

  // Step 1: Delete the auto-created profile for newUserId (trigger created it).
  const { error: deleteNewProfileErr } = await service
    .from("profiles")
    .delete()
    .eq("id", newUserId);

  if (deleteNewProfileErr) {
    console.error("[reconnectPlayer] Failed to delete auto-created new profile:", deleteNewProfileErr.message);
    // Non-fatal — the profile may not have been created by the trigger yet.
  }

  // Step 2: Insert new profile with the new auth ID but OLD player data.
  // This must succeed before we migrate any FK references.
  const { error: insertProfileErr } = await service.from("profiles").insert({
    id: newUserId,
    display_name: targetProfile.display_name,
    skill_level: targetProfile.skill_level,
    pin: targetProfile.pin,
  });

  if (insertProfileErr) {
    // Profile creation failed — abort and clean up the new auth user so the
    // player can retry. Old account remains intact.
    console.error("[reconnectPlayer] Profile insert failed, aborting migration:", insertProfileErr.message);
    await service.auth.admin.deleteUser(newUserId);
    return { success: false, error: "Failed to migrate profile. Please try again." };
  }

  // Step 3: Update queue_entries to point to new user.
  const { error: queueMigrateErr } = await service
    .from("queue_entries")
    .update({ player_id: newUserId })
    .eq("player_id", oldUserId);

  if (queueMigrateErr) {
    console.error("[reconnectPlayer] queue_entries migration failed:", queueMigrateErr.message);
    // Rollback: delete the new profile and auth user so the old account is untouched.
    await service.from("profiles").delete().eq("id", newUserId);
    await service.auth.admin.deleteUser(newUserId);
    return { success: false, error: "Failed to migrate queue data. Please try again." };
  }

  // Step 4: Update match_players to point to new user.
  const { error: matchMigrateErr } = await service
    .from("match_players")
    .update({ player_id: newUserId })
    .eq("player_id", oldUserId);

  if (matchMigrateErr) {
    console.error("[reconnectPlayer] match_players migration failed:", matchMigrateErr.message);
    // Partial rollback: queue_entries already migrated to newUserId.
    // Attempt to revert queue_entries back to oldUserId.
    await service.from("queue_entries").update({ player_id: oldUserId }).eq("player_id", newUserId);
    await service.from("profiles").delete().eq("id", newUserId);
    await service.auth.admin.deleteUser(newUserId);
    return { success: false, error: "Failed to migrate match history. Please try again." };
  }

  // ── Active-organizer guard ────────────────────────────────────────────────
  // If the old user is currently the PRIMARY organizer of an active session,
  // they may be running the organizer dashboard on another device (e.g. iPad).
  // Migrating sessions.created_by and then deleting the old auth user would
  // invalidate that device's cookie on the next request — effectively logging
  // them out of the organizer dashboard mid-session.
  //
  // Fix: when oldUserId owns an active session, skip Steps 4.5, 5, and 6.
  // The new user (phone) gets all player data (queue_entries, match_players,
  // wrapped_stats migrated in Steps 3, 4, 4.6). The old user remains alive
  // purely as the organizer identity — their sessions.created_by is preserved.
  //
  // Trade-off: the old profile becomes a shell with no queue_entries, but the
  // organizer dashboard only needs the auth session to be valid, not the queue.
  //
  // Note: co-organizers (session_organizers table) are not yet guarded here —
  // that is a future enhancement. Only the primary organizer (created_by) is
  // protected in this pass.
  // ─────────────────────────────────────────────────────────────────────────
  const { data: activeOrgSessions } = await service
    .from("sessions")
    .select("id")
    .eq("created_by", oldUserId)
    .eq("is_active", true)
    .limit(1);

  const isActiveOrganizer = !!(activeOrgSessions && activeOrgSessions.length > 0);

  if (isActiveOrganizer) {
    console.log(
      "[reconnectPlayer] Old user is the primary organizer of an active session — " +
      "skipping sessions.created_by migration, profile delete, and auth user delete " +
      "to preserve the organizer's live session on their other device.",
      { oldUserId, newUserId }
    );
  }

  // Step 4.5: Reassign sessions.created_by so the old profile can be deleted.
  // sessions.created_by has a FK → profiles.id. If the player ever created a
  // session under the old ID, deleting the old profile would fail with a FK
  // violation. This step clears that blocker before Step 5.
  // SKIPPED when isActiveOrganizer — we deliberately keep sessions.created_by
  // on the old ID so the organizer's existing session remains valid.
  if (!isActiveOrganizer) {
    const { error: sessionsMigrateErr } = await service
      .from("sessions")
      .update({ created_by: newUserId })
      .eq("created_by", oldUserId);

    if (sessionsMigrateErr) {
      console.error(
        "[reconnectPlayer] sessions.created_by migration failed — Step 5 delete may fail:",
        sessionsMigrateErr.message,
        { oldUserId, newUserId }
      );
    }
  }

  // Step 4.6: Migrate session_wrapped_stats to new user ID.
  // player_id is part of the composite PK — UpdateType excludes it, so we
  // cannot update it in-place. Instead: read rows, re-insert under newUserId
  // (dropping the generated columns id and point_diff), then delete the
  // originals. Must happen BEFORE step 5 (delete old profile) to satisfy any
  // FK constraint. Non-fatal throughout.
  {
    const { data: oldStats, error: readStatsErr } = await service
      .from("session_wrapped_stats")
      .select("*")
      .eq("player_id", oldUserId);

    if (readStatsErr) {
      console.warn(
        "[reconnectPlayer] session_wrapped_stats read failed (non-fatal):",
        readStatsErr.message
      );
    } else if (oldStats && oldStats.length > 0) {
      // Exclude auto-generated columns (id, point_diff) and override player_id.
      // point_diff is GENERATED ALWAYS and computed_at has a DB default — both
      // are excluded from SessionWrappedStatsInsert, so the spread is safe.
      const newStats = oldStats.map(({ id: _id, point_diff: _pd, ...row }) => ({
        ...row,
        player_id: newUserId,
      }));

      const { error: insertStatsErr } = await service
        .from("session_wrapped_stats")
        .insert(newStats);

      if (insertStatsErr) {
        console.warn(
          "[reconnectPlayer] session_wrapped_stats re-insert failed (non-fatal):",
          insertStatsErr.message
        );
      } else {
        // Delete originals only after successful insert to avoid data loss.
        await service
          .from("session_wrapped_stats")
          .delete()
          .eq("player_id", oldUserId);
      }
    }
  }

  // Step 4.7: Migrate session_organizers rows from old to new user.
  // session_organizers has user_id FK → profiles.id ON DELETE CASCADE.
  // Without this migration, deleting the old profile in Step 5 would
  // cascade-delete the player's co-organizer rows, silently revoking
  // their organizer access on any session they co-managed.
  //
  // The generated Update type is Record<string, never> (user_id is part
  // of the logical key, so Supabase doesn't expose it as updatable).
  // We use delete + re-insert instead.
  //
  // UNCONDITIONAL and non-fatal:
  //   • Primary organizers:  no session_organizers rows (their access comes
  //     from sessions.created_by), so the select returns empty — no-op.
  //   • Co-organizers: re-inserts their rows under newUserId so the
  //     CASCADE delete in Step 5 never touches them.
  {
    const { data: oldCoOrgRows, error: readCoOrgErr } = await service
      .from("session_organizers")
      .select("session_id, granted_at")
      .eq("user_id", oldUserId);

    if (readCoOrgErr) {
      console.warn(
        "[reconnectPlayer] session_organizers read failed (non-fatal):",
        readCoOrgErr.message,
        { oldUserId }
      );
    } else if (oldCoOrgRows && oldCoOrgRows.length > 0) {
      // Re-insert under new user ID.
      const newCoOrgRows = oldCoOrgRows.map((row) => ({
        session_id: row.session_id,
        user_id: newUserId,
      }));

      const { error: insertCoOrgErr } = await service
        .from("session_organizers")
        .insert(newCoOrgRows);

      if (insertCoOrgErr) {
        console.warn(
          "[reconnectPlayer] session_organizers re-insert failed (non-fatal):",
          insertCoOrgErr.message,
          { oldUserId, newUserId }
        );
      } else {
        // Delete old rows only after successful re-insert.
        await service
          .from("session_organizers")
          .delete()
          .eq("user_id", oldUserId);
      }
    }
  }

  // Step 5: Delete old profile (all FK references now point to newUserId).
  // sessions.created_by was migrated in Step 4.5 (unless isActiveOrganizer).
  // session_organizers.user_id was migrated in Step 4.7 (always).
  // Log if it does so ghosts are visible in server logs.
  //
  // SKIPPED when isActiveOrganizer — the old profile stays alive as the
  // organizer's identity. It becomes a shell (no queue_entries/match_players),
  // but that is acceptable: the organizer dashboard never reads those tables
  // through the profile to render its UI.
  if (!isActiveOrganizer) {
    const { error: deleteOldProfileErr } = await service
      .from("profiles")
      .delete()
      .eq("id", oldUserId);

    if (deleteOldProfileErr) {
      console.error(
        "[reconnectPlayer] Failed to delete old profile — ghost may remain:",
        deleteOldProfileErr.message,
        { oldUserId, newUserId }
      );
    }
  }

  // Step 6: Delete old auth user to clean up orphaned auth record.
  // SKIPPED when isActiveOrganizer — keeping the auth user alive is the
  // entire point of the guard. The organizer's device cookie must remain valid.
  if (!isActiveOrganizer) {
    await service.auth.admin.deleteUser(oldUserId);
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

  return { success: true, sessionId: targetSessionId ?? undefined, wrappedUrl };
}

// ── Sign Out ─────────────────────────────────────────────────

export async function signOut() {
  const supabase = await createClient();
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
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

// ── Get Current Profile ──────────────────────────────────────

export async function getCurrentProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return profile;
}
