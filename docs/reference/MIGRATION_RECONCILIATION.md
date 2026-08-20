# Migration reconciliation — repo files vs. production stamps

Migrations in this project are applied **by hand**. Prod's ledger
(`supabase_migrations.schema_migrations`) and `supabase/migrations/` therefore carry
different name sets, and the difference is **not** drift. This document dispositions every
differing name so the next reader does not re-derive it.

To recompute the two sides:

```
ls supabase/migrations/ | sed 's/\.sql$//'
select version, name from supabase_migrations.schema_migrations order by version;
```

Compare **by name suffix**, stripping `^\d{14}_` from both sides — prod stores some rows as a
bare slug (`queue_status_audit`) and others as a full filename carrying its own timestamp
(`20260630000000_clubs_foundation`, stamped `20260630092810`).

## Why the sets differ

A migration is applied **iff the objects it creates or alters are present on production in the
asserted shape.** A matching name is not evidence of that, and a missing name is not evidence
against it. Four mechanisms produce a name that appears on one side only:

- **BOOTSTRAP_DECLARATION** — the file declares objects production *already had*, so a
  from-scratch replay converges on prod. These are never applied to prod and must not be.
  `00000000000000_initial_schema` issues bare `CREATE TYPE` with no `IF NOT EXISTS`; against
  prod it raises `42710` and aborts. The `declare_*` family and
  `create_dashboard_authored_view` are the same pattern for objects originally made through
  the Supabase dashboard.
- **APPLIED_UNDER_DIFFERENT_NAME** — the repo file was renamed *after* it was applied, so prod
  still holds the older, longer name.
- **SUPERSEDED** — an early hand-applied fix whose content a later repo file now carries in
  full, usually because that later file is a whole-body `CREATE OR REPLACE`.
- **APPLIED_THEN_REVERSED** — a stopgap applied during a live incident and later undone.

## Repo files with no matching prod stamp

| Repo file | Verdict | Resolution |
|---|---|---|
| `00000000000000_initial_schema` | BOOTSTRAP_DECLARATION | Declares the pre-migration ground-truth schema. Cannot run against prod. |
| `20260511000002_missing_rpcs` | BOOTSTRAP_DECLARATION | `elevate_to_organizer`, `rejoin_queue` — created by hand before the migration system existed; both present on prod. |
| `20260512200001_atomicize_clear_on_deck_match` | SUPERSEDED | `clear_on_deck_match_atomic` present on prod; carried by `20260512021203 fix_clear_on_deck_lock_order`. |
| `20260701000004_wrapped_ledger_club_scope_fix` | RENAMED | prod `20260701073351 compute_session_wrapped_ledger_club_scope_fix` |
| `20260701000007_backfill_orphaned_profiles_legacy` | RENAMED | prod `20260701083313 backfill_orphaned_profiles_into_legacy` |
| `20260701000011_drop_unscoped_profiles_update_organizer` | RENAMED | prod `20260701101434 drop_unscoped_profiles_update_organizer_policy` |
| `20260701000012_scope_match_players_insert` | RENAMED | prod `20260701102205 scope_match_players_insert_to_session_organizer` |
| `20260702000005_legacy_backfill_new_signups` | BOOTSTRAP_DECLARATION | One-time DML; replays as a no-op on an empty DB. |
| `20260702000006_handle_new_user_legacy_autoenroll` | APPLIED_THEN_REVERSED | Reversed by `20260705140714 primary_club_and_retire_autoenroll`. `handle_new_user` on prod records the removal. |
| `20260702000007_regrant_leaderboard_history_views_stopgap` | APPLIED_THEN_REVERSED | Reversed on prod by `20260702152731`; repo-side reversal is `20260722010001_lock_leaderboard_reads_to_service_role`. |
| `20260702000008_club_member_guard_hierarchy_recheck` | **APPLIED, NEVER STAMPED** | See "The one real gap" below. |
| `20260702000009_rename_legacy_club_to_chillax` | BOOTSTRAP_DECLARATION | `clubs` holds exactly one row, `CHILLAX`/`chillax`. |
| `20260721240000_grant_limiter_execute_to_service_role` | BOOTSTRAP_DECLARATION | `service_role` already holds EXECUTE on the three limiters. |
| `20260722000000_declare_realtime_publication_membership` | BOOTSTRAP_DECLARATION | `supabase_realtime` membership already matches the asserted set. |
| `20260722000001_create_dashboard_authored_view` | BOOTSTRAP_DECLARATION | Creates `v_recent_pairings`, present on prod. "dashboard-authored" names the object's *provenance*, not an object called "dashboard". |
| `20260722000002_declare_rls_baseline` | BOOTSTRAP_DECLARATION | Every guarded `CREATE POLICY` is a no-op; the terminal assertion passes on prod. |
| `20260722000003_declare_table_grants` | BOOTSTRAP_DECLARATION | GRANT-only capture of prod's real ACLs. It cannot subtract a privilege — that is `20260722010001`'s job. |
| `20260722000004_declare_function_execute_grants` | BOOTSTRAP_DECLARATION | Captures prod's function EXECUTE grants. |

## Prod stamps with no matching repo file

| Prod stamp | Verdict | Resolution |
|---|---|---|
| `20260417132046 leaderboard_snapshot_function` | SUPERSEDED | The 1-arg `get_alltime_snapshot_before`; prod now carries the 2-arg club-scoped form. |
| `20260418053053 add_sort_order_to_matches` | SUPERSEDED | `matches.sort_order` is declared by `00000000000000_initial_schema`. |
| `20260423131006 fix_compute_session_wrapped_array_append` | SUPERSEDED | Consolidated into `20260508000000_expand_wrapped_awards`. |
| `20260502155638 draft_mode_rls_matches_select` | SUPERSEDED | `20260701000008_club_scoped_rls` DROPs and re-CREATEs `matches_select`; final qual set by `20260717171903_rls_consolidate_access_helpers`. |
| `20260508153826 fix_wrapped_awards_uuid_max` | SUPERSEDED | Consolidated into `20260508000000_expand_wrapped_awards`. |
| `20260508154337 fix_wrapped_awards_array_append` | SUPERSEDED | Consolidated into `20260508000000_expand_wrapped_awards`. |
| `20260508154750 fix_wrapped_awards_double_trouble_scope` | SUPERSEDED | Consolidated into `20260508000000_expand_wrapped_awards`. |
| `20260701073351 compute_session_wrapped_ledger_club_scope_fix` | RENAMED | repo `20260701000004_wrapped_ledger_club_scope_fix` |
| `20260701083313 backfill_orphaned_profiles_into_legacy` | RENAMED | repo `20260701000007_backfill_orphaned_profiles_legacy` |
| `20260701101434 drop_unscoped_profiles_update_organizer_policy` | RENAMED | repo `20260701000011_drop_unscoped_profiles_update_organizer` |
| `20260701102205 scope_match_players_insert_to_session_organizer` | RENAMED | repo `20260701000012_scope_match_players_insert` |
| `20260702152731 revoke_leaderboard_history_view_grants_post_cutover` | SUPERSEDED | Named explicitly in `20260722010001_lock_leaderboard_reads_to_service_role`, which is its repo-side equivalent. |

## The one real gap

`20260702000008_club_member_guard_hierarchy_recheck` **is applied to production but carries no
row in `schema_migrations`.** It was hand-applied outside the ledger. Verify:

```sql
select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       (p.prosrc like '%role_changed%') as has_recheck
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('club_member_deactivate','club_member_set_role');
```

Both come back with `p_expected_role` in the signature and `has_recheck = true`, and
`grep -l p_expected_role supabase/migrations/*.sql` returns only this file — no other migration
can produce that parameter, so it is a unique fingerprint. The app half is deployed too
(`clubs.ts` passes `p_expected_role` at the `club_member_deactivate` and `club_member_set_role`
call sites), which is independent confirmation: were the DDL absent, member removal and role
changes would fail in production.

Re-applying it is safe — every statement is `DROP … IF EXISTS` plus `CREATE` — but the missing
row means `list_migrations` under-reports. Inserting the stamp is a production write and needs
a human decision.

The dangerous reading is not "unapplied" but "dead code". Deleting this file would **not** trip
the `functionExists` checks in Suite G: `20260702000000` and `20260702000001` already create both
functions, so the names survive a delete and only the arity and the body change. Suite G's
"the club-member guards still carry the hierarchy recheck" pins the post-fix `regprocedure`
signatures and asserts `role_changed` and `pg_advisory_xact_lock` are still in both bodies —
verified by restoring the pre-fix definitions on a local database and watching it fail.

## Verification is mechanical, not documentary

`tests/integration/schema-parity.test.ts` (Suite G) re-derives these invariants from the catalog
on every `supabase db reset` — function existence, the leaderboard read lockdown, service_role
EXECUTE coverage, the live-swap RPC signatures, and the club-member guard shape. That suite, not
this table, is the gate. This table exists so a future reader does not mistake a name difference
for drift.

🪤 A from-scratch replay is not continuously equal to production — only equal at the end. The
`compute_session_wrapped` body installed at `20260423100000` carries the PG17-broken
`v_awards || 'literal'` form and only converges at `20260508000000`. Nothing calls it in between,
so this is a replay-ordering note, not a defect.
