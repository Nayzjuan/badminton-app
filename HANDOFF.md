# HANDOFF.md — Onboarding for a New AI Session

> Read this first if you are an AI assistant taking over work on this app.
> It covers the repo, the external connections (git / Supabase / Vercel), the two living
> documents you are required to maintain, and the non-negotiable workflow rules.
>
> **Connection facts below were verified on 2026-08-16.** Project ids and refs are stable;
> if a tool name or connector no longer resolves, re-verify rather than assuming drift.

You are taking over development of an existing, **in-production** Next.js 16 + Supabase app.
Do not scaffold anything new. Read before you write.

## 1. The local repository

- **Path:** `/Users/miggy-onb/Downloads/badminton-app` (this is the git toplevel — work here, not in a copy)
- **GitHub remote:** `git@github.com:Nayzjuan/badminton-app.git` (SSH, account `Nayzjuan`)
- **Main branch:** `main`. Feature work happens on branches → PR → squash merge.
- **Package name:** `badminton-app` (Next.js 16 App Router, TypeScript, Tailwind, Shadcn UI, Supabase)
- **Source layout:** `src/app` (routes + `actions/` server actions), `src/components`, `src/hooks`,
  `src/lib`, `src/types`, `src/middleware.ts`. Migrations live in `supabase/migrations/`.
- There is a second app in `digital-twin/` and a `marketing-site/` — both are separate
  Vercel projects. Do not confuse them with the main app.

Run this to orient yourself:

```bash
cd /Users/miggy-onb/Downloads/badminton-app && git status && git log --oneline -10 && git branch -a
```

## 2. How to find the connections (git, Supabase, Vercel)

**Critical:** these connections are **NOT configured in the repo.** There is no `.mcp.json`.
The repo-level MCP config (`~/.claude.json` under this project path) only has
`sequential-thinking`, `context7`, and `serena` — none of which touch git, Supabase, or Vercel.

Supabase and Vercel are **account-level connectors in the Claude Code app**, and their tool
names are opaque per-session UUIDs like `mcp__0ec1d7a9-…__execute_sql`. **Never hardcode or
guess those names.** Discover them by capability instead:

- List/search your available tools for the substrings `supabase`, `vercel`, `execute_sql`,
  `list_deployments`, `apply_migration`, `list_projects`.
- If your harness defers tool schemas, load them by search (e.g. a query for `supabase` or
  `vercel`) before calling anything.
- If no such tools exist in your environment, **say so and stop** — do not fall back to
  guessing, and do not invent credentials. Ask the user to connect the Supabase and Vercel
  connectors in the Claude Code app first.

### Git / GitHub — this is NOT MCP

Git is plain CLI, already authenticated. Verify with:

```bash
gh auth status && git remote -v
```

Expect: logged in as `Nayzjuan`, token scopes including `repo`, `workflow`, `admin:org`.
Use `gh pr create` / `gh pr checks` / `gh pr merge --squash` for PR work.
⚠️ `git push --force*` is blocked by the permission classifier here — hand force-pushes to
the user. Plain fast-forward `git push` works fine.

### Supabase

Two accessible projects share a similar name — pick carefully:

| Project ref            | Name                   | Status         | Use                          |
| ---------------------- | ---------------------- | -------------- | ---------------------------- |
| `usxftpexoimletqmrggb` | `badminton-app`        | ACTIVE_HEALTHY | **← THIS IS PRODUCTION**     |
| `dlkqqanjvwhiqfftzzwa` | `badminton-tournaments`| INACTIVE       | separate tournament engine   |

Confirm you're pointed at the right one: `.env.local` contains
`NEXT_PUBLIC_SUPABASE_URL=https://usxftpexoimletqmrggb.supabase.co`.
`supabase/config.toml` says `project_id = "badminton-app"` — that is a _local_ label, not the ref.

⚠️ **`.env.local` holds live production keys**, including `SUPABASE_SERVICE_ROLE_KEY`.
Never print, echo, commit, or paste those values. Read variable _names_ only when orienting.

⚠️ **`execute_sql` and `apply_migration` on `usxftpexoimletqmrggb` hit PRODUCTION DATA
directly.** Read queries are fine. Before any write or DDL, state exactly what you are about
to run and get explicit confirmation from the user.

### Vercel

- **Team / org id:** `team_d3uPFwwtYexuBIlNgNAIcUg9`
- **Project:** `badminton-app` → `prj_XIYCUpx5pRp8znySB3fT6zuXe59D` (from `.vercel/project.json`)
- Sibling projects on the same team you should not touch by accident: `digital-twin`,
  `badminton-marketing`, `badminton-tournaments`.
- Vercel MCP calls generally need **both** `projectId` and `teamId`.
- Deploys are automatic on merge to `main`. Verify a deploy with `list_deployments`, and read
  `get_deployment_build_logs` / `get_runtime_errors` when something breaks.

### Local dev server

`.claude/launch.json` defines `nextjs-dev` (`npm run dev`, port 3001, autoPort).
Prefer that over running a server ad hoc in a shell.

## 3. The two living documents — keep them updated (bounded)

This project runs an "autopilot" memory system. Two files at the repo root are living
documents, and you inherit the obligation to keep them true. **Both are also budgeted** —
they grew to 1.3 MB combined and silently ate the context window, which is the reason this
section is now shorter than it used to be. `CLAUDE.md` holds the authoritative rules; the
summary here exists only so you know the files are there.

- **`APP_MANIFEST.md`** — **how the app works right now.** Architecture, features, UI/UX
  rules, matchmaking logic, constants, routes, RPCs. Update it **in place** when you add or
  change a feature, alter a table/column/enum, add a Server Action or route, or touch
  `src/lib/constants.ts`. Present tense only. **No dated headings, no changelog at the
  bottom** — a dated incident write-up belongs in `docs/incidents/YYYY-MM-DD-slug.md`.

- **`MEMORY.md`** — **current state only**, hard-capped at 40 KB by `.husky/pre-commit`.
  What is in flight, what is broken, what is next, and the **migration queue table mapping
  each migration filename to its production stamp** — that table is the single most
  load-bearing thing in the file. Append at most ~15 lines per task. When an item closes,
  move it to `docs/archive/`; do not leave it in place with a ✅ stamp.

**Do not read either file end-to-end.** Read `DOC_INDEX.md` and open only the sections it
points at. `src/types/database.ts` is the one file you read whole — it is the source of
truth for the schema, and every row type there is a `type` alias, never an `interface`.
`AGENTS.md` still applies: Next.js 16 is NOT the Next.js in your training data — read
`node_modules/next/dist/docs/` before using any Next API.

⚠️ A hard-won lesson recorded in those docs: prose that explains _why_ rots faster than code.
When you touch a claim in either document, verify the claim, don't paraphrase the previous
sentence. If you correct something, the correction carries the same burden of proof.

## 4. Non-negotiable workflow rules

1. **Database migrations are applied BY HAND.** There is no DB deploy automation. Merging a PR
   ships TypeScript only. Prod migration stamps differ from repo filenames — `MEMORY.md` is the
   only record of that mapping. Never assume a merged migration is live; verify the stamp via
   `list_migrations`. Never run `supabase db push` (it would re-run applied migrations).
2. **Validate before concluding:** `npx tsc --noEmit`, `npm run lint`, `npm run test:unit`
   (~17 s total; all three are required — `test:unit` is not optional). `npm run build` only
   when routes, config, or dependencies changed. Then check `git status --porcelain -- src tests`:
   **a test you wrote but did not `git add` does not exist**, and a fix that lives only in the
   working tree has been lost twice in this repo already.
3. **Code review gate — bounded.** After validation, spawn one independent review subagent
   over `git diff origin/main...HEAD -- '*.ts' '*.tsx' '*.sql'`. **Precondition:** if that
   pathspec is empty (a docs-, config- or comment-only change), the gate does not run at all.
   **Verdicts:** `LGTM` and `Minor issues` are both a PASS — log the minor items in `MEMORY.md`
   and write the summary. Only `Needs fixes` earns a second round, and **there is no round 3**:
   anything still open after round 2 gets written down as a known issue, not re-reviewed.
   Prose, markdown formatting, and commit messages are permanently out of scope. See the full
   rules and spawn prompt in `CLAUDE.md`. (A `Stop` hook in `.claude/settings.json` runs the
   same gate with the same bounds.)
4. **Commit with explicit pathspecs, never `git add -A`.** Another session may be editing this
   same checkout concurrently; a blanket add has previously swept a peer's in-flight files into
   a pushed commit. Session-start `git status` is a stale snapshot.
5. Server actions return `{ success: boolean, message?: string, error?: string }` and never
   throw unhandled errors. Data-mutation UI is `"use client"` calling `"use server"` actions.
6. Supabase Realtime subscription stability is load-bearing: hooks use the `ref`-based callback
   pattern (`fetchXxxRef.current = fetchXxx`), channels use a `channelPrefix`, and `setAuth`
   must precede `subscribe`. Do not "clean up" these patterns.

## 5. Before you do anything else

Read `CLAUDE.md` in full, then `src/types/database.ts`, then `DOC_INDEX.md` — and from
`DOC_INDEX.md` only the sections relevant to your task. **Budget ~25k tokens for orientation.**
Reading `MEMORY.md` and `APP_MANIFEST.md` end-to-end costs ~340k tokens against a 200k window;
it does not fit, and the harness truncates it without telling you. After a context compaction,
do not re-read any of this.

Then report back to the user:

- which Supabase and Vercel tools you can actually see (by name), and
- the current branch, and whether the working tree is clean.

Do not begin implementation work until you have confirmed both.
