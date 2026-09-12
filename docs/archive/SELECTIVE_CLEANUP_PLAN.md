# Selective Data Cleanup Plan
## Goal: Keep Only "Chillax Thursday 4/23" — Remove Test Sessions & Orphaned Users

> **Status: DRAFT — DO NOT EXECUTE without explicit approval**
>
> No SQL has been executed. This document is purely analytical.
> All SQL blocks are labelled with their phase and must be run **in order**.

> ⚠️ **CRITICAL DISCOVERY — Phase 0 already run (read-only)**
>
> Three Chillax players (Miggy, Jake L, Kevin DC) used the **PIN reconnect** feature after the
> 2026-04-24 backup was taken. The `migrate_player_identity` function deleted their original
> profile IDs and replaced them with new anonymous-auth UUIDs. Their Chillax match_players
> records were already migrated to the new IDs in the live DB.
>
> **The original backup IDs no longer exist.** The allowlists below have been corrected to use
> the live reconnected IDs. Using the backup IDs as-is would have left those 3 accounts
> unprotected and deleted their Chillax match history.

---

## What We're Doing

| Keep | Remove |
|------|--------|
| Session "Chillax Thursday 4/23" (`d820efea-d3ff-4ca3-9c0a-6a76de6090dc`) | Session "Sim Night" |
| Its 18 players and their auth accounts | Session "E2E DO NOT JOIN" |
| Its 24 matches (20 completed + 4 cancelled) as of the 2026-04-24 backup | Any 4th mystery session |
| Its 2 courts, 17 queue entries, 17 wrapped stats | Any matches added to Chillax after the backup date |
| | All profiles + auth.users that belong ONLY to removed sessions |

---

## Why the Backup File is Useful (but Not the Full Solution)

`backups/backup_2026-04-24.sql` contains exactly the data we want to end up with:
- **18 exact profile IDs** to keep (our allowlist)
- **24 exact match IDs** to keep (our match allowlist)
- **2 court IDs**, **17 queue_entry IDs**, **17 wrapped_stat IDs** to keep

The backup uses `INSERT ... ON CONFLICT DO UPDATE` — it is a **restore script**, not a delete script. We will use it as a **reference** (the allowlists below) and as an **emergency restore** if anything goes wrong.

**Critical limitation**: The backup does NOT include `auth.users` rows. Deleting a Chillax profile's `auth.users` entry would permanently lock that player out of the app with no recovery. The plan therefore **never touches** the 18 Chillax profile IDs.

**ID discrepancy — 3 profiles differ from backup**: three members reconnected after the backup using their PINs. The reconnect flow deleted their original profile IDs and created new ones. The allowlists in this plan use the **live IDs** (confirmed from the DB), not the stale backup IDs. These 3 IDs are marked with ⚠️ in the allowlist below.

---

## FK Dependency Map (The Delete Order)

```
auth.users  ←──────────────────────────────────────────────┐
    │                                                        │
    │ ON DELETE CASCADE                                      │
    ▼                                                        │
public.profiles ─── ON DELETE NO ACTION ──► public.sessions │
    │                                             │           │
    │ CASCADE                                     │ CASCADE   │
    ├──► queue_entries                            ├──► courts │
    ├──► match_players                            ├──► matches ──► match_players (CASCADE)
    ├──► session_organizers                       │           └──► match_games  (CASCADE)
    ├──► session_wrapped_stats                    ├──► queue_entries
    └──► push_subscriptions                       ├──► session_organizers
                                                  └──► session_wrapped_stats
```

### The critical constraint

`sessions.created_by → profiles.id` is **`ON DELETE NO ACTION`**.

**Rule:** Sessions must be deleted **before** their `created_by` profile is deleted. We satisfy this by deleting unwanted sessions in Phase 2, then deleting orphaned profiles in Phase 4.

---

## The 18 Profile IDs to Preserve (from backup — DO NOT DELETE)

```
15612a9e-0433-41de-8ac7-42bfaf782e24  -- member 01
364d415b-9c73-4cbf-954b-893a30296d5d  -- member 02 ⚠️ reconnected (was 55c8d569 in backup)
fea2e4ea-3abc-4d61-acc0-5ca21eeffd50  -- member 03
05ea8e14-e80d-40d4-bb85-aead6c419eeb  -- member 04
5dc98804-5f48-4b3f-ac0b-5f108626f096  -- member 05
2b97e4c1-8712-4c40-8428-924a7231c4d9  -- member 06
58e747c7-feb9-458d-94a4-ad1636786691  -- member 07
e98a31a5-ef68-4847-9428-496b9f6bf312  -- member 08
3d17ccd0-5bf9-4f5b-ae1a-37f92afd3144  -- member 09
12a7f748-807a-434c-99f9-fae1a0f30b0f  -- member 10
b261fa1d-6a71-4208-b177-888837bc8bb8  -- member 11
79b7fd76-bfec-464b-a606-2ef3f1d38e99  -- member 12
ae503f1f-72be-4549-9621-7a823854cb12  -- member 13 (original)
4f24c673-1415-4aa0-8727-52af23913112  -- member 14
b162ac12-5c99-4f8d-a7d1-3e9654ee5a54  -- member 15
37af82bf-e92b-471f-add9-cb19fa4c5d2d  -- member 16 (reconnect)
5d28d32f-32bf-4826-a5e0-43f5bc306fdc  -- member 17 (organizer/DEV) ⚠️ reconnected (was 99292c53 in backup)
91cb6052-df0e-4540-9fc6-835225987f1f  -- member 18 ⚠️ reconnected (was 076cb21c in backup)
```

## The 24 Match IDs to Preserve (from backup — Chillax only)

```
72cd268a-e265-4ed7-8d8c-30c71d58ab8b   96cb92ff-08d6-448c-aded-81432c0b757b
f247df5b-1c41-40c5-827e-82ffac3c717c   f66acfda-9b25-4a6c-8093-846e9baaf3a6
5113de4c-001d-4b3f-b5ac-0f8c766a688d   ff7c9ec6-c139-4845-b49a-6b9d901b8976
c43f32b1-7324-48cd-acd8-055abf6a63ff   4ea3dac9-206c-4ef9-9404-0083ad924a91
5e156865-daf1-4d43-a486-e65871d871e5   e481a0af-fce1-4d8b-8083-7f52f9b381c2
5ba410e5-90d3-497e-85b9-2036da14c3da   21d78f99-83bc-423a-ae48-b1a040e6f07a
2707985c-3886-4c04-8ad8-b9fad779dde8   031bc8a1-d203-4771-aa26-c8575e7e3316
17fddb71-ce3f-4cf3-87d0-9a8016877613   c836b40d-e262-474e-8d0d-b93f3810e6ad
dbfa5cc3-168b-4d23-90df-85e7cbebe8c3   51a692c5-039a-4eef-84d6-231ca91fcf94
1202fca6-65f7-4401-892f-d935788cd71d   32fdde89-af76-4933-95dc-e9a4021f09b2
bafaf451-af73-45b6-bf21-20831ed48c3d   12431f96-e8ef-4b6f-b135-8d9e68802b2e
c32b0a9b-fafc-46fb-8191-0b0227e2d6fa   7ae8e45e-fe11-42ca-a728-f68e6f8400ac
```

---

## Phase 0 — Discovery (READ-ONLY, Run First)

Run these queries to confirm session IDs and understand what will be deleted before writing a single DELETE.

```sql
-- ── 0A: See all sessions ──────────────────────────────────────
SELECT id, name, is_active, created_at, ended_at
FROM public.sessions
ORDER BY created_at;
-- Expected: 4 rows. Chillax = d820efea. Note the IDs for Sim Night and E2E.

-- ── 0B: Row counts per session across all child tables ────────
SELECT
  s.name                                AS session_name,
  s.id                                  AS session_id,
  COUNT(DISTINCT c.id)                  AS courts,
  COUNT(DISTINCT q.id)                  AS queue_entries,
  COUNT(DISTINCT m.id)                  AS matches,
  COUNT(DISTINCT mp.id)                 AS match_players,
  COUNT(DISTINCT so.id)                 AS session_organizers,
  COUNT(DISTINCT ws.id)                 AS wrapped_stats
FROM public.sessions s
LEFT JOIN public.courts c             ON c.session_id = s.id
LEFT JOIN public.queue_entries q      ON q.session_id = s.id
LEFT JOIN public.matches m            ON m.session_id = s.id
LEFT JOIN public.match_players mp     ON mp.match_id = m.id
LEFT JOIN public.session_organizers so ON so.session_id = s.id
LEFT JOIN public.session_wrapped_stats ws ON ws.session_id = s.id
GROUP BY s.id, s.name
ORDER BY s.created_at;

-- ── 0C: Profile count — total vs. Chillax-only ───────────────
SELECT
  COUNT(*)                                              AS total_profiles,
  COUNT(*) FILTER (WHERE id IN (
    '15612a9e-0433-41de-8ac7-42bfaf782e24',
    '364d415b-9c73-4cbf-954b-893a30296d5d',
    'fea2e4ea-3abc-4d61-acc0-5ca21eeffd50',
    '05ea8e14-e80d-40d4-bb85-aead6c419eeb',
    '5dc98804-5f48-4b3f-ac0b-5f108626f096',
    '2b97e4c1-8712-4c40-8428-924a7231c4d9',
    '58e747c7-feb9-458d-94a4-ad1636786691',
    'e98a31a5-ef68-4847-9428-496b9f6bf312',
    '3d17ccd0-5bf9-4f5b-ae1a-37f92afd3144',
    '12a7f748-807a-434c-99f9-fae1a0f30b0f',
    'b261fa1d-6a71-4208-b177-888837bc8bb8',
    '79b7fd76-bfec-464b-a606-2ef3f1d38e99',
    'ae503f1f-72be-4549-9621-7a823854cb12',
    '4f24c673-1415-4aa0-8727-52af23913112',
    'b162ac12-5c99-4f8d-a7d1-3e9654ee5a54',
    '37af82bf-e92b-471f-add9-cb19fa4c5d2d',
    '5d28d32f-32bf-4826-a5e0-43f5bc306fdc',
    '91cb6052-df0e-4540-9fc6-835225987f1f'
  ))                                                    AS chillax_profiles,
  COUNT(*) FILTER (WHERE id NOT IN (
    '15612a9e-0433-41de-8ac7-42bfaf782e24',
    '364d415b-9c73-4cbf-954b-893a30296d5d',
    'fea2e4ea-3abc-4d61-acc0-5ca21eeffd50',
    '05ea8e14-e80d-40d4-bb85-aead6c419eeb',
    '5dc98804-5f48-4b3f-ac0b-5f108626f096',
    '2b97e4c1-8712-4c40-8428-924a7231c4d9',
    '58e747c7-feb9-458d-94a4-ad1636786691',
    'e98a31a5-ef68-4847-9428-496b9f6bf312',
    '3d17ccd0-5bf9-4f5b-ae1a-37f92afd3144',
    '12a7f748-807a-434c-99f9-fae1a0f30b0f',
    'b261fa1d-6a71-4208-b177-888837bc8bb8',
    '79b7fd76-bfec-464b-a606-2ef3f1d38e99',
    'ae503f1f-72be-4549-9621-7a823854cb12',
    '4f24c673-1415-4aa0-8727-52af23913112',
    'b162ac12-5c99-4f8d-a7d1-3e9654ee5a54',
    '37af82bf-e92b-471f-add9-cb19fa4c5d2d',
    '5d28d32f-32bf-4826-a5e0-43f5bc306fdc',
    '91cb6052-df0e-4540-9fc6-835225987f1f'
  ))                                                    AS to_be_deleted
FROM public.profiles;

-- ── 0D: Preview the profiles that WILL be deleted ────────────
SELECT id, display_name, skill_level, created_at
FROM public.profiles
WHERE id NOT IN (
  '15612a9e-0433-41de-8ac7-42bfaf782e24',
  '364d415b-9c73-4cbf-954b-893a30296d5d',
  'fea2e4ea-3abc-4d61-acc0-5ca21eeffd50',
  '05ea8e14-e80d-40d4-bb85-aead6c419eeb',
  '5dc98804-5f48-4b3f-ac0b-5f108626f096',
  '2b97e4c1-8712-4c40-8428-924a7231c4d9',
  '58e747c7-feb9-458d-94a4-ad1636786691',
  'e98a31a5-ef68-4847-9428-496b9f6bf312',
  '3d17ccd0-5bf9-4f5b-ae1a-37f92afd3144',
  '12a7f748-807a-434c-99f9-fae1a0f30b0f',
  'b261fa1d-6a71-4208-b177-888837bc8bb8',
  '79b7fd76-bfec-464b-a606-2ef3f1d38e99',
  'ae503f1f-72be-4549-9621-7a823854cb12',
  '4f24c673-1415-4aa0-8727-52af23913112',
  'b162ac12-5c99-4f8d-a7d1-3e9654ee5a54',
  '37af82bf-e92b-471f-add9-cb19fa4c5d2d',
  '5d28d32f-32bf-4826-a5e0-43f5bc306fdc',
  '91cb6052-df0e-4540-9fc6-835225987f1f'
)
ORDER BY created_at;
-- Review this list carefully. These are all accounts that will be removed.

-- ── 0E: Safety check — any Chillax profile used as created_by
--        in the unwanted sessions? (must = 0)
SELECT s.name, s.created_by, p.display_name
FROM public.sessions s
JOIN public.profiles p ON p.id = s.created_by
WHERE s.id != 'd820efea-d3ff-4ca3-9c0a-6a76de6090dc'  -- NOT Chillax
  AND s.created_by IN (
  '15612a9e-0433-41de-8ac7-42bfaf782e24',
  '364d415b-9c73-4cbf-954b-893a30296d5d',
  'fea2e4ea-3abc-4d61-acc0-5ca21eeffd50',
  '05ea8e14-e80d-40d4-bb85-aead6c419eeb',
  '5dc98804-5f48-4b3f-ac0b-5f108626f096',
  '2b97e4c1-8712-4c40-8428-924a7231c4d9',
  '58e747c7-feb9-458d-94a4-ad1636786691',
  'e98a31a5-ef68-4847-9428-496b9f6bf312',
  '3d17ccd0-5bf9-4f5b-ae1a-37f92afd3144',
  '12a7f748-807a-434c-99f9-fae1a0f30b0f',
  'b261fa1d-6a71-4208-b177-888837bc8bb8',
  '79b7fd76-bfec-464b-a606-2ef3f1d38e99',
  'ae503f1f-72be-4549-9621-7a823854cb12',
  '4f24c673-1415-4aa0-8727-52af23913112',
  'b162ac12-5c99-4f8d-a7d1-3e9654ee5a54',
  '37af82bf-e92b-471f-add9-cb19fa4c5d2d',
  '5d28d32f-32bf-4826-a5e0-43f5bc306fdc',
  '91cb6052-df0e-4540-9fc6-835225987f1f'
);
-- If this returns any rows, we need to handle those sessions specially
-- before deleting them. Expected: 0 rows.

-- ── 0F: Any Chillax matches beyond the backup's 24? ──────────
SELECT id, status, created_at, team_a_score, team_b_score
FROM public.matches
WHERE session_id = 'd820efea-d3ff-4ca3-9c0a-6a76de6090dc'
  AND id NOT IN (
  '72cd268a-e265-4ed7-8d8c-30c71d58ab8b',
  '96cb92ff-08d6-448c-aded-81432c0b757b',
  'f247df5b-1c41-40c5-827e-82ffac3c717c',
  'f66acfda-9b25-4a6c-8093-846e9baaf3a6',
  '5113de4c-001d-4b3f-b5ac-0f8c766a688d',
  'ff7c9ec6-c139-4845-b49a-6b9d901b8976',
  'c43f32b1-7324-48cd-acd8-055abf6a63ff',
  '4ea3dac9-206c-4ef9-9404-0083ad924a91',
  '5e156865-daf1-4d43-a486-e65871d871e5',
  'e481a0af-fce1-4d8b-8083-7f52f9b381c2',
  '5ba410e5-90d3-497e-85b9-2036da14c3da',
  '21d78f99-83bc-423a-ae48-b1a040e6f07a',
  '2707985c-3886-4c04-8ad8-b9fad779dde8',
  '031bc8a1-d203-4771-aa26-c8575e7e3316',
  '17fddb71-ce3f-4cf3-87d0-9a8016877613',
  'c836b40d-e262-474e-8d0d-b93f3810e6ad',
  'dbfa5cc3-168b-4d23-90df-85e7cbebe8c3',
  '51a692c5-039a-4eef-84d6-231ca91fcf94',
  '1202fca6-65f7-4401-892f-d935788cd71d',
  '32fdde89-af76-4933-95dc-e9a4021f09b2',
  'bafaf451-af73-45b6-bf21-20831ed48c3d',
  '12431f96-e8ef-4b6f-b135-8d9e68802b2e',
  'c32b0a9b-fafc-46fb-8191-0b0227e2d6fa',
  '7ae8e45e-fe11-42ca-a728-f68e6f8400ac'
);
-- If this returns rows, they're "extra" Chillax matches added after the
-- backup. Phase 3 will delete them.
```

**Stop here.** Review the output of all 6 queries above before continuing.

---

## Phase 1 — Wrap Everything in a Transaction

All destructive phases below run inside a single `BEGIN / COMMIT` block.
If any step fails, the whole thing rolls back — nothing is partially deleted.

```sql
BEGIN;
```

> ⚠️ Everything from here to `COMMIT` in Phase 6 is one atomic transaction.

---

## Phase 2 — Delete Unwanted Sessions (and Their Cascading Children)

Replace `'<SIM_NIGHT_SESSION_ID>'` and `'<E2E_SESSION_ID>'` with the actual IDs
from Phase 0A. If there is a 4th unknown session, add it to the list.

When a session row is deleted, Postgres **automatically cascades** to:
- `courts` → (closed, no further cascade needed)
- `matches` → `match_players` → (cascade) + `match_games` → (cascade)
- `queue_entries`
- `session_organizers`
- `session_wrapped_stats`

```sql
-- ── 2A: Delete the unwanted sessions (CASCADE handles children) ──
DELETE FROM public.sessions
WHERE id IN (
  '70358ca6-176a-46db-ba60-b3dcbb1ac6c5',  -- Sim Night — 16P / 2 Courts (confirmed Phase 0A)
  '25baf625-ef5d-4b98-8a7f-43542b849ad7'   -- 🤖 E2E SANDBOX — DO NOT JOIN (confirmed Phase 0A)
)
AND id != 'd820efea-d3ff-4ca3-9c0a-6a76de6090dc';  -- safety guard — never touches Chillax

-- Verify: should return 0 rows for each deleted session
SELECT id, name FROM public.sessions
WHERE id NOT IN (
  'd820efea-d3ff-4ca3-9c0a-6a76de6090dc'
);
-- Expected: 0 rows (only Chillax remains)
```

---

## Phase 3 — Delete Extra Chillax Matches (if Phase 0F found any)

Skip this phase entirely if Phase 0F returned 0 rows.

If there were extra matches added to the Chillax session after the backup,
delete them now. Their `match_players` and `match_games` cascade automatically.

```sql
-- ── 3A: Delete post-backup Chillax matches (skip if 0F was empty) ──
DELETE FROM public.matches
WHERE session_id = 'd820efea-d3ff-4ca3-9c0a-6a76de6090dc'
  AND id NOT IN (
  '72cd268a-e265-4ed7-8d8c-30c71d58ab8b',
  '96cb92ff-08d6-448c-aded-81432c0b757b',
  'f247df5b-1c41-40c5-827e-82ffac3c717c',
  'f66acfda-9b25-4a6c-8093-846e9baaf3a6',
  '5113de4c-001d-4b3f-b5ac-0f8c766a688d',
  'ff7c9ec6-c139-4845-b49a-6b9d901b8976',
  'c43f32b1-7324-48cd-acd8-055abf6a63ff',
  '4ea3dac9-206c-4ef9-9404-0083ad924a91',
  '5e156865-daf1-4d43-a486-e65871d871e5',
  'e481a0af-fce1-4d8b-8083-7f52f9b381c2',
  '5ba410e5-90d3-497e-85b9-2036da14c3da',
  '21d78f99-83bc-423a-ae48-b1a040e6f07a',
  '2707985c-3886-4c04-8ad8-b9fad779dde8',
  '031bc8a1-d203-4771-aa26-c8575e7e3316',
  '17fddb71-ce3f-4cf3-87d0-9a8016877613',
  'c836b40d-e262-474e-8d0d-b93f3810e6ad',
  'dbfa5cc3-168b-4d23-90df-85e7cbebe8c3',
  '51a692c5-039a-4eef-84d6-231ca91fcf94',
  '1202fca6-65f7-4401-892f-d935788cd71d',
  '32fdde89-af76-4933-95dc-e9a4021f09b2',
  'bafaf451-af73-45b6-bf21-20831ed48c3d',
  '12431f96-e8ef-4b6f-b135-8d9e68802b2e',
  'c32b0a9b-fafc-46fb-8191-0b0227e2d6fa',
  '7ae8e45e-fe11-42ca-a728-f68e6f8400ac'
);

-- Verify: Chillax should have exactly 24 matches now
SELECT COUNT(*) AS chillax_match_count
FROM public.matches
WHERE session_id = 'd820efea-d3ff-4ca3-9c0a-6a76de6090dc';
-- Expected: 24
```

---

## Phase 4 — Delete Orphaned Profiles & Auth Users

At this point, all unwanted sessions are gone. The `NO ACTION` constraint on
`sessions.created_by` is now satisfied for any profile we delete.

We delete from `auth.users` using the **same IDs** as the profiles (they share UUIDs
in Supabase's anonymous auth model). The `ON DELETE CASCADE` from `auth.users → profiles`
will automatically remove the profile rows too — we do not need a separate `DELETE FROM profiles`.

```sql
-- ── 4A: Preview (safety check — should match Phase 0D output) ────
SELECT id, display_name FROM public.profiles
WHERE id NOT IN (
  '15612a9e-0433-41de-8ac7-42bfaf782e24',
  '364d415b-9c73-4cbf-954b-893a30296d5d',
  'fea2e4ea-3abc-4d61-acc0-5ca21eeffd50',
  '05ea8e14-e80d-40d4-bb85-aead6c419eeb',
  '5dc98804-5f48-4b3f-ac0b-5f108626f096',
  '2b97e4c1-8712-4c40-8428-924a7231c4d9',
  '58e747c7-feb9-458d-94a4-ad1636786691',
  'e98a31a5-ef68-4847-9428-496b9f6bf312',
  '3d17ccd0-5bf9-4f5b-ae1a-37f92afd3144',
  '12a7f748-807a-434c-99f9-fae1a0f30b0f',
  'b261fa1d-6a71-4208-b177-888837bc8bb8',
  '79b7fd76-bfec-464b-a606-2ef3f1d38e99',
  'ae503f1f-72be-4549-9621-7a823854cb12',
  '4f24c673-1415-4aa0-8727-52af23913112',
  'b162ac12-5c99-4f8d-a7d1-3e9654ee5a54',
  '37af82bf-e92b-471f-add9-cb19fa4c5d2d',
  '5d28d32f-32bf-4826-a5e0-43f5bc306fdc',
  '91cb6052-df0e-4540-9fc6-835225987f1f'
);
-- Confirm this is only test/sim users before proceeding to 4B.

-- ── 4B: Delete orphaned auth users (cascades to profiles) ────
-- ⚠️  REQUIRES postgres (superuser) role — run in Supabase SQL Editor
DELETE FROM auth.users
WHERE id NOT IN (
  '15612a9e-0433-41de-8ac7-42bfaf782e24',
  '364d415b-9c73-4cbf-954b-893a30296d5d',
  'fea2e4ea-3abc-4d61-acc0-5ca21eeffd50',
  '05ea8e14-e80d-40d4-bb85-aead6c419eeb',
  '5dc98804-5f48-4b3f-ac0b-5f108626f096',
  '2b97e4c1-8712-4c40-8428-924a7231c4d9',
  '58e747c7-feb9-458d-94a4-ad1636786691',
  'e98a31a5-ef68-4847-9428-496b9f6bf312',
  '3d17ccd0-5bf9-4f5b-ae1a-37f92afd3144',
  '12a7f748-807a-434c-99f9-fae1a0f30b0f',
  'b261fa1d-6a71-4208-b177-888837bc8bb8',
  '79b7fd76-bfec-464b-a606-2ef3f1d38e99',
  'ae503f1f-72be-4549-9621-7a823854cb12',
  '4f24c673-1415-4aa0-8727-52af23913112',
  'b162ac12-5c99-4f8d-a7d1-3e9654ee5a54',
  '37af82bf-e92b-471f-add9-cb19fa4c5d2d',
  '5d28d32f-32bf-4826-a5e0-43f5bc306fdc',
  '91cb6052-df0e-4540-9fc6-835225987f1f'
);
-- This cascades to public.profiles automatically.
```

---

## Phase 5 — Clean Up push_subscriptions (if needed)

`push_subscriptions` cascades from `profiles`. After Phase 4, any push
subscription for a deleted profile is already gone. However, if any Chillax
users had push subscriptions tied to a device they no longer use, those
can stay — they won't cause any harm.

No action needed unless you want to review them:

```sql
-- Optional review only — do not delete:
SELECT ps.id, p.display_name, ps.created_at
FROM public.push_subscriptions ps
JOIN public.profiles p ON p.id = ps.user_id
ORDER BY ps.created_at;
```

---

## Phase 6 — Commit & Refresh Materialized View

```sql
COMMIT;
-- All deletions are now permanent.

-- ── Refresh the all-time leaderboard materialized view ───────
-- This is safe to run outside the transaction. It recomputes
-- the view from the now-clean data.
REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_alltime_leaderboard_mat;
```

> **Note**: `REFRESH MATERIALIZED VIEW CONCURRENTLY` requires the unique index
> `idx_alltime_leaderboard_player_id` to exist (added by the leaderboard migration). 
> If it fails, use `REFRESH MATERIALIZED VIEW public.v_alltime_leaderboard_mat;` instead
> (briefly blocks reads, but safe).

---

## Phase 7 — Verification (Run After COMMIT)

These queries confirm the database matches the backup exactly.

```sql
-- ── 7A: Session count — must be 1 ────────────────────────────
SELECT id, name, is_active FROM public.sessions;
-- Expected: 1 row (Chillax Thursday 4/23)

-- ── 7B: Full row-count audit ──────────────────────────────────
SELECT 'auth.users'               AS tbl, COUNT(*) AS rows FROM auth.users
UNION ALL SELECT 'profiles',                 COUNT(*) FROM public.profiles
UNION ALL SELECT 'sessions',                COUNT(*) FROM public.sessions
UNION ALL SELECT 'courts',                  COUNT(*) FROM public.courts
UNION ALL SELECT 'queue_entries',           COUNT(*) FROM public.queue_entries
UNION ALL SELECT 'matches',                 COUNT(*) FROM public.matches
UNION ALL SELECT 'match_players',           COUNT(*) FROM public.match_players
UNION ALL SELECT 'match_games',             COUNT(*) FROM public.match_games
UNION ALL SELECT 'session_organizers',      COUNT(*) FROM public.session_organizers
UNION ALL SELECT 'session_wrapped_stats',   COUNT(*) FROM public.session_wrapped_stats
UNION ALL SELECT 'push_subscriptions',      COUNT(*) FROM public.push_subscriptions
ORDER BY tbl;
```

**Expected counts after cleanup (derived from backup):**

| Table | Expected |
|-------|----------|
| `auth.users` | **18** |
| `profiles` | **18** |
| `sessions` | **1** |
| `courts` | **2** |
| `queue_entries` | **17** |
| `matches` | **24** |
| `match_players` | **96** |
| `match_games` | **0** |
| `session_organizers` | **0** |
| `session_wrapped_stats` | **17** |
| `push_subscriptions` | *≤ 18 (harmless)* |

```sql
-- ── 7C: Spot-check — all remaining profiles are Chillax players ──
SELECT display_name, skill_level, created_at
FROM public.profiles
ORDER BY created_at;
-- Should return exactly the 18 names from the backup.

-- ── 7D: Leaderboard sanity check ──────────────────────────────
SELECT display_name, games_played, wins, losses, win_pct
FROM public.v_alltime_leaderboard_mat
ORDER BY wins DESC, win_pct DESC;
-- Should show only the 17 players from the Chillax session
-- (18 profiles minus Arvin's "reconnect" account which had 0 games).
```

---

## Execution Instructions

1. **Run Phase 0 queries first** — read-only, no risk. Record the session IDs for Sim Night and E2E.
2. **Fill in the two placeholder session IDs** in Phase 2A.
3. **Open Supabase Dashboard → SQL Editor** — this is required for `DELETE FROM auth.users` (needs `postgres` role).
4. **Copy-paste the entire Phase 1 → Phase 6 block** into a single SQL Editor window.
5. **Read it one more time.**
6. **Click Run.**
7. **Run Phase 7 verification queries** and confirm all counts match.

**If anything looks wrong after Phase 0:** Stop and do not proceed. Review the preview data and adjust accordingly.

---

## Emergency Rollback

The entire delete runs inside a `BEGIN / COMMIT` transaction. If any error occurs before `COMMIT`, the whole operation rolls back automatically — nothing is lost.

If you already ran `COMMIT` but want to restore Chillax data:
1. The backup file `backups/backup_2026-04-24.sql` will restore all 8 Chillax tables.
2. **But it cannot restore `auth.users`** — those are gone from Supabase Auth permanently.

This is why we never touch the 18 Chillax profile IDs in Phase 4. Their `auth.users` rows stay intact, and those players can still log in.

---

## What This Does NOT Touch

- Database schema (tables, views, functions, RLS policies, migrations) — **unchanged**
- Vercel environment variables — **unchanged**
- Supabase project settings — **unchanged**
- Supabase Storage — **unchanged**
- The 18 Chillax players' ability to log back in via PIN — **preserved**

---

*Status: DRAFT — Phase 0 (read-only discovery) complete. Allowlist corrected for 3 reconnected profiles. Awaiting explicit approval to execute Phases 1–6.*
