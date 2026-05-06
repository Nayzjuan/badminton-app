# Claude Code Directives for Badminton Queue App

## 🧠 Context & Architecture (READ FIRST)
Do not perform global codebase searches to learn the architecture. You must read `APP_MANIFEST.md`, `MEMORY.md`, and `@AGENTS.md` to understand the project structure, database schema, and matchmaking logic before answering architectural questions or writing code.

## ⚠️ The "Living Manifest" Autopilot (CRITICAL MANDATE)
This project relies on a living architecture document to prevent regressions. 
**YOUR MANDATORY DIRECTIVE:** Whenever you successfully complete a new feature, refactor existing logic, or alter a database schema, **your absolute final step before exiting the workflow MUST be to update the core architecture document (`APP_MANIFEST.md`)**. 
Do not ask to update it; execute the file edit autonomously to reflect the new reality of the codebase.

## 🏗️ Strict Architectural Guardrails
1. **React & Components:**
   - Favor small, focused components (one concern per file).
   - ALL data-mutation UI must live in `"use client"` components calling `"use server"` actions. 
   - NEVER put `useState` or `useEffect` in Server Components.
2. **State & Data Flow:**
   - Server actions must return `{ success: boolean, message?: string, error?: string }`. NEVER throw unhandled errors.
   - Race conditions in concurrent fetches MUST be guarded with a monotonic sequence ref (`fetchSeq`).
3. **Supabase Realtime (DO NOT BREAK THIS):**
   - Never break the subscription stability pattern. Hooks MUST use a `ref`-based callback pattern (`fetchXxxRef.current = fetchXxx`) so the `useEffect` that wires subscriptions only re-runs when `supabase` or `sessionId` changes.
   - All channel names must use a `channelPrefix` to avoid collisions.
4. **Database Strictness:**
   - All row types in `src/types/database.ts` MUST be `type` aliases (not `interface`) to satisfy Supabase's generic constraints.
   - Service role (`createServiceClient`) is strictly for bypassing RLS (auth, PINs, dupes). Do not use it for standard queries.

## 🛠️ Validation Workflow
Before concluding any task that modifies code, you must independently verify your work by running the appropriate checks:
- Type check: `npx tsc --noEmit`
- Lint: `npm run lint`
- Build (if changing server/client boundaries): `npm run build`
