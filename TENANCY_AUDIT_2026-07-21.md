# TENANCY AUDIT — Badminton Queue App (prod `usxftpexoimletqmrggb`)

## 1. VERDICT

**No. Club/session segregation is not sound today — a logged-in user (including a throwaway anonymous account) can reach data and even take over accounts they were never granted.** The DB's RLS is well-built and its helper functions are correct, but the application layer routinely bypasses RLS with the service-role client and then authorizes on the *wrong identifier*, so the RLS boundary is defeated from above. The environment currently has exactly **one club (CHILLAX, 183 active members, 23 sessions)**, which masks every *cross-club* finding — but several holes are exploitable **right now, within that one club**, and the rest go live the instant a second club onboards.

**The single most important thing to fix:** the **PIN account-takeover chain** in `src/app/actions/profile.ts`. Those four organizer actions verify that the caller organizes *some* session (the `sessionId` argument) but never verify that the *target* `userId` has anything to do with that session or its club. Combined with the ability for any authenticated user to self-provision an organizer session (`createSession` with no `clubId`), this lets anyone read or overwrite the PIN of any of the 183 real members — and since a name+PIN drives `reconnectPlayer`'s identity migration, that is full account takeover. Fix the authorize-on-A/operate-on-B decoupling first; everything else is read-only leakage by comparison.

---

## 2. CONFIRMED ISSUES (ranked by real-world risk)

### #1 — PIN read/reset with an unbound target → account takeover  🔴 CRITICAL · EXPLOITABLE TODAY
**File:** `src/app/actions/profile.ts` (`getPlayerPin` :72, `resetPlayerPin` :90, `updatePlayerPin` :114, `updatePlayerSkill` :31)

- **What leaks / breaks:** Any member's 4-digit PIN can be read or overwritten, and their skill edited. The PIN is the reconnect credential; display names are readable by every authenticated user (`profiles_select USING(true)`). Verified: `reconnectPlayer(name, pin)` (auth.ts:224) finds the profile by name+PIN and migrates the identity onto it via `migrate_player_identity` — so PIN + known name = **full account takeover**.
- **Who can reach it:** Any authenticated user who organizes *any* session. All four actions gate only on `isSessionOrganizer(user.id, sessionId)` and then run a service-role read/write against the **global** `profiles` table keyed by the caller-supplied `userId`, which is never checked against the session or its club.
- **Concrete attack (verified mechanics):** `signInAnonymously` → `createSession({name:'x', scoring:'first_to_21'})` with **no** `clubId` (see #2) → you are now organizer of a real session → `getPlayerPin(mySessionId, VICTIM_ID)` returns e.g. `4821` → `reconnectPlayer(victimName, '4821')` migrates their account onto your new identity. `resetPlayerPin`/`updatePlayerPin` achieve takeover even without reading the PIN.
- **Today vs later:** Exploitable **today** against all 183 CHILLAX members — needs no second club. Any of the club's legitimate organizers can already do this to any member; #2 just removes the "must be an organizer" precondition entirely.
- **Fix:** After the organizer gate, prove the target `userId` shares scope with `sessionId` — require a `queue_entries` row for `(sessionId, userId)` **or** a `club_members` row for `(session.club_id, userId)` — before the service-role read/write. Reject otherwise. The id that authorizes and the id that is operated on must be proven to be in the same scope.

### #2 — `createSession` self-provisions organizer rights with no membership  🟠 HIGH · EXPLOITABLE TODAY
**File:** `src/app/actions/sessions.ts:113`

- **What breaks:** The club-admin check `if (!(await isClubAdmin(...)))` runs **only** when a non-empty `clubId` is passed. Omit `clubId` and the branch is skipped; the row inserts with `created_by = user.id` and the DB DEFAULT club (CHILLAX). `isSessionOrganizer` treats `created_by` as the fast-path organizer (confirmed `_shared.ts:94`), so a fresh anonymous user instantly holds the entire organizer server-action surface for a real session in the founding club without being a member of it.
- **Who / today:** Any authenticated user, **today**. This is the privilege-provisioning primitive that turns #1, #4, live swaps, and roster reads from "needs an organizer" into "needs any login."
- **Fix:** Require an explicit club context and always verify `isClubAdmin` (or at minimum `isClubMember`) for the resolved club. Treat a missing `clubId` as an error, not an implicit grant into CHILLAX.

### #3 — `joinAsCoOrganizer`: ~100-value passcode, no rate limit, cross-club search  🟠 HIGH · EXPLOITABLE TODAY
**File:** `src/app/actions/sessions.ts:222` (generator :48)

- **What breaks:** `generatePasscode()` = one of 10 `BIRDIE_WORDS` + one digit = **100 possible values (~6.6 bits)**, using `Math.random()`. `joinAsCoOrganizer` does a service-role lookup across **all** active sessions in **all** clubs (`.eq('is_active',true).eq('organizer_passcode',normalized)`) with no club scoping, no throttling, no lockout. A hit inserts a `session_organizers` row → full co-organizer rights (roster reads, PIN actions per #1, match events, live swaps).
- **Who / today:** Any authenticated user can walk all 100 passcodes in ~100 POSTs and co-organize whichever active sessions currently hold them. Live today; becomes cross-club at a second club.
- **Fix:** Add per-user/IP rate limiting and lockout; raise entropy (more chars, `crypto.getRandomValues`); scope the lookup to a known club context rather than searching every active session globally.

### #4 — `getMatchEvents` authorizes on `sessionId` but reads by `matchId`  🟡 MEDIUM · cross-session TODAY
**File:** `src/app/actions/match-events.ts:24`

- **What leaks:** Gates on `isSessionOrganizer(user.id, sessionId)`, then queries `match_events` (service role) with only `.eq('match_id_snapshot', matchId)` — `matchId` is never bound to `sessionId`. An organizer of one session can pass any other session's `matchId` and receive that match's full audit trail: player movements (jsonb), actor names, payloads, phases.
- **Who / today:** Any self-provisioned organizer (#2) → cross-session **today** within CHILLAX; cross-club later.
- **Fix:** Fetch the match, confirm `match.session_id === sessionId` (mirror the guard already in the swap/fix actions) before returning; or add `session_id_snapshot = sessionId` to the query.

### #5 — Legacy shims `/play/[sessionId]` & `/organizer/[sessionId]` self-enroll any visitor into the session's club  🟠 HIGH · club boundary void TODAY, cross-club at 2nd club
**Files:** `src/app/play/[sessionId]/page.tsx:31`, `src/app/organizer/[sessionId]/page.tsx:29`; sink `ensureClubMembership` (`src/lib/clubs.ts:305`)

- **What breaks:** Both shims resolve the owning club from a **client-supplied session UUID** (`resolveSessionClubSlug` — service role, no auth, no `is_active` filter) and then call `ensureClubMembership(slug, user.id)` for **any** authenticated visitor. `ensureClubMembership` service-role-INSERTs an active `club_members role='member'` row with **no** invite/tie check — possession of the slug is treated as sufficient. The `(full)` layout's `requireClubMembership` then passes because the row was just written, granting member-level RLS read over the whole club: every session, the full roster (names + skill), all published/completed matches, queue, courts, club leaderboards, and a slot in the club switcher.
- **Reachability:** Session UUIDs are semi-public — printed into the intentionally shareable `/tv/[id]` (fully public), `/leaderboard/[id]`, and `/wrapped/[id]/[playerId]` links and QR codes. So the "secret" to join a club is a value the product deliberately distributes.
- **Today vs later:** With one club, this means **anyone can become a CHILLAX member on demand**, collapsing the only membership boundary that exists (roster, session list, club leaderboards). The *cross-club* headline ("read a club you don't belong to") is latent until a second club exists — but the mechanism is live now.
- **Fix:** Do not grant membership as a side effect of viewing a link. In both shims drop `ensureClubMembership` and just 308-redirect, letting `requireClubMembership` gate (non-members already bounce to `/play`). If walk-in convenience is needed, enroll only on a genuine tie (an existing `queue_entries`/`match_players` row in that session) or a token-validated `/c/[clubSlug]/join` invite — never on bare possession of a session UUID or a guessable slug.

### #6 — Anon-EXECUTE SECURITY DEFINER leaderboard RPCs dump named stats  🟠 HIGH (privacy) · EXPLOITABLE TODAY, unauthenticated
**File:** `src/app/actions/leaderboard.ts` (:142, :224, :235, :238)

Verified live grants (`pg_proc.proacl`): all three are `SECURITY DEFINER` and hold EXECUTE for **`anon`, `authenticated`, and PUBLIC** (`=X/postgres`):
- `get_alltime_snapshot_before(p_cutoff, p_club_id DEFAULT NULL)` — with `p_club_id` NULL the filter vanishes; returns `display_name` + games/wins/losses/points_for/against/diff/win_pct for every player in every club, live-recomputed, at any point-in-time via `p_cutoff`.
- `get_session_leaderboard_public(p_session_id)` — returns any session's full named board (names, W/L, points, VIP) with no membership check.
- `get_player_streaks(p_session_id DEFAULT NULL, p_club_id DEFAULT NULL)` — with `{}` returns `(player_id, win_streak)` for every player across all sessions/clubs.

- **Who / today:** **No login at all.** Anyone with the public anon key (shipped in the JS bundle) can POST to `/rest/v1/rpc/...` and pull all 183 CHILLAX members' names + full stats **today**; becomes a genuine cross-club dump at a second club. This is the same anonymous surface as the already-known `v_alltime_leaderboard_mat` matview, but richer (point differentials, per-session boards, point-in-time slicing) and always fresh.
- **Fix:** `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` (note: revoking anon/authenticated alone is insufficient — PUBLIC holds the grant) and call these via the service role from the server actions, which already resolve the club/session server-side. The public share page (`leaderboard/[sessionId]/page.tsx`) already uses the service-role client, so revoking direct grants does not break it. Alternatively bake `is_club_member(p_club_id)` / `session_access_level(...) IS NOT NULL` into the function bodies and reject NULL scope.

*(This cluster, together with the pre-confirmed matview finding, is the second-most-impactful item after #1 — it is fully unauthenticated and live today.)*

> **STATUS 2026-07-22 (PR2 — `fix/tenancy-pr2-lock-leaderboard-reads`): CLOSED, with one accepted residual.**
> Migrations `20260722010000` (additive) + `20260722010001` (revoke) drop `anon`/`authenticated`/PUBLIC EXECUTE on all three RPCs plus `_player_name`, and SELECT on `v_alltime_leaderboard_mat` / `v_match_history` / `v_session_leaderboard`. The reads move to the service client and `getAllTimeLeaderboard` / `getPlayerStats` re-authorize in TypeScript (logged in + active member of the club being read), because a **materialized view can never carry RLS** — the GRANT was the whole control. Session-scoped streaks get a new, narrower `get_session_player_streaks(p_session_id)` gated on `session_access_level(...) IS NOT NULL`, so the browser never needs the unscoped one.
>
> **ACCEPTED RESIDUAL RISK — not closed, deliberately.** `get_session_leaderboard_public` is no longer reachable directly over PostgREST, but the full named board for any **already-known session UUID** is still readable unauthenticated through the `getSessionLeaderboard` server action, which runs as service_role. That is the documented share-link contract (`/leaderboard/[sessionId]`, same class as `/tv` and `/wrapped`): it needs a UUID you were given, and it can no longer be enumerated. What the revoke closes is the *unscoped* dump; what remains is the surface the feature is for. Revisit only if share links are ever meant to expire or require login.
>
> **Adjacent hole this PR does NOT cover → PR5.** `refresh_alltime_leaderboard()` has `proacl IS NULL` (i.e. PUBLIC EXECUTE) and is SECURITY DEFINER, so anon can still trigger `REFRESH MATERIALIZED VIEW` at will over PostgREST — a free DoS lever, not a read leak. Fold it into the PR5 sweep below.

### #7 — Unauthenticated live name feed on `session-events:{id}` broadcast channel  🟡 MEDIUM · TODAY
**File:** `src/lib/realtime.ts:255` (emit `src/lib/broadcast.ts`)

- **What leaks:** The channel is a plain (non-`private`) broadcast — RLS never applies and `realtime.messages` authorization is never enforced (no `config:{private:true}` anywhere in `src/`). Payloads carry real display names: `organizer_intervention.actorName` + `affectedPlayerIds`, `cap_saturation.anchorPlayerName` + `anchorPlayerId`, plus matchmaking/publish toggle state. Join is keyed only by `sessionId`.
- **Who / today:** Any unauthenticated client that knows a session UUID (from the public `/tv/{id}` etc.) can passively harvest the live organizer-name + player-name + intervention feed for the whole session. Live today within CHILLAX; cross-club later.
- **Fix:** Declare the channel `private` on both emit and subscribe, add a `realtime.messages` policy keyed on `session_access_level(id) IS NOT NULL`, and stop putting display names in payloads — send only ids and let each client resolve names it is authorized to read.

### #8 — Unfiltered `profiles` realtime subscription  🟡 MEDIUM · mostly latent until 2nd club
**File:** `src/lib/realtime.ts:324`

- **What leaks:** `subscribeToProfiles()` registers `postgres_changes` on `public.profiles` with no filter; because `profiles_select` is `USING(true)`, every authenticated subscriber gets a live push for every profile INSERT/UPDATE platform-wide (id, display_name, skill_level, vip_tag/theme, needs_rename, flagged_at, timestamps). Fires from `use-session-data.ts` and `use-organizer-queue.ts`.
- **Today vs later:** With one club and `profiles_select USING(true)`, this adds little over what's already readable; its real bite is a **cross-club roster-churn firehose once a second club exists**. Anon does not receive it (authenticated-only policy).
- **Fix (root cause):** Tighten `profiles_select` to shared-club visibility (an `EXISTS` over `club_members` self-join), which fixes both the query-level `USING(true)` exposure and this subscription. Keep the narrow column GRANT as defense-in-depth.

### #9 — `match_players` DELETE metadata leak  ⚪ LOW · negligible
**File:** `src/lib/realtime.ts:195`

- WALRUS skips RLS on DELETE; with no filter, every authenticated subscriber gets a DELETE event for any `match_players` row removed platform-wide. But the table is REPLICA IDENTITY DEFAULT with PK `id` only, so the payload is just an opaque row UUID — no player, match, or team. Leak is timing/volume of teardowns, nothing identifying.
- **Fix (optional):** Drive roster refresh off the already-subscribed `matches` stream and drop `match_players` from the realtime publication, or accept it. Low priority.

---

## 3. WHAT IS SOLID (do not worry about these)

- **RLS itself.** Enabled on all 20 tables; the four helper functions (`is_club_member`, `session_access_level`, `has_match_access`, `is_session_organizer`) are STABLE SECURITY DEFINER with pinned `search_path` and correct club scoping. The deny-all tables (`clubs`, `club_invites`, `club_milestones`, `leaderboard_refresh_state`, `player_renames`) are sound. The SELECT policies on `sessions`/`matches`/`match_players`/`queue`/`courts`/`club_members`/`session_wrapped_stats` are correct.
- **Column GRANTs** correctly withhold `profiles.pin` and `sessions.organizer_passcode` from anon/authenticated (the service role in #1 is what ignores them — that's an app-layer bug, not a GRANT bug).
- **`get_monthly_leaderboard`** is invoker-rights (confirmed `prosecdef=false`), so RLS correctly returns `[]` to anon — the "read any club's monthly board by slug" claim was correctly **refuted**.
- **Security-invoker views** (`v_queue_full_with_wait_time`, `v_queue_with_wait_time`, `v_recent_pairings`) respect RLS.
- **`v_match_history` / `v_session_leaderboard` had anon/authenticated SELECT revoked on prod at audit time** — but only on prod. The revoke came from `20260702152731 revoke_leaderboard_history_view_grants_post_cutover`, a migration applied by hand with **no counterpart in this repo**, so a from-scratch `db reset` still ended with `20260702000007`'s emergency re-grants and a fresh environment was *open* where prod was closed. Sound in production, drift everywhere else. `20260722010001` (PR2) makes the repo match — a no-op on prod, the real fix locally and in CI.
- **These app-layer claims are false positives / correctly refuted — drop them:**
  - *"Leaderboard actions read any club by slug"* — the slug-scoped monthly path returns `[]` for non-members; the real hole is the anon RPC grants in #6, not slug resolution.
  - *"Club command center has no session-organizer gate"* — true that any club member can open it, but that is a within-club authorization nuance, not a tenancy breach; no cross-club data crosses.
  - *"`getH2HRecord` / `joinQueueAction` cross-club H2H"* — no cross-club data is actually returned; weak gate, overstated impact.
  - *"`getWrappedData` unauthenticated"* — accurate mechanics but it is the intentional public Wrapped-share contract (single known player+session link), not a tenancy hole.
  - *"`runEngineForSession` ungated"* — a write/integrity concern, not a data-exposure/tenancy issue.
  - *"`compute_session_wrapped`/`refresh_alltime_leaderboard` anon-executable"* — a guard already blocks the core DoS claim; not a read-tenancy issue.

*(One item outside the app layer, already known and confirmed, belongs on the fix list: `v_alltime_leaderboard_mat` is a materialized view — RLS impossible — that is not security_invoker and holds anon+authenticated SELECT, so an unauthenticated curl returns every member's name+club_id+stats. Fix it alongside #6: revoke anon/authenticated SELECT and serve the all-time board through the service role.)*

---

## 4. RECOMMENDED ORDER OF WORK

1. **Close the account-takeover chain (do these together, same PR):**
   - `profile.ts` (#1) — bind the target `userId` to the session/club in all four actions.
   - `createSession` (#2) — require and verify club membership; no silent CHILLAX fallback.
   - `joinAsCoOrganizer` (#3) — rate-limit + lockout, higher-entropy passcodes, scope the lookup.
   *(These three are the exploitable-today privilege path; #1 is the payload, #2/#3 the enablers.)*
2. **Shut off the unauthenticated data dump:** revoke `EXECUTE ... FROM PUBLIC, anon, authenticated` on `get_alltime_snapshot_before`, `get_session_leaderboard_public`, `get_player_streaks`, and revoke anon/authenticated SELECT on `v_alltime_leaderboard_mat`; route those reads through the service role in the actions (#6 + known matview). Live, no-login, today.
3. **Fix `getMatchEvents` session-binding** (#4) — one-line guard, cheap.
4. **Stop granting club membership from link views** (#5) — remove `ensureClubMembership` from the two legacy shims; restrict it to the token-validated invite/QR path. Do this **before onboarding a second club** — it is the mechanism that turns every latent cross-club finding into a live one.
5. **Harden realtime before club #2:** make `session-events` private + policy'd and strip names from payloads (#7); tighten `profiles_select` to shared-club visibility (#8, also fixes the query-level `USING(true)`).
6. **Optional / low:** the `match_players` DELETE metadata leak (#9) — defer or accept.

Items 1–3 and the matview/RPC revokes in item 2 are exploitable **today with the single CHILLAX club**. Items 4–5 are the gate that must be closed **before a second club is created**, or they become active cross-tenant breaches on day one of multi-club.

Relevant files: `/Users/miggy-onb/Downloads/badminton-app/src/app/actions/profile.ts`, `/src/app/actions/sessions.ts`, `/src/app/actions/match-events.ts`, `/src/app/actions/leaderboard.ts`, `/src/app/play/[sessionId]/page.tsx`, `/src/app/organizer/[sessionId]/page.tsx`, `/src/lib/clubs.ts`, `/src/lib/realtime.ts`, `/src/app/actions/_shared.ts`, `/src/app/actions/auth.ts`.