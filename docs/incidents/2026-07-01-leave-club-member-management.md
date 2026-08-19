# 11.3 Leave-club / member-management (2026-07-01)

> Extracted from `APP_MANIFEST.md` §11.3 on 2026-08-19. This is a **dated incident
> write-up**, not current-state documentation. The behaviour it describes may have
> been superseded; `src/` and `src/types/database.ts` are the authority.


**Permission model.** `src/app/actions/clubs.ts` gains `leaveClub`, `removeMember`, `restoreMember`,
`changeMemberRole` (`MemberActionResult = { success: boolean; message?: string }`):
- `removeMember`/`restoreMember`: actor must be `owner` OR `admin`; both reject self-action ("Use the Leave
  club option to remove yourself"); both gate via `canManageTarget(actorRole, targetRole)` — admins may only
  manage plain members, never another admin or the owner. `removeMember` additionally blocks removing the
  club's only owner via the atomic `club_member_deactivate` RPC (see below). `restoreMember` intentionally mirrors `removeMember`'s
  permission shape (an admin-visible "Restore" control on a removed plain member is correct by design, not a
  bug).
- `changeMemberRole`: strictly `owner`-only; the same last-active-owner guard applies to demotions of the
  sole owner.
- `leaveClub`: self-service, any role; blocked with "You're the only owner — promote someone else to owner
  before leaving" when the caller is the club's sole active owner.

**UI.** `src/components/clubs/club-admin-panel.tsx` (admin/owner panel: role `<select>` + remove/restore
per-row, hidden for the actor's own row and for rows the actor can't manage) and
`src/components/clubs/club-list.tsx` (`/clubs` roster: inline Leave with a Yes/No confirm, not a modal).

**Live-verified end-to-end in prod** (fixture club `qa-member-test-club`, three real anonymous PIN accounts —
QA Owner/Admin/Member Test): admin blocked from acting on the owner and on itself; admin remove→restore cycle
on a plain member; owner promote→demote of an admin via `changeMemberRole`; owner's own row shows no manage
controls; owner's self-leave correctly rejected (sole-owner guard); member's genuine self-service leave
succeeds. All fixtures (profiles, `auth.users`, `club_members`, `club_invites`, the test club) deleted after
verification.

**`migrate_player_identity` — two more FK gaps found and fixed via live-testing this feature.** Every time a
new multi-tenant table gets a FK to `profiles.id`, it must be retrofitted into this function's non-fatal
repoint blocks, or the function's final `DELETE FROM profiles WHERE id = p_old_user_id` hard-fails on
reconnect for any player who touched that table. Found two more instances (beyond the pre-existing
`matches`/`match_players`/rivalries/partnerships coverage):
- `club_invites.created_by` / `club_invites.consumed_by` — surfaced when reconnecting as an admin who had
  redeemed a club invite. Fixed by migration `20260701000016_migrate_identity_club_invites.sql`.
- `clubs.created_by` / `club_members.invited_by` — surfaced when reconnecting as the club's original creator
  (`clubs_created_by_fkey` violation). `club_members.invited_by` was found via a full audit (query
  `information_schema.table_constraints`/`key_column_usage`/`constraint_column_usage` filtered to
  `ccu.table_name = 'profiles' AND ccu.column_name = 'id'`, enumerating all 14 FK columns referencing
  `profiles(id)`) rather than triggered live, but is the same bug class. Fixed by migration
  `20260701000017_migrate_identity_clubs_invited_by.sql`.
Both columns are blind two-row `UPDATE ... WHERE col = p_old_user_id` (safe: neither carries a uniqueness
constraint, unlike `club_members.player_id`/rivalries/partnerships which need merge-then-dedupe). Both
migrations applied to prod and live-verified (reconnect succeeds; old profile deleted; FK columns correctly
repointed to the new profile id).

**Two small hardening fixes found by an automated review pass on this feature:**
- `acceptClubInvite` (`src/app/actions/clubs.ts`) now captures and logs the error result of the invite-consume
  `UPDATE` instead of firing-and-forgetting it — purely additive observability, no behavior change (membership
  is already granted earlier in the function, so a consume failure stays non-fatal by design).
- `getMyClubs` (`src/lib/clubs.ts`) had an N+1 query — one `sessions` active-count query per club. Replaced with
  a single batched `sessions.club_id` query grouped in-memory into a `Map<clubId, count>`, run in parallel with
  the `clubs` query. Live-verified with 2 clubs under one profile (one with 0 sessions, one with 2) to prove the
  `Map` groups by `club_id` correctly rather than summing globally — `/clubs` showed no badge on the 0-session
  club and "2 live" on the other.
A third flagged item — `removeMember`'s admin-panel local-state update being "optimistic" — was investigated and
found to be a false positive: `club-admin-panel.tsx`'s `handleRemove` only updates local state inside
`if (result.success)`, strictly after the server action resolves.

**Both follow-ups from this feature's initial ship are now fixed (2026-07-02):**
- **`revalidatePath` scope gap** — `leaveClub` now takes a `clubSlug` param (threaded from `club-list.tsx`'s
  `club.slug`) and revalidates `/c/${clubSlug}` (layout) and `/c/${clubSlug}/admin` in addition to `/clubs`,
  matching the scope already used by `removeMember`/`restoreMember`/`changeMemberRole`.
- **`countActiveOwners` TOCTOU race** — the check-then-act pattern (`countActiveOwners(clubId) <= 1` SELECT,
  then a separate UPDATE) let two concurrent last-owner actions both pass the guard and leave a club with zero
  active owners. Fixed with migration `20260702000000_club_member_atomic_owner_guard.sql`, which adds two
  `SECURITY DEFINER` RPCs: `club_member_deactivate(p_club_id, p_member_id)` and
  `club_member_set_role(p_club_id, p_member_id, p_new_role)`. Both take `pg_advisory_xact_lock(hashtextextended(p_club_id::text, 0))`
  before checking + mutating in one transaction, so any concurrent call touching the same `club_id` fully
  serializes. Both return `jsonb` (`{success, reason}`, reasons: `ok` / `not_found` / `only_owner` /
  `invalid_role` / `no_change`) — matching this schema's existing `jsonb`-returning atomic-RPC convention
  (`join_queue`, `publish_match`, etc.) rather than `RETURNS TABLE`. `leaveClub`, `removeMember`,
  `changeMemberRole` now call these RPCs instead of the old check-then-UPDATE; `restoreMember` is untouched
  (reactivating a member can never reduce the owner count, so it stays an unguarded direct UPDATE). The
  now-fully-dead `countActiveOwners` export was removed from `src/lib/clubs.ts`.
  - **Grant-lockdown gotcha (found live, in prod, via `get_advisors` + a `pg_proc.proacl` ground-truth
    check — NOT caught by the code-review agent, which only read the migration's SQL text):**
    `REVOKE ALL ON FUNCTION ... FROM PUBLIC` + `GRANT EXECUTE ... TO service_role` is **not sufficient** to
    lock a function to `service_role`-only in this project. This Supabase project's schema-level default
    privileges auto-grant `EXECUTE` directly to `anon` and `authenticated` (in addition to `service_role`) on
    every newly created function in `public` — a grant that is independent of, and NOT retracted by,
    `REVOKE ... FROM PUBLIC` (that only revokes the implicit `PUBLIC` pseudo-role grant, not separate named-role
    grants). The original migration left both RPCs callable directly by `anon`/`authenticated` via
    `/rest/v1/rpc/<fn>` for a short window in prod — a real privilege-escalation hole, since these functions
    are `SECURITY DEFINER`, bypass RLS, and do zero actor-authorization checks internally. Fixed immediately
    with a corrective migration, `20260702000001_club_member_atomic_owner_guard_lockdown.sql`:
    `REVOKE EXECUTE ON FUNCTION ... FROM anon, authenticated;` (explicit, named-role revoke) for both
    functions. Re-verified via `pg_proc.proacl`: both now show only `postgres`/`service_role`. **Rule for any
    future service_role-only function in this schema: always follow `REVOKE ALL FROM PUBLIC` with an explicit
    `REVOKE EXECUTE ... FROM anon, authenticated` — the PUBLIC revoke alone is not enough.** (Also: `get_advisors`
    security-lint coverage for this class of issue is incomplete — it didn't flag the pre-existing
    `migrate_player_identity`, which has the same anon/authenticated exposure in its `proacl`; ground-truth
    `pg_proc.proacl` queries are the reliable check, not the advisor alone.)
  - **Functional live-verification (disposable fixtures, zero residue after)**: a 3-member fixture club (2
    owners + 1 plain member) proved all branches — `not_found` (bogus member id), `invalid_role` (bogus role
    string), `no_change` (role set to its current value), a normal deactivate and a normal demote both
    succeeding while ≥2 owners exist, both `club_member_deactivate` and `club_member_set_role` correctly
    returning `only_owner` once only one owner remained, and — after promoting a second owner back — both
    operations succeeding again. Confirms the advisory-lock guard behaves correctly across the full state
    space, not just the happy path.
  - **Pre-existing, out-of-scope finding (not fixed this pass):** `migrate_player_identity` is exposed to
    `anon`/`authenticated` in `pg_proc.proacl` (same class of issue as above) — but it turns out to be
    `SECURITY INVOKER`, not `SECURITY DEFINER` as previously assumed, so the RLS-bypass severity is lower
    (it runs with the caller's own privileges, not the definer's). Worth auditing separately; left untouched
    here since it's out of scope for the owner-guard fix.

