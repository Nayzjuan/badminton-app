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

// ── Registration ────────────────────────────────────────────

export async function signInAnonymously(formData: FormData) {
  const displayName = (formData.get("display_name") as string)?.trim();
  const skillLevel = formData.get("skill_level") as SkillLevel;
  const pin = (formData.get("pin") as string)?.trim();

  if (!displayName || !skillLevel) {
    return { error: "Name and skill level are required." };
  }

  if (!pin || !/^\d{4}$/.test(pin)) {
    return { error: "A 4-digit PIN is required." };
  }

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

    redirect("/play");
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
  if (data.user) {
    supabase.from("profiles").upsert(
      {
        id: data.user.id,
        display_name: displayName,
        skill_level: skillLevel,
        pin,
      },
      { onConflict: "id" }
    ).then(({ error: upsertError }) => {
      if (upsertError) {
        console.error("[auth] profile upsert safety-net failed:", upsertError);
      }
    });
  }

  redirect("/play");
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
  if (!playerName?.trim() || !pin?.trim()) {
    return { success: false, error: "Name and PIN are required." };
  }

  const name = playerName.trim();
  const service = createServiceClient();

  // Find the profile by name + PIN (case-insensitive name match).
  const { data: profiles } = await service
    .from("profiles")
    .select("*")
    .ilike("display_name", name)
    .eq("pin", pin);

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

  // If no active session found, check for any session they were part of.
  if (!targetSessionId) {
    const { data: anyEntry } = await service
      .from("queue_entries")
      .select("session_id, sessions!inner(is_active)")
      .eq("player_id", targetProfile.id)
      .order("joined_at", { ascending: false })
      .limit(1)
      .single();

    if (anyEntry) {
      targetSessionId = anyEntry.session_id;
    }
  }

  if (!targetSessionId) {
    return { success: false, error: "No active session found for this player." };
  }

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
  // The trigger will have created a new profiles row for newUserId.
  // We need to:
  // 1. Update queue_entries to point to new user
  // 2. Update match_players to point to new user
  // 3. Delete the auto-created new profile row
  // 4. Update the old profile's ID to the new auth user ID

  // Step 1: Update queue_entries
  await service
    .from("queue_entries")
    .update({ player_id: newUserId })
    .eq("player_id", oldUserId);

  // Step 2: Update match_players
  await service
    .from("match_players")
    .update({ player_id: newUserId })
    .eq("player_id", oldUserId);

  // Step 3: Delete the auto-created profile for new user (if trigger created one)
  await service
    .from("profiles")
    .delete()
    .eq("id", newUserId);

  // Step 4: We can't update the primary key directly in Supabase.
  // Instead, create a new profile row with the new ID and old data,
  // then delete the old one.
  await service.from("profiles").insert({
    id: newUserId,
    display_name: targetProfile.display_name,
    skill_level: targetProfile.skill_level,
    pin: targetProfile.pin,
  });

  // Delete old profile
  await service
    .from("profiles")
    .delete()
    .eq("id", oldUserId);

  // Delete old auth user to clean up
  await service.auth.admin.deleteUser(oldUserId);

  return { success: true, sessionId: targetSessionId };
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
