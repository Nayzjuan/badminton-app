"use server";

// ============================================================
// completeRegistrationJoinAction — canonical authenticated join
// ============================================================
// QR / club join for an already-authenticated player. ClubJoinScreen
// renders JoinFinalizer instead of mutating during the RSC render;
// this action is the only writer. Order is load-bearing:
//   authenticate → validate → resolve club/session → bind ownership →
//   fail-closed profile → rename gate → membership → queue.
// Destinations are derived from the resolved records, never from the
// raw client strings after the lookup.

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { isValidSlug, isValidUUID } from "@/lib/validate";
import { getClubBySlug, ensureClubMembership } from "@/lib/clubs";
import type { ClubMembershipAction } from "@/lib/clubs";
import { lookupActiveJoinSession } from "@/lib/resolve-session-join";
import { joinQueueAction } from "@/app/actions/queue";
import type { JoinQueueActionKind } from "@/app/actions/queue";
import { clubPlay, clubBase, clubJoin, sessionShare } from "@/lib/club-paths";

export type CompleteJoinCode =
  | "unauthenticated"
  | "invalid_input"
  | "club_not_found"
  | "club_inactive"
  | "session_invalid"
  | "session_closed"
  | "session_club_mismatch"
  | "profile_unavailable"
  | "membership_failed"
  | "queue_failed";

export type CompleteJoinResult =
  | {
      success: true;
      destination: string;
      membershipAction: ClubMembershipAction;
      queueAction?: JoinQueueActionKind;
      joined: boolean;
    }
  | { success: false; requiresRename: true; next: string }
  | { success: false; requiresRename?: false; error: string; code: CompleteJoinCode };

export async function completeRegistrationJoinAction(input: {
  clubSlug: string;
  sessionId?: string | null;
}): Promise<CompleteJoinResult> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: "Not signed in.", code: "unauthenticated" };
  }

  const clubSlug = typeof input.clubSlug === "string" ? input.clubSlug.trim() : "";
  const rawSession = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  if (!isValidSlug(clubSlug) || (rawSession !== "" && !isValidUUID(rawSession))) {
    return { success: false, error: "Invalid join link.", code: "invalid_input" };
  }
  const sessionId = rawSession === "" ? undefined : rawSession;

  const club = await getClubBySlug(clubSlug);
  if (!club) {
    return { success: false, error: "Club not found.", code: "club_not_found" };
  }
  if (!club.is_active) {
    return { success: false, error: "This club is no longer active.", code: "club_inactive" };
  }

  let resolvedSessionId: string | undefined;
  if (sessionId) {
    const lookup = await lookupActiveJoinSession(sessionId);
    if (!lookup.ok) {
      return {
        success: false,
        error: "This session has ended or the link is invalid.",
        code: "session_invalid",
      };
    }
    if (lookup.clubSlug !== club.slug) {
      return {
        success: false,
        error: "This session belongs to a different club.",
        code: "session_club_mismatch",
      };
    }
    resolvedSessionId = lookup.sessionId;
  }

  const renameNext = resolvedSessionId ? sessionShare(resolvedSessionId) : clubJoin(club.slug);
  const destination = resolvedSessionId
    ? clubPlay(club.slug, resolvedSessionId)
    : clubBase(club.slug);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, needs_rename, needs_name_confirm")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError || !profile) {
    return {
      success: false,
      error: "Unable to load your profile. Please try again.",
      code: "profile_unavailable",
    };
  }
  if (profile.needs_rename || profile.needs_name_confirm) {
    return { success: false, requiresRename: true, next: renameNext };
  }

  const enroll = await ensureClubMembership(club.slug, user.id);
  if (!enroll.ok) {
    return {
      success: false,
      error: "Could not join this club. Please try again.",
      code: "membership_failed",
    };
  }

  let queueAction: JoinQueueActionKind | undefined;
  if (resolvedSessionId) {
    const queued = await joinQueueAction(resolvedSessionId);
    if (queued.requiresRename) {
      return { success: false, requiresRename: true, next: renameNext };
    }
    if (!queued.success) {
      const closed = /session has ended/i.test(queued.error ?? "");
      return {
        success: false,
        error: queued.error ?? "Could not join the queue. Please try again.",
        code: closed ? "session_closed" : "queue_failed",
      };
    }
    queueAction = queued.action;
  }

  return {
    success: true,
    destination,
    membershipAction: enroll.action,
    queueAction,
    joined: enroll.joined,
  };
}
