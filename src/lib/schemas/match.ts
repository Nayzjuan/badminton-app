// ============================================================
// Match Validation Schemas — Zod
// ============================================================
// Centralises runtime validation for match-related server action
// inputs. Keeping schemas in lib/schemas/ (alongside auth.ts and
// sessions.ts) means they can be imported by multiple action
// files without duplicating the Zod dependency or the bounds logic.
// ============================================================

import { z } from "zod";
import { MAX_BADMINTON_SCORE } from "@/lib/constants";

// ── Score Schema ──────────────────────────────────────────────
// Enforces server-side bounds so a crafted POST that bypasses
// client-side guards (useScoreForm, EditMatchDialog) cannot
// persist invalid values (negatives, NaN, Infinity, 999999…)
// into matches.team_a_score / team_b_score or corrupt the
// refresh_alltime_leaderboard materialized view calculations.
//
// Max bound comes from MAX_BADMINTON_SCORE in @/lib/constants —
// the single source of truth shared with client-side validation.
export const scoreSchema = z
  .object({
    teamAScore: z
      .number({ error: "Score must be a number." })
      .int({ error: "Score must be a whole number." })
      .min(0, { error: "Score cannot be negative." })
      .max(MAX_BADMINTON_SCORE, { error: `Score cannot exceed ${MAX_BADMINTON_SCORE}.` }),
    teamBScore: z
      .number({ error: "Score must be a number." })
      .int({ error: "Score must be a whole number." })
      .min(0, { error: "Score cannot be negative." })
      .max(MAX_BADMINTON_SCORE, { error: `Score cannot exceed ${MAX_BADMINTON_SCORE}.` }),
  })
  .refine((data) => data.teamAScore !== data.teamBScore, {
    message: "Scores cannot be equal — there must be a winning team.",
  });
