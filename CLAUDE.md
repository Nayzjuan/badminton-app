# Claude Code Directives for Badminton Queue App

## 🧠 Context & Architecture (READ FIRST)

Do not perform global codebase searches to learn the architecture. Read, in this order:

1. `src/types/database.ts` — the source of truth for Schemas, Tables, and Enums. Read it whole.
2. `DOC_INDEX.md` — a heading → file → line-range map of `APP_MANIFEST.md` and `MEMORY.md`.
   **Read the index, then read only the sections it points at.** Budget ~25k tokens.
3. `MEMORY.md` — current state only: the migration queue, standing to-do, open items.
4. `@AGENTS.md` — framework-specific behavioral overrides.

**Do NOT read `APP_MANIFEST.md` or the archives end-to-end.** They are reference works,
not briefings. Reading them whole exceeds the context window, which does not fail loudly —
it silently truncates, and what gets dropped is whatever sits at the end of the file.

**After a context compaction, do NOT re-read the living documents.** Re-read only the
source files you are actively editing.

## ⚠️ The "Autopilot" Memory System

Before concluding a task, update the living documents — but note what each is FOR:

1. **`APP_MANIFEST.md`** — how the app works **right now**, in the present tense.
   Update the section that describes the behaviour you changed. It is a reference work,
   not a changelog.
2. **`MEMORY.md`** — **current state only**: what is still open, what is queued, what the
   next session must not re-derive. Cap: **40 KB**, enforced by `.husky/pre-commit`.
   Append at most ~15 lines. When an entry is stamped ✅ SHIPPED / CLOSED, move it to
   `docs/archive/` at the next task rather than leaving it in place.
3. **Incident write-ups go to `docs/incidents/YYYY-MM-DD-slug.md`**, one file each, with a
   one-line pointer from the manifest section they explain.

_(If you alter the database, update `src/types/database.ts` to the exact schema change, and
summarize the logic in `APP_MANIFEST.md`.)_

## ✍️ Writing rules for the living documents

These exist because stale prose is this repo's most-repeated defect, and because a wrong
correction costs more than the wrong claim it replaced.

1. **Never state a count of code sites in prose.** State the command that produces it —
   `rg -c 'isSessionOrganizer\(' src/` — so the reader recomputes it.
2. **Cite symbols, not line numbers.** `matchmaking-core.ts` (`isRedZonePlayer`), never
   `matchmaking-core.ts:1421`.
3. **Never write a self-referential offset** — "at the bottom of this file", "the section
   above". The file moves underneath you.
4. **Markdown wrapping and whitespace are NOT defects.** `*.md` is in `.prettierignore` by
   deliberate decision (`7f332c7`). Nothing checks prose width and nothing should.
5. **A correction carries the same burden of proof as the claim it corrects.** If you cannot
   verify the replacement, delete the claim instead of restating it.
6. **A section heading containing a date is a defect in `APP_MANIFEST.md`.** Dated narrative
   belongs in `docs/incidents/`.
7. **A plan is deleted — not stamped — when its feature ships.** A doc that promotes a
   design that was deliberately rejected is worse than a stale one: the next reader "closes
   the gap" and reintroduces the bug.

## 🏗️ Strict Architectural Guardrails

1. **React & Components:**
   - Favor small, focused components (one concern per file).
   - ALL data-mutation UI must live in `"use client"` components calling `"use server"` actions.
   - NEVER put `useState` or `useEffect` in Server Components.
2. **State & Data Flow:**
   - Server actions must return `{ success: boolean, message?: string, error?: string }`. NEVER throw unhandled errors.
   - Race conditions in concurrent fetches MUST be guarded with a monotonic sequence ref (`fetchSeq`).
3. **Supabase Realtime (DO NOT BREAK THIS):**
   - Never break the subscription stability pattern. Hooks MUST use a `ref`-based callback pattern (`fetchXxxRef.current = fetchXxx`).
   - All channel names must use a `channelPrefix`; `setAuth` must precede `subscribe`.
4. **Database Strictness:**
   - All row types in `src/types/database.ts` MUST be `type` aliases (not `interface`).
   - Service role (`createServiceClient`) is strictly for bypassing RLS (auth, PINs, dupes). Do not use it for standard queries.
   - Authorize *before* any lookup, bind the write to the id you authorized, and express the
     guard as ONE condition with ONE return so the branches cannot drift.
5. **Migrations are applied BY HAND.** Merging ships TypeScript only. Verify the prod stamp
   via `list_migrations` — never the build, which stays green without the migration.

## 🛠️ Validation Workflow

Run before concluding any task that modifies code. Total ≈ 17 seconds — this is not the bottleneck.

1. `npx tsc --noEmit` — ~2 s, must be 0 errors
2. `npm run lint` — ~10 s, must exit 0
3. `npm run test:unit` — ~6 s, must be 0 failures. **NOT optional.**
4. `npm run build` — only when routes, config, or dependencies changed

Then run `git status --porcelain -- src tests`.

**A test you wrote but did not `git add` does not exist.** CI checks out the git tree and the
`Stop` hook reads `git diff`; neither sees an untracked file. A task is not complete until
that command is empty and the work is on a **pushed** branch. If you cannot commit or push,
say so explicitly in the summary and record it in `MEMORY.md` as UNCOMMITTED — a completed
fix that lives only in the working tree has been lost twice in this repo already.

## 🧪 Test requirements

A PR that adds a new status, enum value, or lifecycle stage MUST include a test asserting a
transition **out** of it, driving the object from creation to its terminal state. Proving a
row can be *created* is not proving the feature works: cross-court held drafts passed their
generation tests and then could not be published even once in production.

Do not set lifecycle columns by hand in a test that claims to cover the lifecycle. If the
test writes `held_ready_at` itself, it has not tested the code that writes `held_ready_at`.

## 🔍 Code Review Gate

After a task that changes executable code, spawn one independent review agent before writing
the completion summary.

**Precondition.** Run `git diff origin/main...HEAD --name-only`. If no `.ts` / `.tsx` / `.sql`
file changed outside of comments, **the gate does not run.** Documentation accuracy is not a
merge gate.

1. Finish applying all code changes.
2. Run the Validation Workflow. It must be clean.
3. Spawn review round 1.
4. **Fix every finding it returns, at every severity.** A verdict is a work list, not a
   grade. "Minor issues" means the items are *small*, not that they are *optional* —
   there is no severity that authorizes skipping a fix. The only things you may leave
   alone are the ones the OUT OF SCOPE list below says are not defects at all.
5. Spawn review round 2 to verify the fixes. Fix everything it returns, the same way.
6. **HARD CAP: there is no round 3.** The cap bounds *reviewing*, not *fixing* — those
   are different acts, and conflating them is what produced five-round tasks. Fix
   without limit; re-review at most twice.

**Anything still unfixed after round 2 must be handed over WITH A REASON.** A bare list is
not a handoff — the reader cannot tell a blocked item from an abandoned one. For each item
state, in this order:

  - what the finding is, and the command or test that demonstrates it
  - **why it is not fixed**, using one of the five admissible reasons below
  - what you already tried, and what it did
  - the smallest next step that would resolve it, and who can take it

**The five admissible reasons.** Nothing else counts:

  1. **Needs a decision that is not mine** — the fix is a product, UX, or priority
     tradeoff with no technically-correct answer. State the options and your recommendation.
  2. **Needs access I do not have** — a production write, a live session, a device, a
     credential, a paid plan feature.
  3. **Correct but unverifiable here** — the fix is written and committed, but nothing in
     this environment can prove it (needs real traffic, a live close, a second club).
     Say the fix shipped unverified; do not imply it is confirmed.
  4. **Out of scope by size** — fixing it would change behaviour well beyond this task and
     belongs in its own branch. Name the branch you would open.
  5. **The two rounds disagree** — round 2 contradicts round 1's fix and there is no
     adjudicator. Give both positions and your reading. This is the *only* reason that is
     about the review process rather than the code, and it should be rare.

"It seemed minor", "I ran out of rounds", and "the reviewer may be wrong" are **not**
admissible. The first two are what step 4 exists to prevent; the third is a claim you must
either substantiate — reproduce the finding and show it does not hold — or act on.

**Commit messages are permanently out of scope.** PRs are squash-merged; intermediate
messages are discarded. Never spend a round correcting one.

**Prose is out of scope, and that is what the cap protects.** A finding that lands in text an
earlier round of this same task authored is not a defect to fix — corrections that correct
corrections do not converge, because nothing executes a sentence. This is a statement about
*text*. It is never a reason to leave a code finding unfixed.

**Spawn prompt — note the pathspec and the exclusions:**

```
Review this task's changes:
  git diff origin/main...HEAD -- '*.ts' '*.tsx' '*.sql'

OUT OF SCOPE — these are not defects, do not report them:
  - Markdown, comments, docstrings, commit messages
  - Line wrapping, whitespace, prose phrasing
  - Counts, tallies or dates stated in prose
  - Anything in APP_MANIFEST.md or MEMORY.md

IN SCOPE: logic correctness, edge cases, type safety, React rules of hooks,
consistency with existing patterns in src/, regressions.

Every finding must be expressible as a failing test, a failing `npx tsc --noEmit`,
or a reproducible command. State that expression with the finding. If you cannot
express it that way, label the finding UNSURE and say what you would need to
settle it.

EVERY FINDING YOU RETURN WILL BE FIXED — there is no severity that gets skipped.
So do not pad the list. A speculative finding is not free; it costs a real edit
to real code. Report what you can substantiate, and nothing else. An empty list
is a legitimate and useful answer.

Return a list. For each finding: SEVERITY (BLOCKER / MINOR / UNSURE), the file,
what is wrong, and the reproduction. Severity orders the work — it does not
decide whether the work happens. Be direct.
```

A `Stop` hook in `.claude/settings.json` runs the same gate automatically and applies the
same precondition. Its verdict counts.

## 🤝 Working in this checkout

**Commit with explicit pathspecs, never `git add -A`.** Another session may be editing this
same checkout concurrently; a blanket add has previously swept a peer's in-flight files into
a pushed commit. Session-start `git status` is a stale snapshot.
