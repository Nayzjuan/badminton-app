// ============================================================
// Auth Validation Schemas — Zod
// ============================================================
// display_name rules (mirrors CLAUDE.md naming conventions):
//   • Trim leading/trailing whitespace
//   • 3–30 characters
//   • Letters, numbers, and spaces only
//   • Collapse multiple internal spaces into one
//
// The superRefine extracts the exact offending characters so
// the error message tells the user precisely what to remove.
// ============================================================

import { z } from "zod";
import { SKILL_LEVELS, type SkillLevel } from "@/types/database";

// ── Display Name ─────────────────────────────────────────────

export const displayNameSchema = z
  .string()
  .trim()
  .min(3, { message: "Name must be at least 3 characters." })
  .max(30, { message: "Name must be 30 characters or less." })
  .superRefine((val, ctx) => {
    const badChars = val.match(/[^a-zA-Z0-9 ]/g);
    if (badChars) {
      const uniqueBad = [...new Set(badChars)].join(" ");
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Keep it simple: letters, numbers, and spaces only. Please remove: ${uniqueBad}`,
      });
    }
  })
  // Collapse multiple internal spaces → single space (runs after validation)
  .transform((val) => val.replace(/\s+/g, " "));

// ── PIN ──────────────────────────────────────────────────────

export const pinSchema = z
  .string()
  .trim()
  .regex(/^\d{4}$/, { message: "PIN must be exactly 4 digits (e.g. 1234)." });

// ── Skill Level ──────────────────────────────────────────────
// Validates that a raw string is one of the known SkillLevel enum values.
// Using SKILL_LEVELS (the canonical runtime array from database.ts) as the
// source of truth so this schema is automatically kept in sync if new levels
// are ever added — no duplicate hard-coded list to maintain here.

export const skillLevelSchema = z
  .string({ error: "Please select your skill level." })
  .refine(
    (val): val is SkillLevel => SKILL_LEVELS.some((s) => s.value === val),
    { message: "Please select a valid skill level." }
  );

// ── Full registration input ───────────────────────────────────

export const registrationSchema = z.object({
  display_name: displayNameSchema,
  pin: pinSchema,
});

export type RegistrationInput = z.infer<typeof registrationSchema>;
