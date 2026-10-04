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
import { getDynamicDraftCap } from "@/lib/matchmaking-core";
import { isHeldAwaitingReadiness } from "@/lib/cross-court/derive-held-state";

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

export function isFreshnessRefreshEnabled(
  env: string | undefined = process.env.MATCHMAKING_FRESHNESS_REFRESH
): boolean {
  if (env == null || env.trim() === "") return true;
  const v = env.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}
