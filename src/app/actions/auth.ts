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
  sessionId?: string;
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

  // If multiple profiles match (unlikely), pick the one that's active in a session.
  let targetProfile = profiles[0];
  let targetSessionId: string | null = null;

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

  // Also check if the profile is in a session even if not in queue
  // (could be in an active match).
  if (!targetSessionId) {
    const { data: activeMatch } = await service
      .from("match_players")
      .select("matches!inner(session_id, status)")
      .eq("player_id", targetProfile.id)
      .limit(1)
      .single();

    if (activeMatch && activeMatch.matches) {
      const match = activeMatch.matches as unknown as { session_id: string; status: string };
      if (match.status === "pending" || match.status === "in_progress") {
        targetSessionId = match.session_id;
      }
    }
  }

  // If no active session found, check for any ACTIVE session they were part of.
  if (!targetSessionId) {
    const { data: anyEntry } = await service
      .from("queue_entries")
      .select("session_id, sessions!inner(is_active)")
      .eq("player_id", targetProfile.id)
      .order("joined_at", { ascending: false })
      .limit(1)
      .single();

    if (anyEntry) {
      // Only use the session if it is still active.
      const sessionMeta = anyEntry.sessions as unknown as { is_active: boolean };
      if (sessionMeta?.is_active) {
        targetSessionId = anyEntry.session_id;
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

  // Step 5: Delete old profile (all FK references now point to newUserId).
  await service
    .from("profiles")
    .delete()
    .eq("id", oldUserId);

  // Step 6: Delete old auth user to clean up orphaned auth record.
  await service.auth.admin.deleteUser(oldUserId);

  return { success: true, sessionId: targetSessionId ?? undefined };
}

// ── Sign Out ─────────────────────────────────────────────────

export async function signOut() {
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
