# Plan: Per-Session Auto-Publish Mode (skip the draft gate)

## The one-line truth

The entire pipeline is **already fully automatic downstream of publish.** When a court frees up, `endMatchAction → promoteOnDeckMatchInternal` already promotes the oldest on-deck match onto the court and fires `COURT_CALL`. The **only** manual gate left in the whole system is the publish step (draft → on-deck).

> **Auto-publish mode = the engine writes `is_published=true` instead of `is_published=false`.** Nothing else downstream changes.

This makes the feature small in concept but it has a **hidden trap**: there are 5 separate places that all assume `is_published=false` for engine output. Flip the toggle without touching all 5 and the DB updates, the UI updates, but the engine keeps making drafts — the feature silently no-ops.

---

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Toggle scope | **Per-session** — new `auto_publish boolean` column on `sessions` |
| D2 | The number control | **Reuse `max_auto_drafts_override`** (no new column). UI label swaps contextually: "Draft Queue Size" ↔ "On-Deck Cap" |
| D3 | Flip ON → existing drafts | **Clear & refill** — clear unpublished drafts, re-run engine which now auto-publishes |
| D4 | Flip OFF → live on-deck | **Leave them alone** — they're committed; engine generates drafts for the *next* batch only |
| D5 | Toggle placement | Organizer header, beside the auto-matchmaking toggle + cap chip |
| D6 | Auto-published matches fire `ON_DECK_WARNING`? | **Yes** — players genuinely are on deck now |
| D7 | Left/conflict safety | **Preserve it** — auto-publish must not let a left player reach a court |
| D8 | Flip ON fills immediately? | **Yes** — run engine inline, fill on-deck right away |
| D9 | Confirm dialog on flip ON | **Yes, only if drafts exist** — "This clears N unreviewed drafts" |
| D10 | Provenance | **Unchanged** — auto-published matches keep `created_method='auto'` |
| D11 | Auto-mm dependency | **Disable the toggle when auto-matchmaking is OFF** (tooltip: "Enable Auto-Matchmaking first"). Engine is paused otherwise. |
| D12 | Held cross-court drafts | **Auto-publish them at READINESS, not at creation** — see verdict below |

---

## Held-draft safety verdict (investigated separately, high confidence)

Question: is it safe to auto-publish held cross-court drafts? **The core mechanics are already safe; a naive "write `is_published=true` at creation" is NOT.**

**What's already safe (no change needed):**
- The held RPC **never touches the pulled player's `queue_entries`** — they stay `playing` and finish their game. Publishing the held draft does not disturb them.
- The promotion readiness gate (`held_ready_at`) is **independent of `is_published`** — an unready held draft is **skipped for court promotion even if published**. So auto-publishing can't yank a still-playing player onto a court early.
- Guard 1b allows only **one** pending held draft per pulled player; `recomputeHeldReadiness` still stamps `held_ready_at` correctly regardless of publish state.

**Why naive creation-time auto-publish breaks (the real gaps):**
1. The held RPC has **no `p_is_published` param** AND **no `drafted→on_deck` branch** — unlike `create_match_with_players`, it only ever sets the 3 waiting members to `drafted`. Flip `is_published=true` and they'd show as published but stay `drafted` → ghost-availability (R3-1) risk.
2. `ON_DECK_WARNING` is fired by the **server action**, not the RPC — so the engine path fires **no push at all** unless we add it. *(This actually applies to normal auto-published matches too — folded into the engine work.)*
3. Pinging at creation would alert the **pulled player while they're still mid-game** on another court — wrong.

**Chosen approach (D12) — auto-publish held drafts at readiness, not creation:**
- Held draft is created `is_published=false` as today (stays hidden, in the organizer's held lane).
- When `recomputeHeldReadiness` stamps `held_ready_at` (the pulled player's source match completes → they're now free), **auto-publish it then**: flip `is_published=true`, transition all 4 to `on_deck`, fire `ON_DECK_WARNING` to all 4 (now all genuinely available).
- **Result:** no premature ping, no unpromotable on-deck clutter, no still-playing player disturbed. Honors "auto-publish everything" intent without any of the creation-time hazards.
- *(Alternative A1 — auto-publish held at creation — is possible but needs an RPC `on_deck` branch + selective 3-of-4 notification + accepts an unpromotable on-deck card showing until ready. More code, more rough edges. Not recommended.)*

---

## ⚠️ The critical cluster — must ship together

These 5 edits are interdependent. Any one missing = silent failure. (Verified against the real code.)

| # | File · symbol | Today | Change |
|---|---|---|---|
| C1 | `src/types/database.ts` · `Session` | no `auto_publish` field | add `auto_publish: boolean` (+ in `SessionUpdate`). **Without this, TS drops the column → always falsy → toggle does nothing.** |
| C2 | `matchmaking.ts` · `runEngineInternal` session SELECT (~L351) | selects only `max_auto_drafts_override` | also select `auto_publish`. **Without this the engine never sees the toggle, even right after it flips.** |
| C3 | `matchmaking.ts` · cap-count query (~L346-350) | hardcoded `.eq('is_published', false)` | branch: auto mode counts `is_published=true`. **Without this, auto mode counts 0 drafts and generates UNBOUNDED on-deck matches, flooding the courts.** ← most dangerous bug |
| C4 | `matchmaking-db.ts` · `executeMatch` (~L398) | hardcoded `p_is_published: false` | add `autoPublish` param; pass `p_is_published: autoPublish`. The `create_match_with_players` RPC **already accepts** `p_is_published` — no RPC change needed here. |
| C5 | `matchmaking.ts` · `executeMatch` call (~L549) | calls with no publish flag | pass `sessionRow.auto_publish` through |

---

## Phased implementation

### Phase 0 — Schema + types
- New migration `…_add_auto_publish_mode.sql`: `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auto_publish boolean NOT NULL DEFAULT false;` + comment. Lands after `20260602000000`. All existing sessions default to draft mode (zero behavior change).
- `database.ts`: **C1** (Session + SessionUpdate).

### Phase 1 — Engine core (the heart)
- **C2, C3, C4, C5** above.
- New pure helper in `matchmaking-core.ts`: `shouldAutoPublishMatch(autoPublish): boolean` — trivial, but keeps the branch unit-testable and named, alongside `getDynamicDraftCap`.
- The dynamic cap thresholds (3/5/6) stay — same numbers, new meaning (max on-deck instead of max drafts).
- Soft gate (small-pool hold) is **not** bypassed by auto mode — it still defers generation for diversity.
- **`ON_DECK_WARNING` push:** today the push lives in `publishMatchAction` (the server action), **not** in the create RPC. The engine path bypasses it, so auto-published matches must **explicitly fire `ON_DECK_WARNING`** to the roster after a successful auto-publish (via `after()`), or players never learn they're on deck. Applies to normal *and* held auto-published matches.

### Phase 2 — Held drafts auto-publish at readiness (D12)
- Held drafts are still **created `is_published=false`** (no held-RPC signature change for creation).
- In `recomputeHeldReadiness` / the `endMatchAction` completion path: when a held draft becomes ready (`held_ready_at` stamped) **and** `session.auto_publish` is on, auto-publish it — flip `is_published=true`, transition all 4 roster members `→ on_deck`, and fire `ON_DECK_WARNING` to all 4. Reuse the existing `publish_match` RPC (it already does the `is_published` flip + `on_deck` transition + is the natural home), or a thin internal equivalent.
- In draft mode this path is unchanged — held drafts wait for manual publish.

### Phase 3 — Toggle server action
- New `toggleAutoPublish(sessionId)` in `sessions.ts`, modeled on `setCapAndClearDrafts` + `toggleAutoMatchmaking`:
  - auth + `isSessionOrganizer`
  - atomic `UPDATE … SET auto_publish = $new RETURNING auto_publish` (confirms the write landed before the engine reads it)
  - **ON flip (D3):** `clearAllUnpublishedDrafts` → `runEngineForSession` (now auto-publishes up to cap, D8)
  - **OFF flip (D4):** persist only; do **not** touch live on-deck
  - returns `{ success, message?, error?, autoPublishIsOn?, clearedCount? }`
- New broadcast `broadcastAutoPublishToggled(sessionId, isOn)` for co-organizer sync; client listener in the organizer hook (mirrors the auto-matchmaking toggle listener).
- `setCapAndClearDrafts`: in auto mode, skip the no-op draft-clear and leave live on-deck alone (consistent with D4).

### Phase 4 — Safety hardening (D7)
The engine's pool is already `status='waiting'`, and `create_match_with_players` Guards 0–2 already reject left/conflicted players **atomically at write time** — so auto-publish at *creation* is already as safe as the manual publish path. The residual gap is a player who leaves *after* auto-publish but *before* court promotion.
- Add a **pre-promotion left-player check** in `promoteOnDeckMatchInternal`: if any roster player is `status='left'`, skip/cancel that on-deck match and move to the next. Prevents ghost players on court. (This is the minimal, correct fix — *not* the new-RPC approach an over-eager analysis suggested.)

### Phase 5 — UI (per `impeccable` guidelines)
- **Toggle** in the header next to auto-matchmaking + cap chip (D5); off = grey "Publish" pill, on = accent "Auto" pill; disabled when auto-mm is off *(NEW-2)* or during a cap reset.
- **Confirm dialog** on ON flip *(D9)*, only when drafts exist, with the count: "This clears N unreviewed drafts and starts auto-publishing."
- **Cap chip label swap** *(D2)*: "Draft Queue Size" → "On-Deck Cap" driven by `auto_publish`.
- **On-deck panel**: when auto is on, hide the dashed Drafts section, the section divider, and the "Publish All" banner; the published On-Deck section becomes the whole view. Derive `autoPublishIsOn` from `liveSession.auto_publish` so UI and engine can't drift.
- **Sortable card**: defensively disable the per-card Publish button in auto mode.
- No border-left stripes, no gradient text, tinted neutrals (house style).

### Phase 6 — Tests + gate
- **Pure (Vitest):** `shouldAutoPublishMatch` (AP-1/2); add to `matchmaking-core.test.ts`.
- **Engine (mocked Supabase):** `executeMatch` receives `p_is_published=true` when auto, `false` when draft, `false` when `auto_publish` null; **cap-count query swaps sets by mode** (the C3 regression guard); soft gate still applies in auto mode. Add to `matchmaking-engine.test.ts` (ENG-AP-*).
- **Toggle action (mocked):** ON clears + reruns; OFF leaves live alone; idempotent double-toggle; co-organizer allowed. New `auto-publish-session-action.test.ts` mirroring `publish-engine-trigger.test.ts`.
- **Manual/integration checklist** (not Vitest): real RPC writes on-deck not drafts; held-draft behavior per NEW-1; multi-court promotion order; push delivery.
- `tsc --noEmit` + `npm run lint` + **independent review-agent gate** (CLAUDE.md mandate) before any "done."

---

## Risks accepted for v1
- **Concurrency overage:** two engine runs on separate Vercel workers can both read the on-deck count before either writes → up to ~1–2 matches over cap. Same soft-cap behavior that exists today; document "cap is a soft limit."
- **Double-notify timing:** a player can get `ON_DECK_WARNING` then `COURT_CALL` seconds apart when a freed court immediately promotes their just-published match. Correct outcome, slightly chatty. Consolidating both into one `match_event` push topic is a fast-follow, not v1.

---

## Files touched (summary)

| File | Phase | Change |
|---|---|---|
| `supabase/migrations/…_add_auto_publish_mode.sql` | 0 | new column |
| `supabase/migrations/…_held_is_published.sql` | 2 | held RPC param *(NEW-1=A only)* |
| `src/types/database.ts` | 0 | Session + SessionUpdate |
| `src/lib/matchmaking-core.ts` | 1 | `shouldAutoPublishMatch` helper |
| `src/lib/matchmaking-db.ts` | 1,2 | `executeMatch` (+`executeHeldMatch`) `autoPublish` param |
| `src/app/actions/matchmaking.ts` | 1,4 | session SELECT, cap-count branch, call site, pre-promotion left check |
| `src/app/actions/sessions.ts` | 3 | `toggleAutoPublish`, cap-clear branch |
| `src/lib/broadcast.ts` | 3 | `broadcastAutoPublishToggled` |
| `src/components/organizer/organizer-dashboard.tsx` | 5 | header toggle + confirm dialog |
| `src/components/organizer/draft-cap-popover.tsx` | 5 | contextual label |
| `src/components/organizer/on-deck-panel.tsx` | 5 | hide draft UI in auto mode |
| `src/components/organizer/sortable-card.tsx` | 5 | disable publish button |
| `src/hooks/use-organizer-dashboard.ts` | 5 | toggle state + broadcast listener |
| `tests/unit/matchmaking-core.test.ts` | 6 | AP-* |
| `tests/unit/matchmaking-engine.test.ts` | 6 | ENG-AP-* |
| `tests/unit/auto-publish-session-action.test.ts` | 6 | new |
