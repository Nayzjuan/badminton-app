# docs/archive — retired plans and closed history

**Nothing in this directory is current.** Every file here is one of:

- a plan for a feature that has already shipped,
- an audit or review that is fully dispositioned,
- narrative session history split out of `MEMORY.md`.

These files are kept for the **reasoning** behind a past decision, never as a description of how
the app behaves today. When they disagree with `src/`, `src/types/database.ts`, or `APP_MANIFEST.md`,
they are wrong.

## How to read this directory

`grep -rn 'thing you are looking for' docs/archive/` — never open a file end-to-end. Several are
over 100 KB, and `MEMORY_HISTORY.md` is over 600 KB.

## Why a shipped plan is dangerous, not merely stale

A plan that survives its own feature reads to the next session as *unfinished work*. This repo has
already paid for that twice: `MULTI_TENANT_PLAN.md` carried "NO CODE HAS BEEN WRITTEN" for six
weeks after multi-tenant shipped, and `ORGANIZER_PLAYER_HISTORY_PLAN.md` kept its pre-approval
header until a pending-work sweep re-inventoried a finished feature as unstarted.

Worse than a stale plan is one that promotes a design that was deliberately **rejected** — the next
reader treats the difference between plan and code as a gap to close, and reintroduces the bug.

**So: when a feature ships, move its plan here and say so at the top of the file.** Do not leave it
at the repo root with a ✅ stamp.

## What was moved here on 2026-08-19, and why

Thirty-six documents, 2 MB, that had accumulated at the repo root. Together with `MEMORY.md` and
`APP_MANIFEST.md` they made a mandated read-set of ~340k tokens against a 200k context window —
which the harness silently truncates rather than refuses. The root now holds nine markdown files.

`MEMORY_HISTORY.md` is the closed narrative history of `MEMORY.md` (2026-05 → 2026-08), including
the retired 45 KB "STANDING TO-DO" section. The items from it that were still genuinely open were
carried forward into `MEMORY.md` under **OPEN ITEMS**; everything else stayed here.
