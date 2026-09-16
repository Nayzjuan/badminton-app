# DIGITAL_TWIN_SYNC_PLAN.md

Bring `digital-twin/` back into agreement with the app, and make the build refuse to let it
drift again. **Delete this file when Stage 6 lands** — a plan that survives its feature is
worse than no plan (`CLAUDE.md`, writing rule 7).

This is the **revised** plan. Two independent reviews of the first draft are incorporated
below; claims they could not verify are marked as such.

---

## 0. Finding

The twin's premise is that it is generated from host source. Nine of sixteen pages import
`manifest.json`. Seven do not (`index`, `about`, `database`, `realtime`, `components`, `flows`,
`sandbox`). `engine.astro` is mixed: frontmatter reads `manifest.constants` (correct), the
client `<script>` island twenty lines below hardcodes its own thresholds (wrong). That mixed
page is the highest-severity content defect.

The drift is four mechanical defects, not editorial neglect:

1. **`.husky/pre-commit` re-extracts on the wrong trigger.** It fires only when
   `src/app/globals.css`, `src/app/layout.tsx` or `src/app/organizer/layout.tsx` are staged.
2. **When it does re-extract, it discards the result.** It stages `APP_MANIFEST.md` and not
   `digital-twin/src/data/manifest.json`. Working copy `_lastExtracted` is 2026-09-15;
   committed copy is 2026-08-12.
3. **`live-schema-snapshot.json` has no capture tooling.** Captured 2026-06-05; 99 migrations
   since. `/schema-drift` reports ~35 findings that are nearly all false.
4. **Nothing verifies freshness.** No CI job builds the twin or fails on a manifest diff.

### Verified evidence

| Claim | Source |
|---|---|
| Snapshot 13 tables / 35 functions / 49 policies vs live 25 / 62 / 47 | `live-schema-snapshot.json` vs `pg_class`/`pg_proc`/`pg_policies` on `usxftpexoimletqmrggb` |
| Engine calculator constants | `digital-twin/src/pages/engine.astro` `<script>` vs `src/lib/constants.ts` |
| Worked example wait 24 / games 3 → twin 0 Normal, real 1000 Tier 2 | `computePriorityScore`: skip Tier 3 (24 < 25), enter Tier 2 (24 ≥ 20), `1000 + 24 − 24 = 1000` |
| §9 has 32 gotchas; twin has 27; 7 of §9 are absent; 2 twin entries are not in §9 | `sed -n '2556,2590p' APP_MANIFEST.md` vs `CURATED_GOTCHAS` |
| `npm run check` cannot run | twin `package.json` has `"check": "astro check"`; `@astrojs/check` is not installed; the command prompts interactively |
| Prettier dirties `manifest.json` | `npx prettier --check digital-twin/src/data/manifest.json` fails; lint-staged maps `*.json` to `prettier --write` |
| `MEMORY.md` is 39,304 / 40,000 bytes | `wc -c MEMORY.md` |
| Root already has `pg` + `DATABASE_URL` | `tests/integration/helpers/withTx.ts`, `tests/integration/env.example` |
| Marketing site imports the twin sandbox | `marketing-site/astro.config.mjs` aliases `@bbmt/digital-twin` → `SandboxRoot.tsx` |

### Acceptance

All of these hold when the work is done:

- `cd digital-twin && npm run extract -- --check` exits 0 on a clean tree.
- No `.astro` page states a host-app count that does not come from a `manifest.json` read.
- Twin CI fails if: a component-graph node names a missing file; a flow trace names a
  function absent from `manifest.actionDetails`; an annotation key has no matching manifest
  entry; the gotcha set disagrees with `APP_MANIFEST.md` §9 plus the sidecar; or the
  committed manifest disagrees with a fresh extract.
- `/schema-drift` reports only findings that are true against a snapshot captured in the
  same change, after any DDL in this plan has been applied.
- Every feature in §5's coverage table has a page or a trace.
- Re-running the audit that produced this plan requires no edits.

---

## 1. Constraints

1. Root `tsconfig.json` excludes `digital-twin`. Twin typecheck is
   `cd digital-twin && npx tsc --noEmit -p tsconfig.json`. That command currently typechecks
   **zero `.astro` pages**. `.astro` typecheck requires `@astrojs/check` (Stage 0.1).
2. Root ESLint lints `digital-twin/src/**/*.ts(x)` and `digital-twin/scripts/**`. It does
   **not** lint `.astro` files. Do not treat `npm run lint` as coverage of frontmatter.
3. `extractCoverage` returns `null` when `coverage/lcov.info` is absent. Widening the
   extract hook without preserving the coverage block wipes it from the committed manifest.
4. `_lastExtracted` is a timestamp. `--check` must ignore it **and** `coverage`.
5. Migrations are applied by hand. Verify the prod stamp via `list_migrations`.
6. Row types in `src/types/database.ts` are `type` aliases, never `interface`.
7. Commit with explicit pathspecs, never `git add -A`.
8. Existing CI `paths-ignore`s `**/*.md`. The twin workflow must **not**.
9. `*.md` is in `.prettierignore` by decision. `digital-twin/src/data/` is **not**, and
   that is why the committed manifest is already prettier-dirty.
10. `MEMORY.md` is hard-capped at 40,000 bytes on the staged blob. Append only after prune.

---

## 2. Decisions (revised)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Snapshot capture lives in root `scripts/capture-schema-snapshot.ts`**, uses existing `pg` + `DATABASE_URL`, writes `digital-twin/src/data/live-schema-snapshot.json`. | Root already has `pg`/`@types/pg` and the `DATABASE_URL` convention. Do not add `pg` to the twin. Do not invent `SUPABASE_DB_URL`. Do not create `.env.test.example` (root `.gitignore` is `.env*`; the existing template is `tests/integration/env.example`). |
| D2 | **First snapshot is bootstrapped via the live Supabase MCP connection**, then the script is landed for repeatability. | Stage 1's value must not block on a connection string. The script is still mandatory. |
| D3 | **Extractor emits the full component *node set* (every file under `src/components`, `src/hooks`, `src/app/actions`). The rendered D3 graph is capped to the organizer and player dashboard subtrees plus their direct edges.** | A 33-node curated graph is a permanent inaccuracy. A full-repo force graph of ~130 nodes is unreadable. Existence assertions run on the full set; the drawing is a view. |
| D4 | **`leaderboard_refresh_state` is added to `src/types/database.ts`.** | Live, and `scripts/prod-snapshot.ts` already lists it. Columns: `id boolean NOT NULL DEFAULT true`, `last_refreshed_at timestamptz NOT NULL`. |
| D5 | **The two `_prerebuild_20260812` tables are dropped by migration, gated on explicit approval.** | Backups from the 2026-08-12 rebuild. If approval is withheld, whitelist them in `computeDrift` with a stated reason so `schemaDrift.ok` can still become true. Do not leave the criterion unmeetable. |
| D6 | **Gotchas are parsed from `APP_MANIFEST.md` §9. Sidecar keyed by gotcha number holds severity/category/link. Twin-only PostgREST entries stay in the sidecar as unnumbered extras.** | 7 of 32 §9 items are absent from `CURATED_GOTCHAS`. Two twin entries (`postgrest-update-empty-array`, `postgrest-insert-single-safe`) have no §9 counterpart — keep them, do not silently delete. Extraction fails when §9 has an item with no sidecar row. **Also rewrite §9 item 22** (and the matching comment in `src/lib/broadcast.ts`): co-organizers now have `SELECT` on `sessions` via `is_session_organizer` / `is_club_member`. Parsing a stale §9 would re-inject the lie. |
| D7 | **Twin tests live in the twin** (`digital-twin/vitest.config.ts` + `vitest` as a twin **devDependency**, lockfile updated in the same commit). | Root coverage floors must not be diluted. |
| D8 | **A new `.github/workflows/digital-twin.yml`.** Triggers on the **union of all extractor inputs after Stage 2**, not the Stage 0 subset. Listed once in §3 and referenced from hook, watcher, and workflow — do not maintain three copies that can drift. |
| D9 | **Engine calculator constants are injected via a `<script type="application/json" id="engine-constants">` tag** filled from frontmatter, read by the client `<script>` with `JSON.parse`. | The calculator lives in a processed `<script>` island. Frontmatter scope is not visible there. `define:vars` forces `is:inline` and would break the TypeScript casts. Importing `manifest.json` inside the island inlines the whole file. A tiny JSON blob is the only option that keeps TS, keeps the bundle small, and is reachable by a build-time throw in frontmatter (missing constant → throw before the tag is rendered). |
| D10 | **Build-time throws vs. deploy.** Structural invariants (missing file, unknown action, missing annotation, gotcha/sidecar mismatch, manifest ≠ extract) **throw** in `extract --check`, pre-push, and twin CI. Snapshot *age* is a **page warning**, never a Vercel-build throw — the twin's production build is `astro build`, which does not run extract, and a stale snapshot must not take the docs site off the internet. Host-path `existsSync` checks in Astro frontmatter run in CI (full monorepo) and are skipped when `src/` is absent, with a page warning. |
| D11 | **New pages go in `Nav.astro` and the index section cards. `StartHereRail` stays three items. No new `PhaseBadge`s.** | The rail is a triage device. `PhaseBadge` in `live` status does not render the phase number. |

### Extractor input union (D8) — the single list

These paths, from Stage 0 onward, trigger extract, are watched by `watch.ts`, and are the
workflow `on.paths`:

- `src/types/database.ts`
- `src/lib/constants.ts`
- `src/lib/broadcast.ts`
- `src/lib/realtime.ts`
- `src/lib/matchmaking-core.ts`
- `src/app/actions/**`
- `src/app/globals.css`
- `src/app/layout.tsx`
- `src/app/organizer/layout.tsx`
- `src/hooks/**`
- `src/components/**`
- `src/app/**` (route walk)
- `src/middleware.ts`
- `supabase/migrations/**`
- `APP_MANIFEST.md`

Design-token extra (extract **and** `sync-design-tokens.ts`): the three CSS/layout paths.

---

## 3. Review findings folded in (so they are not re-derived)

Kept as a work list, not a grade. The first-draft claims they overturn are deleted from
the stages below.

- Trigger list is the **post-Stage-2 union from day one**. Amending it later is how `--check`
  goes red on edits nothing regenerates.
- `session-settings` is **present** on `/realtime`. Only `session-row` is missing. The
  `session-settings` callback listed as `setAutoMatchmaking` is wrong — the real handler
  strips `is_auto_matchmaking_on` and `auto_publish` before applying.
- After a fresh snapshot, `columnNullabilityDrift` will fire on `matches.is_held` and
  `matches.final_classification` (GENERATED, Postgres-nullable, TS non-null). Add both to
  `EXPECTED_NULLABILITY` in the same change as the capture.
- `index.astro` has **eight** stats, not six. Also hardcoded: glossary card "28 numbered
  critical rules", step 07 "These 8 gotchas".
- `about.astro` and `database.astro` lack `data-pagefind-body` today (13 of 16 pages indexed).
- `marketing-site` aliases the twin sandbox; Stage 4.2 must `cd marketing-site && npm run build`.
- Review-gate pathspec must include `*.astro` (and the hook / workflow files). The gate runs
  after **every** stage that changes `.ts`/`.tsx`/`.sql`/`.astro`, not a subset.
- `coverage.astro` empty state says `npm run test -- --coverage`; the real script is
  `test:unit:coverage`.
- `designTokens` is a fourth unread twin-page key; it has a consumer (`sync-design-tokens.ts`).
  Keep the key, do not invent a twin page for it. Delete `scenarios` (always `[]`, unread).
- `elevate_to_organizer` is live and **uncalled** from `src/` (`rg` is empty). Disposition:
  drop it in the 1.7 migration if unused in `supabase/migrations/` as a still-granted RPC;
  otherwise type it. Do not whitelist a callable leftover.

---

## 4. Coverage table (acceptance: every row has a page or a trace)

| Feature | Disposition |
|---|---|
| Schema, RPCs, enums, views | `/database` (Stage 3.2) |
| Server actions | `/actions` + `/action-reference` |
| Matchmaking engine, auto-publish, draft-cap override | `/engine` |
| Realtime channels + broadcasts | `/realtime` |
| Component / hook graph | `/components` |
| Queue / match / held-draft state machines | `/state-machines` |
| Migrations, RLS, schema drift, coverage | existing pages, snapshot-fed |
| Gotchas | `/glossary` |
| Organizer sandbox | `/sandbox` + marketing-site build |
| Multi-tenant clubs, `/c/[clubSlug]`, invites, membership gate | **new** `/multi-tenancy` |
| Anonymous auth, PIN reconnect, OAuth, rename / dup-name, registration / QR join | **new** `/identity` |
| Cross-court held drafts | **new** `/cross-court` |
| Web Push, organizer inbox, centre alerts, score correction | **new** `/notifications` |
| Leaderboard (session / monthly / all-time / matview refresh) | **new** `/leaderboard` |
| Session Wrapped (awards, as-of ledger, close → wrap) | **new** `/wrapped` |
| PWA, offline, serwist, `manifest.ts` | **new** `/pwa` |
| Middleware, Supabase client factories, request-path stamp | **new** `/request-pipeline` |
| Zod schemas | fold into `/actions` |
| Error boundaries, `/welcome`, `/not-found` | fold into `/request-pipeline` |
| Dev / sandbox / vip-preview / wrapped-preview routes | fold into `/components` as a "dev surfaces" note |
| Integration + E2E + post-deploy smoke | fold into `/coverage` as a second pane |
| Live match swap, fix player record, match provenance | `/flows` traces + `/actions` annotations |
| TV scoreboard | existing `/flows` tv-sync (fixed) + `/components` |

Out of scope on purpose: `marketing-site/` as a *documented product* (it is a consumer of the
sandbox, not an app feature); rate limiting (does not exist in `src/` or migrations).

---

## 5. Execution stages

Sequential. Each stage ends at a commit boundary and leaves the tree green.

### Stage 0 — Stop the bleeding

No content changes. After this the generated half cannot go stale silently.

**0.1 — Tooling that Stage 0's own validation requires.**
- Install `@astrojs/check` (and keep `typescript`) as twin **devDependencies**; prove
  `cd digital-twin && npm run check` exits 0 non-interactively.
- Add `digital-twin/src/data/` to `.prettierignore` **before** any hook stages
  `manifest.json`. Verify `npx prettier --check digital-twin/src/data/manifest.json`
  is skipped, not failed.
- Prune `MEMORY.md` first: move enough ✅ SHIPPED / CLOSED narrative to
  `docs/archive/MEMORY_HISTORY.md` that ≥ 2 KB of headroom remains. Do not append yet.

**0.2 — Make `extractCoverage` non-destructive.**
When `coverage/lcov.info` is absent, reuse the `coverage` block from the existing
`manifest.json` and log that it was preserved. Without this, 0.5 destroys data.

**0.3 — Add `--check` to `extract.ts`.**
Mirror `sync-design-tokens.ts`. Compare in memory against disk **excluding `_lastExtracted`
and `coverage`**. Print differing top-level keys and the remedy command. Do not write in
check mode. Guard `run()` behind `import.meta.url === pathToFileURL(process.argv[1]).href`
so tests can import helpers; `tsx scripts/extract.ts` (pre-commit, `watch.ts`) still runs.

**0.4 — Single source for the input union.**
Export the path list from `digital-twin/scripts/extract-inputs.ts` (or a comment-locked
array in `extract.ts` that `watch.ts` imports). Pre-commit and the workflow YAML cannot
import TS; they get the same list copied with a comment `KEEP IN SYNC with extract-inputs.ts`.
The copied list is the D8 union, including `APP_MANIFEST.md` and `src/hooks/**` from day one.

**0.5 — Widen `.husky/pre-commit` and stage the output.**
- `TWIN_SOURCE_STAGED` matches the D8 union. When non-empty: `extract.ts`, then
  `git add digital-twin/src/data/manifest.json`.
- `DESIGN_STAGED` remains the three token paths. When non-empty: also `sync-design-tokens.ts`
  and `git add APP_MANIFEST.md`.
- lint-staged still runs after. Because `digital-twin/src/data/` is prettier-ignored, it
  will not un-stage a reformatted manifest.

**0.6 — `.husky/pre-push`.** After the existing three host checks, run
`cd digital-twin && npm run extract -- --check`. Do **not** run the full twin build on every
push (too slow, same reason host `pre-push` skips `next build`). Twin `tsc` + `astro check` +
`npm test` + `npm run build` live in CI.

**0.7 — `.github/workflows/digital-twin.yml`.** Triggers: push/PR on the D8 union plus
`digital-twin/**`. Steps: root `npm ci`; twin `npm ci`; `npm run test:unit:coverage` (so
`lcov.info` is real); `cd digital-twin && npm run extract -- --check`; `npm run check`;
`npx tsc --noEmit -p tsconfig.json`; `npm test` (no-op until 2.7 adds vitest — make the
script exist in 0.1 as `echo 'no tests yet' && exit 0`, replaced in 2.7); `npm run build`.
Job name: `Twin extract, types, build`. Note the `unit-tests.yml` header: this **runs**
without **blocking** merges on the current GitHub plan.

**0.8 — Widen `digital-twin/scripts/watch.ts`** to the D8 union. Today it misses
`supabase/migrations/`, `src/lib/realtime.ts`, `src/lib/matchmaking-core.ts`,
`src/components/**`, `src/hooks/**` (except `use-organizer-data.ts`), `src/middleware.ts`.

**0.9 — Commit the already-regenerated manifest** last in this stage, after 0.1–0.2, so
coverage preservation is in force and prettier will not dirty it on the way in.

*Validation:* `extract -- --check` exits 0; editing `CRITICAL_WAIT_MINUTES` and re-running
exits 1; `npm run check` in the twin exits 0; `git status --porcelain -- digital-twin/src/data`
is empty after a token-path commit.

---

### Stage 1 — Snapshot, then true drift

**1.1 — Bootstrap-capture** via MCP into the existing snapshot shape:
`{ _note, capturedAt, tables, views, functions, policies }`. Sort every collection.

**1.2 — `scripts/capture-schema-snapshot.ts`** (D1). Reads `DATABASE_URL` the same way
`withTx.ts` does (`.env.local` / `.env.test` via `dotenv`, already a root dep). Document the
variable in `digital-twin/README.md` and point at `tests/integration/env.example` for the
local-shape string. Add `"capture-snapshot": "tsx ../scripts/capture-schema-snapshot.ts"`
in the twin `package.json`. No new twin dependency.

**1.3 — `EXPECTED_NULLABILITY`** for `matches.is_held` and `matches.final_classification`
(GENERATED columns). Same reason as the existing `session_wrapped_stats.point_diff` entry.

**1.4 — `EXPECTED_DB_ONLY_FNS`.** Add: `has_match_access`, `is_club_member`,
`is_match_club_member`, `is_session_club_member`, `session_access_level`,
`log_queue_status_change`, `realtime_topic_session_id`. Remove `is_any_session_organizer`
(whitelisted, gone from the database).

**1.5 — `leaderboard_refresh_state` in `src/types/database.ts`** (D4), `type` alias +
`Tables` entry. Summarize in `APP_MANIFEST.md` §2 (not only §10).

**1.6 — Re-run `npm run extract`.** Expect the 9 false code-only tables, 20 false
code-only RPCs, and 6 column-drift entries to disappear. Remaining db-only tables should
be the two `_prerebuild_*` backups, `elevate_to_organizer`, and nothing else.

**1.7 — Migration**, after explicit approval: drop
`player_partnerships_prerebuild_20260812`, `player_rivalries_prerebuild_20260812`, and
`elevate_to_organizer` if 1.6 confirmed it is uncalled. Capture a prod snapshot with
`scripts/prod-snapshot.ts` first. Apply by hand, `list_migrations` to verify.

**If approval is withheld:** do not write the migration. Add the leftover objects to an
`EXPECTED_DB_ONLY_TABLES` / `EXPECTED_DB_ONLY_FNS` list with the reason in a comment.
`schemaDrift.ok` must still be achievable.

**1.8 — Re-capture the live snapshot and re-extract** after 1.7 is stamped (or after the
whitelist in the withheld path). Stage 1's criterion is `schemaDrift.ok === true` against
the schema that exists **after** this stage's DDL, not before.

**1.9 — Surface snapshot age** on `/rls` and `/schema-drift` as a days-elapsed figure.
Build warning (not throw) when `capturedAt` predates the newest migration filename (D10).

Host tests: the `database.ts` addition is a type, not a lifecycle. No new integration test
required for a two-column internal table. The drop migration is verified by `list_migrations`
and by 1.8's drift going clean. State that `npm run test:integration` is out of scope for
this plan (needs local Supabase; `pre-push` already excludes it).

---

### Stage 2 — Extending the extractor (enabling work, no page rewrite yet)

**2.1 — `channels`.** Parse `src/lib/realtime.ts` `subscribeTo*` templates; scan
`src/hooks/**` for `channelPrefix` and for channels created outside `realtime.ts`
(`session-settings` in `use-organizer-session.ts`, `session-row` in
`use-session-closed-watcher.ts`). The `channels` key is currently `[]`.

**2.2 — Broadcast payload detail.** Fill `payloadType` and the emitter function name for
each of the 8 events. Keep `OrganizerInterventionType` members.

**2.3 — `components` node set** (D3). Import-scan `src/components/**`, `src/hooks/**`,
`src/app/actions/**`. Emit `{ file, kind, exported }`. Edges optional for the cap-rendered
view; existence assertions use `file`.

**2.4 — `routes`.** Walk `src/app` for `page.tsx` / `route.ts` / `layout.tsx`, resolve
`(groups)` and dynamic segments, classify organizer / player / public / dev.

**2.5 — Gotchas from §9** (D6). Rewrite §9 item 22 **before** the first parse. Sidecar at
`digital-twin/src/data/gotcha-sidecar.json`. Fail extract on a §9 item with no sidecar row.
Keep the two PostgREST extras. Update `glossary.astro` in Stage 3 to stop hardcoding "27".

**2.6 — Delete `scenarios`.** Keep `designTokens` (consumed by `sync-design-tokens.ts`).

**2.7 — Held-draft state machine** added to `STATE_MACHINES` here (not in Stage 5).
States `HOLDING` / `RESTING` / `READY` from `lib/cross-court/derive-held-state.ts`. Twin
unit tests cover the curated edges. The CLAUDE.md lifecycle rule (drive creation → terminal
without hand-setting columns) is **host integration scope** and is out of this plan — the
feature already shipped; this is documentation of existing states.

**2.8 — `digital-twin/src/lib/invariants.ts`** created here, **before any page imports it.**
Helpers: `constByName(manifest, name)` (throws if missing), `assertFilesExist(paths)`
(no-op when host `src/` is absent), `assertActionsExist(names)`, `assertAnnotationCoverage`,
`assertGotchaParity`. Pages start importing these in Stage 3.

**2.9 — Twin vitest.** Add `vitest` to twin `devDependencies`, replace the 0.7 stub `test`
script, update the lockfile. Cover: coverage preservation, `--check` ignore-keys,
channel-template parsing, route-group resolution, §9 parse, sidecar miss, drift against a
**fixture** snapshot (including GENERATED nullability), `constByName` throw.

**2.10 — Confirm** watch.ts / pre-commit / workflow still match the D8 union (they should,
because Stage 0 used the union). Add `npm test` as a real CI step now that vitest exists.

---

### Stage 3 — Convert hand-written pages to manifest-driven

Each step **deletes** a hardcoded fact. Prose the manifest cannot supply lives in a keyed
annotation map; a missing key throws via `assertAnnotationCoverage`. Every rewritten page
gets `data-pagefind-body` if it does not already have it.

**3.1 — `index.astro`.** Derive all **eight** stats from the manifest (tables, enums, views,
RPCs, action files, `channels.length`, broadcasts, traces). Replace the glossary card "28"
and step 07 "8 gotchas" with `gotchas.length`. Generate Mermaid labels from the same
values. Add `/c/[clubSlug]/…` from `manifest.routes`. Keep `StartHereRail` at three items
(`/about`, `/flows`, `/components`).

**3.2 — `database.astro`.** Drive tables / views / enums / RPCs off the manifest. Annotation
map for glosses. Fail on an unannotated table. This also fixes `queue_status` missing
`drafted` and `match_origin` presented as live. Add `data-pagefind-body`.

**3.3 — `engine.astro` calculator** (D9). Frontmatter: `constByName` for
`CRITICAL_WAIT_MINUTES`, `GAME_PENALTY_MINUTES`, `RED_ZONE_SCORE_FLOOR`,
`HARD_WAIT_CAP_MINUTES`, `HARD_CAP_SCORE_FLOOR`, `HARD_CAP_GAMES_CEILING`,
`GAMES_AHEAD_PENALTY`, `GAMES_AHEAD_PENALTY_RED_ZONE`. JSON script tag. Client script
implements all three tiers matching `computePriorityScore`, including `Math.round` on
Tier 3 and the `games < HARD_CAP_GAMES_CEILING && wait >= HARD_WAIT_CAP_MINUTES` guard.
Red Zone membership: `wait >= CRITICAL_WAIT_MINUTES` (the `isRedZonePlayer` wait arm).
Do not test `score >= RED_ZONE_SCORE_FLOOR` alone. Worked check: wait 24, games 3 → 1000,
Tier 2.

**3.4 — `engine.astro` pipeline.** Dynamic cap 3 / 5 / 6 via `DRAFT_CAP_*_THRESHOLD` and
`MAX_AUTO_DRAFTS{,_LARGE,_XLARGE}`. Diversity node: helpers live in `matchmaking-db.ts`.
Cap counting: `getDynamicDraftCap(waitingCount) − draftCount`, mode-filtered per §9 item 24.

**3.5 — `realtime.astro`.** Channel map from `manifest.channels`. Broadcast catalog from
`manifest.broadcasts` (payload + emitter). Drop "4 events" (the page already disagrees with
itself: prose 4, array 5). Fix `session-settings` callback. Add `session-row`. Topic is
`session-events:{sessionId}` with no `realtime:` prefix (also fix that prefix in
`flows.astro`'s cap-saturation diagram). Replace the co-organizer RLS rationale with the
current one (speed / namespacing; SELECT is granted).

**3.6 — `components.astro`.** Render the capped graph from `manifest.components` (D3).
Full node set feeds the existence assertion. Dead curated paths (`queue-toggle.tsx`,
`match-card.tsx`, `teams-grid.tsx`, old `match-timer` path, inlined TV cards,
`actions/match.ts`) disappear because they are no longer a hand list. Keep the inspector
drawer.

**3.7 — `actions.astro`.** Annotate the seven blank files: `clubs.ts`, `oauth.ts`,
`rename.ts`, `registration.ts`, `match-events.ts`, `repeat-pairing.ts`,
`upcoming-match.ts`. `assertAnnotationCoverage`. Fix the page description that still says
13 files. Fold Zod schemas (`src/lib/schemas/*`) into this page.

**3.8 — `about.astro`.** Rewrite against the current product: clubs, OAuth, leaderboard,
push, cross-court, TV, rename. Add `data-pagefind-body`. Stop hardcoding "11 animated
sequence diagrams" — read the traces length (or drop the number).

**3.9 — `glossary.astro`.** Consume the new gotcha shape. Stop hardcoding "27". Deep links
keep working via sidecar `id`.

**3.10 — `coverage.astro`.** Fix the empty-state command to `npm run test:unit:coverage`.
Add a second pane describing integration, E2E, and post-deploy smoke as documentation
(not as numbers extracted from those suites).

---

### Stage 4 — Remaining hand-written surfaces

**4.1 — `flows.astro`: six wrong traces, then the assertion.**

| Trace | Defect | Correction |
|---|---|---|
| `draft-publish` | `toggleDraftMode`; `status='draft'`; `publishAllDraftsAction` | `toggleAutoPublish`; `pending` + `is_published=false`; `publishAllDraftMatchesAction` |
| `pin-reconnect` | `reconnectWithPIN`; PIN lookup `AND session_id` on `profiles` | `reconnectPlayer`; `profiles` has no `session_id` |
| `join-queue` | `status='active'`; gone `QueueToggle`; claims `isSessionOrganizer` on self-join | `waiting`; `my-status-tab.tsx`; `join_queue` RPC, no organizer check on self-join |
| `tv-sync` | anon receives `postgres_changes`; inline `TvBoard` subscriptions | `useTvBoard`; anon is poll-backed |
| `session-wrapped` | `router.push("/wrapped/…")` | `useSessionClosedWatcher` → `clubWrapped(slug, sessionId, playerId)` |
| `cap-saturation` | `{ reason, affectedPlayerIds }` | `broadcastCapSaturation` `{ type, anchorPlayerId, anchorPlayerName, reason? }` |

Then `assertActionsExist` over every function a trace names.

**4.2 — Sandbox** (`digital-twin/src/sandbox/**`). Dynamic cap; mode-filtered cap count
(`shouldAutoPublishMatch` rule); match state is `pending` + `is_published`, not `'draft'`.
Where the sandbox stays a deliberate simplification, say so **on the page**. Then
`cd marketing-site && npm run build` (it aliases `SandboxRoot.tsx`). Do not change
`digital-twin/src/styles/global.css` in this stage unless required; if you do, run
`cd marketing-site && npm run sync`.

**4.3 — `Nav.astro` / `PageHeader.astro` / `BaseLayout.astro`.** No count literals.
`BaseLayout` already reads `_lastExtracted` — leave that. Confirm `state-machines.astro`
edges still match after Stage 2.7's third machine; no separate rewrite.

---

### Stage 5 — Missing architecture pages

All consume `manifest.routes`, `manifest.actionDetails`, `manifest.channels`. All get
`data-pagefind-body`. Wired into `Nav.astro` and index section cards only (D11).

**5.1 — `/multi-tenancy`.** `/c/[clubSlug]`, `club-paths.ts`, layout membership gate,
invites / roles (`actions/clubs.ts`), club-scoped RLS helpers, legacy redirect shims.

**5.2 — `/identity`.** Anonymous + PIN (`auth.ts`), Google OAuth + linking + guest merge,
rename / dup-name, registration and QR join (`registration.ts`, `/j/[sessionId]`).

**5.3 — `/cross-court`.** `derive-held-state.ts`, pull eligibility, readiness / expiry,
`create_held_cross_court_match`, `upcoming-match.ts`.

**5.4 — `/notifications`.** VAPID, enrollment, inbox, centre alerts, pause reminders,
score-correction request/resolve.

**5.5 — `/leaderboard`.** Session / monthly / all-time, `v_alltime_leaderboard_mat`,
`leaderboard_refresh_state`, `lib/leaderboard-refresh.ts`, `lib/month.ts`.

**5.6 — `/wrapped`.** `compute_session_wrapped`, `wrapped-awards.ts`, as-of ledger,
hidden-session exclusion, close → wrap.

**5.7 — `/pwa`.** `serwist-register`, `pwa-nav-bar`, `manifest.ts`, `/offline`,
middleware matcher comments for `/sw.js`.

**5.8 — `/request-pipeline`.** `src/middleware.ts` (auth refresh, join-link repair,
`x-request-path`), `src/utils/supabase/{client,server,service,middleware}.ts`,
`createServiceClient` rule, error boundaries, `/welcome`.

**5.9 — New traces:** club join + invite, OAuth callback, held-draft publish, live
in-progress match swap, score correction, fix-player-record. Each must pass 4.1's
assertion.

---

### Stage 6 — Refuse to lie, then close

**6.1 — Confirm every Stage 3–5 page imports the 2.8 helpers** and that a deliberately
wrong annotation / missing constant / dead file path fails `cd digital-twin && npm run build`
in this monorepo. Snapshot age remains a warning (D10).

**6.2 — Twin CI** (already created in 0.7, filled in 2.10) is the enforcement for
`--check`, `astro check`, twin `tsc`, twin tests, and `astro build`.

**6.3 — Documentation, then delete this file.**
- Incident write-up: `docs/incidents/2026-09-16-digital-twin-drift.md`, one-line pointer
  from `APP_MANIFEST.md` §10.
- `APP_MANIFEST.md` §10 in the present tense (pipeline as it now is). Also §2 if 1.5/1.7
  changed schema; §9 item 22 already rewritten in 2.5.
- `digital-twin/README.md` "Keeping it from drifting" becomes a description of extract /
  capture-snapshot / `--check` / CI, not a suggestion.
- `MEMORY.md`: append at most ~15 lines **after** confirming the 0.1 prune left headroom.
  Move this plan's closed items; do not leave them stamped here.
- `npm run docs:index`.
- **Delete this plan file.**

Branch, push, PR are part of finishing, not optional reporting. Pathspec commits throughout.

---

## 6. Validation, every stage that touches executable code

```
npx tsc --noEmit
npm run lint
npm run test:unit
cd digital-twin && npx tsc --noEmit -p tsconfig.json
cd digital-twin && npm run check
cd digital-twin && npm test
cd digital-twin && npm run extract -- --check
cd digital-twin && npm run build
git status --porcelain -- src tests digital-twin .husky .github
```

`npm run build` at host root only when routes, config, or dependencies changed.
`cd marketing-site && npm run build` additionally after Stage 4.2.

A test that is not `git add`ed does not exist.

---

## 7. Code review gate

Precondition is met. After **every** stage that changes `.ts` / `.tsx` / `.sql` / `.astro`
(that is 0 through 6 except a docs-only 6.3), spawn review round 1 with the `CLAUDE.md`
prompt **and this pathspec**:

```
git diff origin/main...HEAD -- '*.ts' '*.tsx' '*.sql' '*.astro' '.husky/*' '.github/workflows/*'
```

OUT OF SCOPE unchanged (markdown, comments, commit messages, wrapping, APP_MANIFEST /
MEMORY prose). Hardcoded counts inside `.astro` frontmatter **are in scope**.

Fix every finding. Round 2. No round 3. Unfixed items after round 2 use one of the five
admissible reasons.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Coverage block wiped | 0.2 before 0.5; unit-tested in 2.9 |
| `--check` flaky | Ignore `_lastExtracted` and `coverage` only |
| Prettier re-dirties the manifest | `.prettierignore` in 0.1, before the hook stages it |
| `astro check` hangs CI | 0.1 installs `@astrojs/check` and proves a non-interactive exit |
| Calculator still unreachable from invariants | D9 JSON tag + `constByName` in frontmatter |
| Unreadable component graph | D3: full node set, capped drawing |
| Backup-table drop loses wanted data | Approval gate + prod-snapshot first; withheld path is a whitelist |
| Twin Vercel outage from a throw | D10: age is a warning; structural throws are CI |
| Marketing site ships a broken sandbox | 4.2 builds it |
| `MEMORY.md` cap refuses the close-out commit | Prune in 0.1 |
| Direct `pg` to prod is IPv6-only | D2 bootstrap via MCP first; if the script cannot connect, document the pooler URL in the README and keep MCP as the capture path |
| Host-path `existsSync` on a twin-only Vercel checkout | D10 skip + page warning |

---

## 9. What is deliberately not in this plan

- Rotating the leaked `service_role` key (`MEMORY.md` 🔴 OPEN). Unrelated, needs dashboard access.
- Hashing PINs. Unrelated.
- Changing matchmaking behaviour. The twin documents it; it does not retune it.
- Making GitHub branch protection exist. The workflow runs; it cannot block on this plan.
