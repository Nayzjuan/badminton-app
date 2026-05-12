# Pending Migrations — Run in SQL Editor

## Must Execute

| File | Status | Action |
|---|---|---|
| `20260511210000_atomic_server_actions.sql` | ❌ NOT APPLIED | **Run this now** — creates 4 atomic RPCs |

## Already Applied (Verified)

| File | Status |
|---|---|
| `20260417000000_leaderboard_views.sql` | ✅ Applied |
| `20260502093938_anon_session_join_lookup.sql` | ✅ Applied |
| `20260506000000_draft_mode_bugfixes.sql` | ✅ Applied |
| `20260511000002_missing_rpcs.sql` | ✅ Applied |

## Unknown

| File | Status |
|---|---|
| `20260506020000_drop_stale_create_match_overloads.sql` | ⚠️ Cannot verify remotely |

## How to Run

1. Open Supabase Dashboard → SQL Editor
2. Click **New query**
3. Copy contents of `supabase/migrations/20260511210000_atomic_server_actions.sql`
4. Click **Run**
5. Verify: `select routine_name from information_schema.routines where routine_schema = 'public' and routine_name in ('checkout_player_cleanup_drafts','join_queue','publish_match','publish_all_drafts');`
