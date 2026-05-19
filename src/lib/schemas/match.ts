// ============================================================
// Match Validation Schemas — Zod
// ============================================================
// Centralises runtime validation for match-related server action
// inputs. Keeping schemas in lib/schemas/ (alongside auth.ts and
// sessions.ts) means they can be imported by multiple action
// files without duplicating the Zod dependency or the bounds logic.
// ============================================================

import { z } from "zod";

// ── Score Schema ──────────────────────────────────────────────
// Enforces server-side bounds so a crafted POST that bypasses
// client-side guards (useScoreForm, EditMatchDialog) cannot
// persist invalid values (negatives, NaN, Infinity, 999999…)
// into matches.team_a_score / team_b_score or corrupt the
// refresh_alltime_leaderboard materialized view calculations.
//
// Max 30: standard badminton game cap. The client's useScoreForm
// uses the same logical bound via MAX_BADMINTON_SCORE; this is
// the authoritative server gate that cannot be bypassed.
export const scoreSchema = z.object({
  teamAScore: z
    .number({ error: "Score must be a number." })
    .int({ error: "Score must be a whole number." })
    .min(0, { error: "Score cannot be negative." })
    .max(30, { error: "Score cannot exceed 30." }),
  teamBScore: z
    .number({ error: "Score must be a number." })
    .int({ error: "Score must be a whole number." })
    .min(0, { error: "Score cannot be negative." })
    .max(30, { error: "Score cannot exceed 30." }),
});
