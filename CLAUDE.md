# Claude Code Directives for Badminton Queue App

## 🧠 Context & Architecture (READ FIRST)

Do not perform global codebase searches to learn the architecture. You MUST read the following files before answering architectural questions or writing code:

1. `src/types/database.ts` -> The absolute source of truth for exact Database Schemas, Tables, and Enums.
2. `APP_MANIFEST.md` -> The long-term memory for Project Structure, Core Features, UI/UX Rules, and Matchmaking Logic.
3. `MEMORY.md` -> The short-term memory for active session tracking, current bugs, and immediate next steps.
4. `@AGENTS.md` -> Framework-specific behavioral overrides.

## ⚠️ The "Autopilot" Memory System (CRITICAL MANDATE)

**YOUR MANDATORY DIRECTIVE:** Before you exit a workflow or conclude a task, you MUST autonomously update our living documents:

1. **`APP_MANIFEST.md`:** Update this if you completed a new feature or refactored logic. Explain _how_ the app works.
2. **`MEMORY.md`:** Log what was just accomplished, any remaining bugs, and the immediate next steps for the next session.

_(Note: If you alter the database, you must update `src/types/database.ts` to reflect the exact schema changes, and then summarize the logic behind the change in `APP_MANIFEST.md`.)_

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
   - All channel names must use a `channelPrefix` to avoid collisions.
4. **Database Strictness:**
   - All row types in `src/types/database.ts` MUST be `type` aliases (not `interface`).
   - Service role (`createServiceClient`) is strictly for bypassing RLS (auth, PINs, dupes). Do not use it for standard queries.

## 🛠️ Validation Workflow

Before concluding any task that modifies code, you must independently verify your work:

- Type check: `npx tsc --noEmit`
- Lint: `npm run lint`
- Build: `npm run build`

## 🔍 Code Review Gate (NEVER SKIP THIS)

After every coding task — before writing the completion summary — you MUST spawn an independent review agent. This is a **mandatory, unconditional step**, not a fallback. Do not wait for a Stop hook; spawn the agent yourself.

**THE EXACT SEQUENCE (no exceptions):**

```
1. Finish writing / applying all code changes
2. Run validation (tsc --noEmit, npm run lint)
3. ← SPAWN REVIEW AGENT HERE (see prompt below) ←
4. Wait for the agent's verdict
5. If verdict is "Needs fixes" → fix every issue, then go back to step 3
6. Only AFTER LGTM or "Minor issues" → write the completion summary
```

**HOW TO SPAWN THE REVIEW:**

```
Agent({
  description: "Independent code review",
  prompt: `Review the changes made in this task via git diff HEAD.
  Focus on: correctness of logic, edge cases, type safety, consistency
  with existing patterns in the codebase, and any regressions.
  Return one of: LGTM / Minor issues (list them) / Needs fixes (list them).
  Be direct. This is a gate — the task is not done until you sign off.`
})
```

**MANDATORY RULES:**

1. **Never write a "task complete" summary before the review agent returns a verdict.**
2. **If the verdict is "Needs fixes", address every flagged issue then re-spawn the agent.**
3. **"Minor issues" is an acceptable pass — document the issues in MEMORY.md and continue.**
4. The Stop hook may also run automatically; if it does, its verdict counts. But do NOT rely on it — always spawn manually.
