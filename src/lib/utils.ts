import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Profile } from "@/types/database";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Returns a minimal stub Profile for a player whose record could not
 * be found (e.g. race condition between profile creation and enrichment).
 *
 * Centralised here so adding a new required column to Profile only
 * needs one update, not three scattered inline objects.
 */
export function createUnknownProfile(id: string): Profile {
  return {
    id,
    display_name: "Unknown",
    skill_level: "beginner" as const,
    pin: null,
    vip_tag: null,
    vip_theme: null,
    needs_rename: false,
    collided_name: null,
    flagged_at: null,
    created_at: "",
    updated_at: "",
  };
}
