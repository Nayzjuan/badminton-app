import type { MatchEvent, MatchMovement } from "@/types/database";
import { isRosterSwapMovement } from "@/lib/match-provenance";

export const MATCH_EVENT_PHASE_LABEL: Record<string, string> = {
  draft: "draft",
  active: "mid-game",
  post_completion: "after game",
};

/**
 * One-line organizer History copy. Durations stay in the payload
 * (`seconds_since_start`) and are never rendered here.
 */
export function describeMatchEvent(ev: MatchEvent): string {
  const moves = (ev.movements ?? []) as MatchMovement[];
  switch (ev.event_type) {
    case "created": {
      const method = (ev.payload?.method as string) ?? "auto";
      const label =
        method === "held" ? "Held draft" : method === "manual" ? "Manual match" : "Auto draft";
      return `Created · ${label}`;
    }
    case "published":
      return "Published to players";
    case "roster_swap": {
      const m = moves[0];
      if (m && isRosterSwapMovement(m))
        return `${m.out_player_name} → ${m.in_player_name} (team ${m.team.toUpperCase()})`;
      return "Roster changed";
    }
    case "team_flip": {
      const names = moves
        .map((m) => (isRosterSwapMovement(m) ? null : m.player_name))
        .filter(Boolean);
      return names.length === 2 ? `${names[0]} ↔ ${names[1]} swapped sides` : "Teams swapped";
    }
    case "ondeck_pull": {
      const m = moves[0];
      const leg = (ev.payload?.leg as string) ?? "";
      if (m && isRosterSwapMovement(m))
        return `Pulled ${m.in_player_name} in for ${m.out_player_name}${leg === "ondeck" ? " (backfill)" : ""}`;
      return "Cross-court pull";
    }
    case "undo": {
      const m = moves[0];
      if (m && isRosterSwapMovement(m)) return `Undid: ${m.out_player_name} → ${m.in_player_name}`;
      return "Undid a change";
    }
    case "player_left": {
      const m = moves[0];
      return m && isRosterSwapMovement(m) ? `${m.out_player_name} left` : "Player left";
    }
    case "cancelled":
      return "Match cancelled";
    case "score_edit": {
      const o = ev.payload?.old as { a: number; b: number } | undefined;
      const n = ev.payload?.new as { a: number; b: number } | undefined;
      return o && n ? `Score corrected ${o.a}–${o.b} → ${n.a}–${n.b}` : "Score edited";
    }
    case "revert":
      return "Reverted to active";
    case "scored": {
      const a = ev.payload?.a;
      const b = ev.payload?.b;
      if (typeof a === "number" && typeof b === "number") return `Scored ${a}–${b}`;
      return "Scored";
    }
    case "started": {
      const court = (ev.payload?.court_name as string | undefined) ?? "court";
      const trigger = ev.payload?.trigger as string | undefined;
      const triggerName = ev.payload?.trigger_actor_name as string | null | undefined;
      if (trigger === "after_score") {
        return triggerName
          ? `Started on ${court} · auto, after ${triggerName} scored the previous match`
          : `Started on ${court} · auto, after a score`;
      }
      if (trigger === "after_cancel") {
        return triggerName
          ? `Started on ${court} · auto, after ${triggerName} cancelled the previous match`
          : `Started on ${court} · auto, after a cancel`;
      }
      return `Started on ${court}`;
    }
    default:
      return ev.event_type;
  }
}

/** Actor suffix after the em-dash in History (`· Nicole (player)`). */
export function describeMatchEventActor(ev: MatchEvent): string {
  if (ev.event_type === "started" && ev.actor_type === "system") return "";
  if (ev.actor_name) {
    return ev.actor_type === "player" ? ` · ${ev.actor_name} (player)` : ` · ${ev.actor_name}`;
  }
  if (ev.actor_type === "engine") return " · engine";
  return "";
}
