// ============================================================
// Matchmaking slot planning — pure helpers
// ============================================================
//
// Extracted from runEngineInternal so the replay harness can use the same
// rules production uses: dynamic cap, override ceiling, mode-dependent
// draftCount, soft-gate decision, and the per-slot pool-diversity cap.
//
// Split so production's query order does not change. The in-progress match
// count is still fetched lazily — only when softGateDecision returns
// "needs-active-count".
// ============================================================

import {
  CRITICAL_WAIT_MINUTES,
  GATE_HOLD_MINUTES,
  GATE_POOL_THRESHOLD,
  MIN_FREE_POOL_FOR_ON_DECK,
  PLAYERS_PER_MATCH,
} from "@/lib/constants";
import { getDynamicDraftCap, type PairRuleFlags } from "@/lib/matchmaking-core";
import { isHeldAwaitingReadiness } from "@/lib/cross-court/derive-held-state";
import { getManilaCalendarDate } from "@/lib/month";

export type PendingCapRow = {
  is_published: boolean;
  is_held: boolean;
  held_ready_at: string | null;
};

export function countDraftsAgainstCap(autoPublish: boolean, pendingRows: PendingCapRow[]): number {
  return autoPublish
    ? pendingRows.filter((m) => m.is_published || m.is_held).length
    : pendingRows.filter((m) => !m.is_published && !isHeldAwaitingReadiness(m)).length;
}

export function planSlots(args: {
  waitingCount: number;
  override: number | null;
  autoPublish: boolean;
  pendingRows: PendingCapRow[];
}): { dynamicCap: number; effectiveCap: number; draftCount: number; slotsAvailable: number } {
  const dynamicCap = getDynamicDraftCap(args.waitingCount);
  const effectiveCap = args.override != null ? Math.min(args.override, dynamicCap) : dynamicCap;
  const draftCount = countDraftsAgainstCap(args.autoPublish, args.pendingRows);
  return {
    dynamicCap,
    effectiveCap,
    draftCount,
    slotsAvailable: Math.max(0, effectiveCap - draftCount),
  };
}

/**
 * Soft-gate first half. "release" = generate. "needs-active-count" = fetch
 * in-progress matches; defer only when that count is > 0.
 */
export function softGateDecision(args: {
  bypassGate: boolean;
  waitingCount: number;
  maxWait: number;
}): "release" | "needs-active-count" {
  if (args.bypassGate) return "release";
  if (args.waitingCount <= 0 || args.waitingCount > GATE_POOL_THRESHOLD) return "release";
  if (args.maxWait >= CRITICAL_WAIT_MINUTES || args.maxWait >= GATE_HOLD_MINUTES) {
    return "release";
  }
  return "needs-active-count";
}

/** Pool-diversity cap from slot 2 onwards. Slot 0 is always allowed. */
export function shouldContinueSlot(args: {
  slotIndex: number;
  estimatedWaiting: number;
  bypassGate: boolean;
}): boolean {
  if (args.bypassGate || args.slotIndex === 0) return true;
  return args.estimatedWaiting >= PLAYERS_PER_MATCH + MIN_FREE_POOL_FOR_ON_DECK;
}

function isEnvFlagEnabled(env: string | undefined): boolean {
  if (env == null || env.trim() === "") return true;
  const v = env.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

export function isFreshnessRefreshEnabled(
  env: string | undefined = process.env.MATCHMAKING_FRESHNESS_REFRESH
): boolean {
  return isEnvFlagEnabled(env);
}

export function isNoImmediateRematchEnabled(
  env: string | undefined = process.env.MATCHMAKING_NO_IMMEDIATE_REMATCH
): boolean {
  return isEnvFlagEnabled(env);
}

export function isSharedGamesPreferenceEnabled(
  env: string | undefined = process.env.MATCHMAKING_SHARED_GAMES_PREFERENCE
): boolean {
  return isEnvFlagEnabled(env);
}

export function readPairRuleFlags(): PairRuleFlags {
  return {
    noImmediateRematch: isNoImmediateRematchEnabled(),
    sharedGamesPreference: isSharedGamesPreferenceEnabled(),
  };
}

/**
 * Inclusive last Manila calendar day the rematch-yield kill switch may fire.
 * From the next midnight Asia/Manila the env is ignored and the yield stays off.
 * First Saturday after this ship (activated 2026-11-15 Manila) is 2026-11-21.
 */
export const REMATCH_FALLBACK_SUNSET_MANILA = "2026-11-21";

/** Unset / empty / off / false / 0 → off. Unlike R1/R2, default is hard rematch. */
function isExplicitlyEnabled(env: string | undefined): boolean {
  if (env == null || env.trim() === "") return false;
  const v = env.trim().toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

/**
 * Restore the old rematch yield (`composeEngineProposal` rematchFallback:true).
 * Default off. `MATCHMAKING_REMATCH_FALLBACK=on` works only through
 * `REMATCH_FALLBACK_SUNSET_MANILA` inclusive; after that always false.
 * `now` is injectable so the Saturday cutoff is testable.
 */
export function isRematchFallbackEnabled(
  env: string | undefined = process.env.MATCHMAKING_REMATCH_FALLBACK,
  now: Date = new Date()
): boolean {
  if (getManilaCalendarDate(now) > REMATCH_FALLBACK_SUNSET_MANILA) return false;
  return isExplicitlyEnabled(env);
}

/** Gate for the production / replay rematch-yield retry. */
export function shouldRetryRematchFallback(args: {
  hasProposal: boolean;
  rematchBlocked?: boolean;
  noImmediateRematch: boolean;
  rematchFallbackEnabled: boolean;
}): boolean {
  return (
    !args.hasProposal &&
    args.rematchBlocked === true &&
    args.noImmediateRematch &&
    args.rematchFallbackEnabled
  );
}
