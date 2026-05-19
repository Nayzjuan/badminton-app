// ============================================================
// Session Validation Schemas — Zod
// ============================================================
// Centralises runtime validation for session creation inputs.
// All schemas derive from the canonical types in database.ts so
// adding a new ScoringFormat variant automatically tightens the
// validation without a separate schema update.
// ============================================================

import { z } from "zod";
import type { ScoringFormat } from "@/types/database";

// ── Scoring Format ────────────────────────────────────────────
// Validates that a raw value is one of the known ScoringFormat
// enum members. Using a const-array + .includes() so the schema
// stays in sync with database.ts without a separate enum list.
//
// Why not z.enum([...])? z.enum() requires a non-empty literal
// tuple which can't be derived from an imported type alias at
// runtime without duplication. The refine approach uses the real
// union members as the source of truth.

const VALID_SCORING_FORMATS = [
  "single",
  "best_of_3",
  "best_of_5",
] as const satisfies ScoringFormat[];

export const scoringFormatSchema = z
  .string({ error: "Please select a scoring format." })
  .refine(
    (val): val is ScoringFormat => (VALID_SCORING_FORMATS as readonly string[]).includes(val),
    { message: "Invalid scoring format. Must be one of: single, best_of_3, best_of_5." }
  );
