"use server";

// ============================================================
// Auth Server Actions
// ============================================================
// Handles anonymous sign-in with PIN, duplicate name check,
// and reconnect flow for returning players.
// ============================================================

import { createServerSupabaseClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { redirect } from "next/navigation";
import type { SkillLevel } from "@/types/database";
import { PUBLIC_PROFILE_COLUMNS } from "@/types/database";
import { displayNameSchema, pinSchema, skillLevelSchema } from "@/lib/schemas/auth";
import { isNameTaken } from "@/lib/dup-name";
import { ensureClubMembership, getClubBySlug, resolveSessionClubSlug } from "@/lib/clubs";
import { getClientIp } from "@/lib/client-ip";
import { clubPlay, clubBase, clubWrapped } from "@/lib/club-paths";
import { shouldRefreshLeaderboard } from "@/lib/leaderboard-refresh";

// Shared message for a display name that already exists.
//
// DELIBERATELY COVERS BOTH CASES — "this is your own old account" and "someone
// else has this name" — with identical wording. Registration is an unauthenticated,
// unthrottled endpoint, so any wording that distinguishes the two turns it into a
// free PIN oracle (see the returning-player check below).
const NAME_TAKEN_MESSAGE =
  'That name is already registered. If it\'s you, use "Reconnect" below to pick up where ' +
  'you left off — otherwise add an initial (e.g. "Miggy L.").';

// Escape ILIKE special characters so a caller-supplied string is always
// treated as a literal — never as a wildcard pattern.
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

// ── Registration ────────────────────────────────────────────

export async function signInAnonymously(formData: FormData) {
  const rawName = formData.get("display_name") as string | null;
  const rawSkillLevel = formData.get("skill_level");
  const rawPin = formData.get("pin") as string | null;
  // Optional: if joining via QR/link, redirect straight to that session.
  const sessionId = (formData.get("session_id") as string)?.trim() || null;
  // Optional: club context from a /c/[clubSlug]/join QR — enroll + route into the club.
  const clubSlug = (formData.get("club_slug") as string)?.trim() || null;
  const destination = clubSlug
    ? sessionId
      ? clubPlay(clubSlug, sessionId)
      : clubBase(clubSlug)
    : sessionId
      ? `/play/${sessionId}`
      : "/play";

  // ── Zod validation ───────────────────────────────────────
  const nameResult = displayNameSchema.safeParse(rawName ?? "");
  if (!nameResult.success) {
    return { success: false, error: nameResult.error.issues[0].message };
  }
  const displayName = nameResult.data; // trimmed + spaces collapsed

  // Validate skillLevel against the canonical SkillLevel enum at runtime —
  // `as SkillLevel` is a compile-time cast only and would silently pass any
  // arbitrary string from a crafted FormData payload.
  const skillLevelResult = skillLevelSchema.safeParse(rawSkillLevel);
  if (!skillLevelResult.success) {
    return { success: false, error: skillLevelResult.error.issues[0].message };
  }
  const skillLevel: SkillLevel = skillLevelResult.data;

  const pinResult = pinSchema.safeParse(rawPin ?? "");
  if (!pinResult.success) {
    return { success: false, error: pinResult.error.issues[0].message };
  }
  const pin = pinResult.data;

  const supabase = await createServerSupabaseClient();

  // Check if already signed in.
  const {
    data: { user: existingUser },
  } = await supabase.auth.getUser();

  const service = createServiceClient();

  if (existingUser) {
    // Already authenticated — upsert the profile. Upsert (not update) so an
    // authed-but-profileless user (e.g. a merged-away ghost's stale cookie)
    // RE-CREATES their missing profile here instead of a no-op update, which is
    // what breaks the profileless redirect loop. The partial UNIQUE index is the
    // authority for global name uniqueness, so a taken name surfaces as 23505.
    // Service client — ON CONFLICT DO UPDATE needs column-read privilege on
    // the SET columns (including pin), which the browser/anon-key client no
    // longer has (20260701000010_column_lockdown_fix_table_grants.sql).
    // Sanctioned service-role-for-PINs use case (CLAUDE.md §Database Strictness).
    const { error: upsertError } = await service
      .from("profiles")
      .upsert(
        { id: existingUser.id, display_name: displayName, skill_level: skillLevel, pin },
        { onConflict: "id" }
      );

    if (upsertError) {
      if (upsertError.code === "23505") {
        return { success: false, error: NAME_TAKEN_MESSAGE };
      }
      return { success: false, error: upsertError.message };
    }

    if (clubSlug) {
      const enroll = await ensureClubMembership(clubSlug, existingUser.id);
      // Club vanished / membership write failed — send them to their own player
      // context (/play resolves their club, or the join-via-QR screen), not a
      // gated club route that would bounce them.
      if (!enroll.ok) redirect("/play");
    }
    redirect(destination);
  }

  // ── Name availability ─────────────────────────────────────────────────────
  // BOTH checks below are PIN-BLIND, and that is the point. This used to open
  // with `.ilike(name).eq("pin", pin)`, replying "Looks like you've played
  // before!" on a hit and falling through to "Name taken" on a miss.
  // Registration is unauthenticated and intentionally unthrottled (a club signs
  // up a dozen walk-ins at once), so those two replies were a free PIN oracle:
  // submit one name against all 9,000 PINs and watch for the flip. It defeated
  // the reconnectPlayer limiter below end-to-end — recover the PIN here for
  // nothing, then spend a single reconnect attempt. Every arm now returns the
  // same NAME_TAKEN_MESSAGE, so a right and a wrong PIN are indistinguishable.
  //
  // (1) Any profile at all holding this name, flagged or not. Catches a
  // returning player whose profile is FLAGGED — isNameTaken deliberately
  // excludes those to mirror the partial unique index `WHERE needs_rename =
  // false`, so without this check their registration would succeed and mint a
  // second account, stranding their history behind a ghost. The trade is that a
  // name held only by a flagged duplicate is not claimable by someone else
  // until that duplicate renames. Accepted knowingly: stranded history is
  // permanent data loss, whereas this only bites once the non-flagged holder
  // is gone (while it exists, isNameTaken blocks the name anyway), and the
  // remedy — "add an initial" — is what the message already tells them.
  //
  // Caveat worth knowing: clearing a flag is SELF-SERVE ONLY (renamePlayer
  // derives the user from the session; there is no organizer or admin path).
  // If that player never returns, the name stays blocked and freeing it needs
  // a DB touch.
  //
  // `.limit(1)` IS LOAD-BEARING, not tidiness. A duplicate cluster legitimately
  // has several rows sharing one raw name, and maybeSingle() ERRORS on more
  // than one — leaving `data` undefined and this check silently failing open,
  // i.e. minting the very ghost it exists to prevent. Pinned by RO-MULTI-1.
  const { data: nameHolder } = await service
    .from("profiles")
    .select("id")
    .ilike("display_name", escapeLike(displayName))
    .limit(1)
    .maybeSingle();

  if (nameHolder) {
    return { success: false, error: NAME_TAKEN_MESSAGE };
  }

  // (2) Backstop for check (1), which ignores its own read error and so fails
  // open on a transient DB blip. isNameTaken's match set is otherwise a strict
  // SUBSET of (1)'s — same ilike, plus `needs_rename = false`, plus a narrowing
  // normalized-key compare — so in the happy path it can never fire when (1)
  // did not. Keep it anyway: it is cheap, and it is the fail-open cover.
  //
  // It does NOT widen the net. dup-name.ts pre-filters in SQL with the same raw
  // `ilike`, so a stored name differing from the input by more than case (e.g.
  // an internal double space) is never fetched and the JS normalize compare
  // cannot reach it. Those variants are caught ONLY by the partial UNIQUE index
  // at write time, whose 23505 the upsert below maps to this same message —
  // that index, not either check here, is the TOCTOU/cross-instance authority.
  if (await isNameTaken(service, displayName)) {
    return { success: false, error: NAME_TAKEN_MESSAGE };
  }

  // Sign in anonymously. Supabase creates an auth.users row
  // and our trigger auto-creates the profiles row.
  const { data, error } = await supabase.auth.signInAnonymously({
    options: {
      data: {
        display_name: displayName,
        skill_level: skillLevel,
      },
    },
  });

  if (error) {
    return { success: false, error: error.message };
  }

  // The trigger should have created the profile, but if the metadata
  // didn't propagate, fire an upsert as a safety net (with PIN).
  // Awaited so we can surface DB-level errors (e.g. 23505 unique violation).
  if (data.user) {
    // Service client — same column-privilege reason as the upsert above.
    const { error: upsertError } = await service.from("profiles").upsert(
      {
        id: data.user.id,
        display_name: displayName,
        skill_level: skillLevel,
        pin,
      },
      { onConflict: "id" }
    );

    if (upsertError) {
      // PostgreSQL unique violation — display_name already registered
      if (upsertError.code === "23505") {
        // Same wording as the pre-checks — this is the TOCTOU arm of the very
        // same "name exists" answer and must not read differently.
        return { success: false, error: NAME_TAKEN_MESSAGE };
      }
      console.error("[auth] profile upsert safety-net failed:", upsertError);
    }
  }

  // QR-join enrollment: a brand-new scanner becomes an active member of the
  // club, so the club route's membership gate lets them straight in.
  if (clubSlug && data.user) {
    const enroll = await ensureClubMembership(clubSlug, data.user.id);
    // Enrollment failed — send them to their own player context (/play resolves
    // their club or the join-via-QR screen), not the owner-only /clubs hub.
    if (!enroll.ok) redirect("/play");
  }
  redirect(destination);
}

// ── Reconnect ────────────────────────────────────────────────
// Finds an existing player by name + PIN across active sessions,
// creates a new anonymous auth identity, and migrates all DB
// references (profiles, queue_entries, match_players) from the
// old user ID to the new one.

export interface ReconnectResult {
  success: boolean;
  error?: string;
  /** ID of an active session to rejoin, if one was found. */
  sessionId?: string;
  /** Set when the reconnected profile is a flagged duplicate (→ /rename). */
  requiresRename?: boolean;
  /**
   * If the player's most recent session has already closed and Wrapped stats
   * exist, this is set to the /wrapped URL so the caller can redirect them
   * directly to their results instead of dropping them on the lobby.
   */
  wrappedUrl?: string;
  /**
   * True when the target account has Google linked — the caller should guide
   * the user to use "Continue with Google" instead of PIN reconnect, which
   * would lose the Google identity link.
   */
  useGoogleSignIn?: boolean;
}

// ── Reconnect rate limiting ───────────────────────────────────
/** Failed reconnects allowed against ONE display_name before lockout. */
const RECONNECT_MAX_FAILED_NAME = 10;
/**
 * Failed reconnects allowed from one IP. Deliberately loose: a badminton club
 * is a single-NAT environment (one gym Wi-Fi, plus CGNAT on mobile), so a tight
 * IP budget would let one person lock out reconnect for the whole venue.
 */
const RECONNECT_MAX_FAILED_IP = 60;
/**
 * Scope-wide failure count that trips a spray ALERT. Purely advisory — it is
 * logged and never denies, so read it as monitoring, not as a limit.
 *
 * It started life as a hard cap and that was a mistake: a shared counter is a
 * platform-wide kill switch on login. ~30 enumerable names across ~5 IPs at
 * 0.33 rps holds it open indefinitely, and reconnect IS the account for an
 * anonymous-auth player. Denial stays on the two arms with a bounded blast
 * radius — the name under attack, and the source IP. See 20260721230000.
 */
const RECONNECT_SPRAY_ALERT_AT = 300;
/** Rolling lockout window, minutes. */
const RECONNECT_WINDOW_MIN = 15;
const RECONNECT_LOCKED = "Too many attempts. Please wait a few minutes and try again.";

export async function reconnectPlayer(
  playerName: string,
  pin: string,
  clubSlug?: string | null
): Promise<ReconnectResult> {
  // Validate via Zod — same rules as registration
  const nameResult = displayNameSchema.safeParse(playerName ?? "");
  if (!nameResult.success) {
    return { success: false, error: nameResult.error.issues[0].message };
  }
  const name = nameResult.data; // trimmed + normalized

  const pinResult = pinSchema.safeParse(pin ?? "");
  if (!pinResult.success) {
    return { success: false, error: pinResult.error.issues[0].message };
  }
  const service = createServiceClient();

  // ── Rate-limit gate (before the PIN is ever checked) ─────────
  // reconnectPlayer is a credential oracle: name + PIN returns an account and
  // then MIGRATES the caller's identity onto it. The PIN space is 9,000
  // (src/lib/pin.ts), display names are readable to any authenticated user and
  // are printed on the public /tv and leaderboard share pages — so without a
  // limit an attacker picks a name and walks the space to full account
  // takeover, needing no organizer rights at all.
  //
  // Keyed on the normalized display_name BEING ATTACKED rather than on the
  // caller: the caller is anonymous here and can mint identities freely, so a
  // caller-keyed limit would be worthless. Also keyed on IP.
  //
  // Atomic and FAIL-CLOSED: the RPC records the attempt and returns the verdict
  // in one transaction, and any error denies rather than waving the caller
  // through. An already-over caller is denied WITHOUT recording a new row, so a
  // sustained attack cannot keep a victim's window topped up forever (reconnect
  // IS the account for an anonymous-auth player — there is no email reset behind
  // it, so a self-feeding window would be a permanent account lockout).
  const subject = name.trim().toLowerCase();
  const ip = await getClientIp();
  const { data: gate, error: gateErr } = await service
    .rpc("reconnect_record_and_check", {
      p_subject: subject,
      p_ip: ip,
      p_window_min: RECONNECT_WINDOW_MIN,
      p_subject_max: RECONNECT_MAX_FAILED_NAME,
      p_ip_max: RECONNECT_MAX_FAILED_IP,
      p_spray_alert_at: RECONNECT_SPRAY_ALERT_AT,
    })
    .maybeSingle();

  if (gateErr || !gate) {
    console.error("[reconnectPlayer] rate-limit check failed:", gateErr?.message);
    return { success: false, error: RECONNECT_LOCKED };
  }
  // Advisory: surfaced for monitoring, deliberately NOT a denial (see
  // RECONNECT_SPRAY_ALERT_AT). Logged whether or not this caller is blocked.
  if (gate.spray_suspected) {
    console.warn(
      "[reconnectPlayer] SPRAY SUSPECTED: scope-wide reconnect failures exceeded " +
        `${RECONNECT_SPRAY_ALERT_AT} in ${RECONNECT_WINDOW_MIN}m. Not blocking.`
    );
  }
  if (gate.over_subject_limit || gate.over_ip_limit) {
    // Log WHICH arm fired so support can tell a shared venue IP apart from a
    // targeted guessing run against one player's name.
    console.warn(
      `[reconnectPlayer] locked out (name=${gate.over_subject_limit} ip=${gate.over_ip_limit})`
    );
    return { success: false, error: RECONNECT_LOCKED };
  }

  // The attempt is logged pessimistically as a failure; flip it once the PIN
  // actually matches so a legitimate reconnect doesn't consume the window.
  // attempt_id is null only on the over-limit path, which returned above.
  const attemptId = gate.attempt_id;
  const markReconnectSucceeded = async () => {
    if (!attemptId) {
      // Unreachable: the SQL only returns a null id on the over-limit path,
      // which returned above. Warn rather than no-op silently — if that
      // contract ever breaks, every legitimate reconnect starts burning the
      // caller's budget and nothing else would say so.
      console.warn("[reconnectPlayer] no attempt id to flip — limiter contract changed?");
      return;
    }
    const { error } = await service.rpc("auth_attempt_mark_succeeded", {
      p_attempt_id: attemptId,
    });
    if (error) console.error("[reconnectPlayer] attempt-log update failed:", error.message);
  };

  // Resolve the caller's club context (set when reconnecting via a
  // club-scoped page, e.g. /c/[clubSlug]/join) so the lookup below can be
  // scoped to that club instead of matching across every club in the system.
  const club = clubSlug ? await getClubBySlug(clubSlug) : null;

  // Find the profile by name + PIN (case-insensitive name match). Scoped to
  // the caller's own club when known — display_name is unique only among
  // non-flagged profiles (a flagged duplicate keeps its old name until it
  // renames, see dup-name.ts), and PINs are a short numeric code with
  // limited entropy, so an unscoped global lookup could match a different
  // player in another club who coincidentally shares both. Mirrors the
  // sessions!inner(...) nested-join filter pattern used elsewhere in this
  // function (Phase 1/3 queue_entries lookups below).
  //
  // club_members has TWO foreign keys to profiles (player_id, invited_by),
  // so the embed must be disambiguated with the FK constraint name — a bare
  // `club_members!inner(...)` throws PGRST201 (ambiguous relationship).
  const { data: profiles } = club
    ? await service
        .from("profiles")
        .select("*, club_members!club_members_player_id_fkey!inner(club_id)")
        .ilike("display_name", escapeLike(name))
        .eq("pin", pinResult.data)
        .eq("club_members.club_id", club.id)
    : await service
        .from("profiles")
        .select("*")
        .ilike("display_name", escapeLike(name))
        .eq("pin", pinResult.data);

  if (!profiles || profiles.length === 0) {
    // Wrong name/PIN: the pessimistic failure row stands and counts.
    return { success: false, error: "No match found. Check your name and PIN." };
  }

  // Correct credentials — clear the pessimistic failure so a legitimate
  // reconnect never contributes to the lockout window.
  await markReconnectSucceeded();

  // Pick the best profile across all matches, in three phases:
  //
  // Phase 1: active queue entry (waiting / on_deck / playing) → highest priority.
  // Phase 2: pending / in_progress match assignment → still in a live game.
  // Phase 3: most-recently-joined queue entry (any status) → picks the account
  //          with real history rather than a ghost profile that has no data.
  //          Fixes the bug where only profiles[0] was checked, causing reconnect
  //          to target a ghost account and silently migrate nothing.
  //
  // Fall-through: if none of the above match, keep profiles[0] as the target.

  let targetProfile = profiles[0];
  let targetSessionId: string | null = null;

  // Phase 1 — active queue entry.
  for (const profile of profiles) {
    const { data: activeEntry } = await service
      .from("queue_entries")
      .select("session_id, sessions!inner(is_active)")
      .eq("player_id", profile.id)
      .in("status", ["waiting", "drafted", "on_deck", "playing"])
      .limit(1)
      .single();

    if (activeEntry) {
      targetProfile = profile;
      targetSessionId = activeEntry.session_id;
      break;
    }
  }

  // Phase 2 — pending / in_progress match (loop all profiles).
  if (!targetSessionId) {
    for (const profile of profiles) {
      const { data: activeMatch } = await service
        .from("match_players")
        .select("matches!inner(session_id, status)")
        .eq("player_id", profile.id)
        // C3: filter to a LIVE match in SQL. Without this, .limit(1) returned an
        // arbitrary historical match, so a player actually in a pending/in_progress
        // match was almost never detected here and fell through to Phase 3.
        .in("matches.status", ["pending", "in_progress"])
        .limit(1)
        .maybeSingle();

      if (activeMatch && activeMatch.matches) {
        const match = activeMatch.matches as unknown as { session_id: string; status: string };
        if (match.status === "pending" || match.status === "in_progress") {
          targetProfile = profile;
          targetSessionId = match.session_id;
          break;
        }
      }
    }
  }

  // Phase 3 — most recent queue history across ALL profiles (any status).
  // This prevents targeting a ghost profile (0 games) when a real profile
  // with actual data exists but whose queue entry is status="left".
  if (!targetSessionId) {
    let bestJoinedAt: Date | null = null;

    for (const profile of profiles) {
      const { data: anyEntry } = await service
        .from("queue_entries")
        .select("session_id, joined_at, sessions!inner(is_active)")
        .eq("player_id", profile.id)
        .order("joined_at", { ascending: false })
        .limit(1)
        .single();

      if (anyEntry) {
        const joinedAt = new Date(anyEntry.joined_at as string);
        if (!bestJoinedAt || joinedAt > bestJoinedAt) {
          bestJoinedAt = joinedAt;
          targetProfile = profile;
          // If this session is still active, capture it.
          const sessionMeta = anyEntry.sessions as unknown as { is_active: boolean };
          if (sessionMeta?.is_active) {
            targetSessionId = anyEntry.session_id;
          }
        }
      }
    }
  }

  // No active session — proceed with migration so the auth cookie is set,
  // then the caller redirects to the lobby (/play) instead of crashing.
  // targetSessionId remains null here; the return below handles it.

  const oldUserId = targetProfile.id;

  // Guard: if the old account has Google linked, PIN reconnect would create a
  // new anonymous user and lose the Google identity. Direct the player to
  // "Continue with Google" instead — that flow signs back into the same user.
  const { data: oldAuthData } = await service.auth.admin.getUserById(oldUserId);
  const oldHasGoogleLinked =
    oldAuthData?.user?.identities?.some((id) => id.provider === "google") ?? false;
  if (oldHasGoogleLinked) {
    return {
      success: false,
      error: "This account uses Google sign-in. Tap 'Continue with Google' above to sign back in.",
      useGoogleSignIn: true,
    };
  }

  // Create a new anonymous auth session for this browser.
  // IMPORTANT: signInAnonymously returns the EXISTING user unchanged when a
  // session is already present (Supabase documented behaviour). If that happens,
  // newUserId === oldUserId and migrate_player_identity throws its same-UUID
  // safety guard → "Failed to migrate". Sign out first to guarantee a fresh
  // identity is minted, regardless of whether the player still has a cookie.
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();

  // Do NOT pass display_name in metadata here. The handle_new_user trigger would
  // try to INSERT a profile with the same name that already exists, hitting the
  // idx_profiles_unique_active_name unique index → "Database error creating anonymous
  // user". migrate_player_identity deletes the placeholder profile immediately after,
  // so the name in it never matters.
  const { data: authData, error: authError } = await supabase.auth.signInAnonymously();

  if (authError || !authData.user) {
    return { success: false, error: authError?.message ?? "Failed to create session." };
  }

  const newUserId = authData.user.id;

  // Defense-in-depth: if signOut() failed to clear the server-side cookie
  // (e.g. hosting environment quirk), signInAnonymously could still return
  // the existing session, making newUserId === oldUserId.  The SQL function
  // has a same-UUID guard that would throw, but catching it here first gives
  // a cleaner error path and keeps the orphaned new-auth-user cleanup in JS
  // rather than relying on the SQL rollback to surface it.
  if (newUserId === oldUserId) {
    console.error(
      "[reconnectPlayer] signInAnonymously returned the same UUID as the target profile — " +
        "sign-out did not clear the session. Player should retry.",
      { oldUserId }
    );
    return { success: false, error: "Session conflict — please sign out and try again." };
  }

  // ── Migrate all references from old ID to new ID (atomic) ──
  // Steps 1–5 run inside migrate_player_identity(), a single
  // Postgres transaction (migration 20260429000000_wave2_atomicity).
  // Any failure in steps 1–4.5 (the fatal path) rolls back all DB
  // writes so neither player is left in a broken half-migrated state.
  // Steps 4.6 (wrapped_stats) and 4.7 (session_organizers) are
  // wrapped in savepoint blocks and are non-fatal.
  //
  // Step 6 (auth.admin.deleteUser) cannot live in a Postgres function
  // so it remains here, gated on the isActiveOrganizer return value.
  const { data: isActiveOrganizer, error: migrateErr } = await service.rpc(
    "migrate_player_identity",
    { p_old_user_id: oldUserId, p_new_user_id: newUserId }
  );

  if (migrateErr) {
    console.error("[reconnectPlayer] migrate_player_identity RPC failed:", migrateErr.message);
    // The transaction was rolled back — old account is intact.
    // Clean up the newly-created auth user so the player can retry.
    const { error: cleanupErr } = await service.auth.admin.deleteUser(newUserId);
    if (cleanupErr) {
      console.error(
        "[reconnectPlayer] Failed to clean up new auth user after RPC failure — stale auth row:",
        cleanupErr.message,
        { newUserId }
      );
    }
    return { success: false, error: "Failed to migrate account. Please try again." };
  }

  if (isActiveOrganizer) {
    console.log(
      "[reconnectPlayer] Old user is the primary organizer of an active session — " +
        "sessions.created_by, profile, and auth user preserved to keep organizer " +
        "dashboard valid on their other device.",
      { oldUserId, newUserId }
    );
  }

  // ── Refresh all-time leaderboard (non-blocking) ────────────
  // migrate_player_identity reassigns match_players rows to newUserId,
  // which leaves the materialized view stale until the next match ends.
  // Refreshing here eliminates the staleness window so the leaderboard
  // is immediately correct for the reconnected player.
  // Non-fatal: a refresh failure does not affect the reconnect itself.
  // Debounced (shared with endMatchAction) since the RPC rebuilds across
  // ALL clubs, not just this player's.
  if (shouldRefreshLeaderboard()) {
    void service.rpc("refresh_alltime_leaderboard").then(({ error }) => {
      if (error) {
        console.warn(
          "[reconnectPlayer] refresh_alltime_leaderboard failed (non-fatal):",
          error.message
        );
      }
    });
  }

  // Step 6: Delete old auth user (only when not an active organizer).
  // Cannot be done inside the Postgres function — auth.admin is a
  // Supabase Auth operation, not a DB operation.
  if (!isActiveOrganizer) {
    const { error: deleteErr } = await service.auth.admin.deleteUser(oldUserId);
    if (deleteErr) {
      console.error(
        "[reconnectPlayer] Failed to delete old auth user — stale auth row may remain:",
        deleteErr.message,
        { oldUserId, newUserId }
      );
      // Non-fatal: DB migration succeeded; the player is fully functional.
      // The stale auth.users row has no profile and cannot be used to log in.
    }
  }

  // ── Post-migration reconciliation ──────────────────────────
  // Race condition: if a match ended (endMatchAction) at the exact
  // moment migrate_player_identity was moving match_players from
  // oldUserId → newUserId, endMatchAction's re-queue step operated
  // on oldUserId and found 0 rows (already migrated). The player's
  // newUserId queue entry stays stuck as "playing" or "on_deck"
  // even though the match is already completed or cancelled.
  //
  // Fix: after migration, check the player's queue entry for the
  // active session. If the entry is "playing"/"on_deck" but the
  // associated match is no longer in_progress/pending, reset the
  // entry to "waiting" so the player is re-queued correctly.
  //
  // This runs only when we know the player was in an active session
  // (targetSessionId is set). Non-fatal: any error is logged and
  // silently swallowed — the reconnect itself already succeeded.
  if (targetSessionId) {
    try {
      const { data: queueEntry } = await service
        .from("queue_entries")
        .select("id, status")
        .eq("session_id", targetSessionId)
        .eq("player_id", newUserId)
        .in("status", ["playing", "drafted", "on_deck"])
        .maybeSingle();

      if (queueEntry) {
        // Player's queue entry is stuck in a match-related status.
        // Verify whether they have an active match in THIS session.
        //
        // Query via matches (has session_id) joined to match_players so
        // the result is scoped to the current session. An unscoped
        // match_players query could return a historical in_progress row
        // from a different session and falsely conclude the match is live.
        const { data: activeMatch } = await service
          .from("matches")
          .select("id, status, match_players!inner(player_id)")
          .eq("session_id", targetSessionId)
          .in("status", ["pending", "in_progress"])
          .eq("match_players.player_id", newUserId)
          .maybeSingle();

        const matchIsStillActive = !!activeMatch;

        if (!matchIsStillActive) {
          // Match ended while migration was in flight — reset entry to "waiting".
          console.log(
            "[reconnectPlayer] Post-migration reconciliation: " +
              `queue entry stuck as "${queueEntry.status}" with no active match — ` +
              `resetting to "waiting".`,
            { newUserId, sessionId: targetSessionId }
          );
          await service
            .from("queue_entries")
            .update({ status: "waiting" as const })
            .eq("id", queueEntry.id);
        }
      }
    } catch (reconcileErr) {
      console.warn(
        "[reconnectPlayer] Post-migration reconciliation failed (non-fatal):",
        reconcileErr
      );
    }
  }

  // ── Offline Wrapped redirect ────────────────────────────────
  // If the player isn't rejoining an active session, check whether
  // their most recently closed session has Wrapped stats available.
  // We look for sessions that ended within the last 48 hours so we
  // don't redirect returning players to stale results from weeks ago.
  let wrappedUrl: string | undefined;
  if (!targetSessionId) {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: recentEntry } = await service
      .from("queue_entries")
      .select("session_id, sessions!inner(is_active, ended_at)")
      .eq("player_id", newUserId)
      .order("joined_at", { ascending: false })
      .limit(10);

    // Closed-within-window sessions, newest-first (recentEntry is joined_at-desc).
    const eligibleSessionIds = (recentEntry ?? [])
      .filter((entry) => {
        const sess = entry.sessions as unknown as { is_active: boolean; ended_at: string | null };
        return !sess.is_active && sess.ended_at !== null && sess.ended_at >= cutoff;
      })
      .map((entry) => entry.session_id);

    if (eligibleSessionIds.length > 0) {
      // One membership query instead of a per-candidate single-row loop; pick the
      // newest eligible session that actually has Wrapped stats.
      const { data: wrappedRows } = await service
        .from("session_wrapped_stats")
        .select("session_id")
        .eq("player_id", newUserId)
        .in("session_id", eligibleSessionIds);
      const wrappedSet = new Set((wrappedRows ?? []).map((r) => r.session_id));

      const chosen = eligibleSessionIds.find((id) => wrappedSet.has(id));
      if (chosen) {
        const clubSlug = await resolveSessionClubSlug(chosen);
        wrappedUrl = clubSlug
          ? clubWrapped(clubSlug, chosen, newUserId)
          : `/wrapped/${chosen}/${newUserId}`;
      }
    }
  }

  // Duplicate-name gate: a flagged profile (the flag travels through
  // migrate_player_identity) must resolve their name before continuing. The
  // modal routes a requiresRename result to /rename.
  const { data: renamedProfile } = await service
    .from("profiles")
    .select("needs_rename")
    .eq("id", newUserId)
    .maybeSingle();
  const requiresRename = renamedProfile?.needs_rename ?? false;

  return {
    success: true,
    sessionId: targetSessionId ?? undefined,
    wrappedUrl,
    requiresRename,
  };
}

// ── Sign Out ─────────────────────────────────────────────────

export async function signOut() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/");
}

/**
 * playerLogOut — clears the player's auth session and redirects to the
 * login screen.  Called from the player dashboard "Sign out" escape hatch.
 *
 * Distinct from "Leave Session" (checkoutPlayer) which only removes the
 * player from the queue but keeps them authenticated.  Use this when the
 * player wants to switch accounts or hand the device to someone else.
 */
export async function playerLogOut(): Promise<void> {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/");
}

// ── Get Current Profile ──────────────────────────────────────

export async function getCurrentProfile() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select(PUBLIC_PROFILE_COLUMNS)
    .eq("id", user.id)
    .single();

  return profile ? { ...profile, pin: null } : null;
}
