@AGENTS.md

# Badminton Queue & Matchmaking App

## What We're Building
A real-time badminton session manager for gym organizers and players. Organizers create sessions, manage courts, and control matchmaking. Players join anonymously, queue up, and get matched into doubles games automatically.

## Stack
- **Framework**: Next.js (App Router, Server Components, Server Actions — `"use server"` / `"use client"`)
- **Backend**: Supabase — anonymous Auth, Postgres, Realtime subscriptions
- **Styling**: Tailwind CSS v4 + Shadcn UI (Alert Dialog, Dialog, etc.)
- **Language**: TypeScript (strict)

## Project Structure
```
src/
  app/
    actions/        # Server actions (auth, match, matchmaking, queue, profile, sessions)
    organizer/      # Organizer pages & dashboard
    play/           # Player pages, session lobby, /play/join QR entry
    page.tsx        # Root — auto-routes authenticated users to active session
  components/
    organizer/      # OrganizerDashboard, ActiveCourts, QueueControl, MatchHistoryPanel, ShareSessionDialog, …
    player/         # PlayerDashboard, MatchAlert, QueueToggle, WaitlistTab, LiveCourtsTab, …
    ui/             # Shadcn primitives + custom SkillBadge
    login-form.tsx  # Anonymous auth form (name + skill + 4-digit PIN)
  hooks/
    use-organizer-data.ts   # All organizer real-time state (courts, queue, matches)
    use-session-data.ts     # Player-side read-only session state
    use-queue.ts            # Player's own queue entry + join/leave actions
    use-player-match.ts     # Player's current match assignment
  lib/
    realtime.ts     # Supabase channel subscriptions (courts, queue, matches, match_players, profiles)
    constants.ts    # PLAYERS_PER_MATCH = 4, skill window, etc.
  types/
    database.ts     # All row types, enums, Database schema for Supabase client
  utils/
    supabase/
      client.ts     # Browser Supabase client
      server.ts     # Server Supabase client (cookies)
      service.ts    # Service role client (bypasses RLS — admin operations only)
```

## Core Features
- **Real-time queue**: Players join/leave; organizer sees live updates via Supabase Realtime
- **Skill-based matchmaking**: Automated on-deck match generation within a ±2 skill-level window; mixed-level flag when breached
- **Organizer dashboard**: Live courts tab, queue & match control, wait-time monitor, match history with edit/undo score
- **Player dashboard**: My Status (queue position + score submission), Live Courts, Waitlist tabs
- **Anonymous auth + PIN reconnect**: Players sign in anonymously; 4-digit PIN lets them reclaim their identity after browser close
- **Player self-scoring**: Any player in an in_progress match can submit the final score
- **QR-code session joining**: Organizer shares a QR / link → `/play/join?session=[id]` pre-wires registration to that session
- **Checkout / Leave Session**: Players can self-checkout; organizer can checkout players from the queue control

## Key Architectural Rules

### React & Components
- Favor small, focused components — one concern per file
- All data-mutation UI lives in `"use client"` components calling `"use server"` actions
- Never put `useState` / `useEffect` in Server Components

### Supabase Realtime
- **Never break the subscription stability pattern.** Hooks use a `ref`-based callback pattern (`fetchXxxRef.current = fetchXxx`) so the `useEffect` that wires subscriptions only re-runs when `supabase` or `sessionId` changes — not on every state update
- All channel names use a `channelPrefix` to avoid collisions between hooks on the same page
- `subscribeToProfiles` has no session_id filter (profile updates are global)

### State & Data Flow
- Server actions return `{ success, message/error }` — never throw
- Race conditions in concurrent fetches are guarded with a monotonic sequence ref (`fetchSeq`)
- The service role client (`createServiceClient`) is only used in server actions that need to bypass RLS (reconnect identity migration, duplicate name checks, PIN management)

### Matchmaking
- Queue sorted by `(games_played ASC, joined_at ASC)` — fewest games played first
- On-deck matches are `status = "pending"`; active court matches are `status = "in_progress"`
- `promoteOnDeckMatchInternal` auto-fills a freed court; `generateOnDeckMatchesAction` refills the pending pool
- Inherited Games logic prevents late joiners from jumping to position #1

### Database
- All row types in `src/types/database.ts` are `type` aliases (not `interface`) to satisfy Supabase's generic constraints
- `queue_entries.status`: `waiting | on_deck | playing | left`
- `matches.status`: `pending | in_progress | completed | cancelled`
