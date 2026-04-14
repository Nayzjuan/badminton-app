"use server";

// ============================================================
// Auth Server Actions
// ============================================================
// Handles anonymous sign-in and profile creation/update.
// Players enter a name + skill level — no email/password needed.
// ============================================================

import { createClient } from "@/utils/supabase/server";
import { redirect } from "next/navigation";
import type { SkillLevel } from "@/types/database";

export async function signInAnonymously(formData: FormData) {
  const displayName = (formData.get("display_name") as string)?.trim();
  const skillLevel = formData.get("skill_level") as SkillLevel;

  if (!displayName || !skillLevel) {
    return { error: "Name and skill level are required." };
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
      .update({ display_name: displayName, skill_level: skillLevel })
      .eq("id", existingUser.id);

    if (updateError) {
      return { error: updateError.message };
    }

    redirect("/play");
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
  // didn't propagate, fire an upsert as a safety net. We don't await
  // it — the redirect can proceed immediately while the upsert
  // completes in the background.
  if (data.user) {
    supabase.from("profiles").upsert(
      {
        id: data.user.id,
        display_name: displayName,
        skill_level: skillLevel,
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

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

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
