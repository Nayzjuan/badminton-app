# Badminton Queue App — Digital Twin

A living-documentation site for the [Badminton Queue App](../). It renders an
always-current, interactive map of the codebase — schema, server actions,
matchmaking engine, realtime channels, RLS policies, migrations, test coverage,
and schema drift — built with [Astro](https://astro.build) + Tailwind v4.

> **Why "digital twin"?** The site is **generated from the host source**, not
> hand-written. A build-time extractor (`scripts/extract.ts`) parses the app's
> TypeScript, SQL migrations, and coverage report into a single
> `src/data/manifest.json`, which every page reads. Keep the manifest fresh and
> the docs can't drift far from reality. The footer shows when it was last
> extracted.

## Quick start

```bash
npm install
npm run extract      # regenerate src/data/manifest.json from ../ (the host app)
npm run dev          # local dev server
npm run build        # static build + Pagefind search index
npm run preview      # serve the production build
```

`npm run dev:full` runs the extractor in watch mode alongside the dev server.

## How extraction works

`scripts/extract.ts` reads the host app (one level up, `HOST_ROOT = ../`) and
emits `src/data/manifest.json`:

| Manifest key                       | Source                                    | Powers                               |
| ---------------------------------- | ----------------------------------------- | ------------------------------------ |
| `tables`, `views`, `enums`, `rpcs` | `src/types/database.ts` (TS compiler API) | Database explorer                    |
| `constants`                        | `src/lib/constants.ts`                    | Engine page                          |
| `actions`, `actionDetails`         | `src/app/actions/*.ts` (regex)            | Server Actions, **Action Reference** |
| `broadcasts`                       | `src/lib/broadcast.ts`                    | Realtime catalog                     |
| `migrations`                       | `supabase/migrations/*.sql`               | **Migration Timeline**               |
| `rlsPolicies`                      | `src/data/live-schema-snapshot.json`      | **RLS Policies**                     |
| `coverage`                         | `coverage/lcov.info`                      | **Test Coverage**                    |
| `schemaDrift`                      | snapshot ⟷ `database.ts` diff             | **Schema Drift**                     |
| `stateMachines`                    | curated (`extract.ts`)                    | **State Machines**                   |
| `designTokens`                     | `globals.css` + `layout.tsx`              | Token sync                           |
| `gotchas`                          | curated from `APP_MANIFEST.md`            | Glossary                             |

### The live-schema snapshot

`src/data/live-schema-snapshot.json` is a **point-in-time** capture of the live
Supabase `public` schema (columns, views, functions, `pg_policies`), taken via
introspection. It feeds the **Schema Drift** detector (compared against the TS
types) and the **RLS Policies** explorer. Re-capture it when the database
schema changes, then re-run `npm run extract`.

## Pages

**Architecture** — Database, Server Actions, Matchmaking Engine, Realtime & State, Components
**Schema & Quality** — Migration Timeline, Schema Drift, RLS Policies, State Machines, Action Reference, Test Coverage
**Reference** — Flows & Traces, Glossary & Gotchas
**Interactive** — Organizer Sandbox (split-screen organizer + player demo)

## Keeping it from drifting

The manifest goes stale silently if `extract.ts` isn't re-run. To stay honest:

1. Re-run `npm run extract` after any host-app schema/action change (the footer
   "Data extracted" date makes staleness visible).
2. Re-capture `live-schema-snapshot.json` after a DB migration so Schema Drift
   stays meaningful.
3. Consider a CI check that fails if `npm run extract` produces a diff against
   the committed `manifest.json`.

## Stack

Astro 5 · Tailwind v4 · React islands (sandbox only) · d3 · Mermaid (diagrams) ·
Pagefind (search). Diagrams use Mermaid loaded globally in `BaseLayout.astro`.
