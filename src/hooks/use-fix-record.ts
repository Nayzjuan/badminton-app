"use client";

// ============================================================
// useFixRecord — state machine for the FixRecordSheet
// ============================================================
// Manages the 6-state flow for correcting a completed match roster:
//
//   IDLE → SELECTING_OUT → SELECTING_IN → CONFIRMING → SUBMITTING → IDLE
//
// The hook owns all mutable state so the Sheet component stays purely
// presentational. Errors surface inline inside the sheet (no toast
// on error — the user needs to re-pick).
//
// Success: sheet closes (caller controls open state via onSuccess cb).
// ============================================================

import { useState, useCallback, useTransition } from "react";
import { fixPlayerRecord } from "@/app/actions/fix-player-record";
import type { FixRecordResult } from "@/app/actions/fix-player-record";
import type { CompletedMatch } from "@/hooks/use-match-history";
import type { SkillLevel } from "@/types/database";

// ── Types ─────────────────────────────────────────────────────

export type FixRecordStep =
  | "selecting_out" // Step 1: pick the player being replaced
  | "selecting_in" // Step 2: pick the replacement
  | "confirming" // Confirmation strip visible, awaiting confirm
  | "submitting"; // Server action in-flight

export type SelectedPlayer = {
  player_id: string;
  display_name: string;
  skill_level: SkillLevel;
  team: "a" | "b";
};

export type FixRecordState = {
  step: FixRecordStep;
  outPlayer: SelectedPlayer | null;
  inPlayer: SelectedPlayer | null;
  errorMessage: string | null;
};

// ── Hook ──────────────────────────────────────────────────────

interface UseFixRecordOptions {
  match: CompletedMatch;
  sessionId: string;
  onSuccess: () => void;
}

export function useFixRecord({ match, sessionId, onSuccess }: UseFixRecordOptions) {
  const [step, setStep] = useState<FixRecordStep>("selecting_out");
  const [outPlayer, setOutPlayer] = useState<SelectedPlayer | null>(null);
  const [inPlayer, setInPlayer] = useState<SelectedPlayer | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // ── Step 1: organizer taps a player from the match card ─────────
  const selectOut = useCallback((player: SelectedPlayer) => {
    setOutPlayer(player);
    setInPlayer(null);
    setErrorMessage(null);
    setStep("selecting_in");
  }, []);

  // ── Step 2: organizer taps a replacement candidate ───────────────
  const selectIn = useCallback((player: SelectedPlayer) => {
    setInPlayer(player);
    setErrorMessage(null);
    setStep("confirming");
  }, []);

  // ── Back from step 2 → step 1 ────────────────────────────────────
  const goBack = useCallback(() => {
    setOutPlayer(null);
    setInPlayer(null);
    setErrorMessage(null);
    setStep("selecting_out");
  }, []);

  // ── Dismiss confirmation strip → back to selecting_in ───────────
  const cancelConfirm = useCallback(() => {
    setInPlayer(null);
    setErrorMessage(null);
    setStep("selecting_in");
  }, []);

  // ── Reset entire flow (on sheet close) ──────────────────────────
  const reset = useCallback(() => {
    setStep("selecting_out");
    setOutPlayer(null);
    setInPlayer(null);
    setErrorMessage(null);
  }, []);

  // ── Confirm: submit the correction ──────────────────────────────
  const confirm = useCallback(() => {
    if (!outPlayer || !inPlayer) return;

    setErrorMessage(null);
    setStep("submitting");

    startTransition(async () => {
      let result: FixRecordResult;
      try {
        result = await fixPlayerRecord(
          match.id,
          outPlayer.player_id,
          inPlayer.player_id,
          sessionId
        );
      } catch {
        result = { success: false, message: "An unexpected error occurred. Please try again." };
      }

      if (result.success) {
        reset();
        onSuccess();
      } else {
        setErrorMessage(result.message);
        // Stay in confirming so user can re-read the error and either
        // cancel or retry (the in_player is still selected).
        setStep("confirming");
      }
    });
  }, [outPlayer, inPlayer, match.id, sessionId, onSuccess, reset]);

  // ── Derived: is the in_player a team flip? ───────────────────────
  const isTeamFlip =
    inPlayer !== null && match.players.some((p) => p.player_id === inPlayer.player_id);

  return {
    step,
    outPlayer,
    inPlayer,
    errorMessage,
    isPending,
    isTeamFlip,
    selectOut,
    selectIn,
    goBack,
    cancelConfirm,
    confirm,
    reset,
  };
}
