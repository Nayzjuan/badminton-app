# Digital Twin — Deep Analysis & Recommendations

**Site:** https://digital-twin-phi-three.vercel.app/  
**Reviewed:** 2026-06-02  
**Scope:** Full site crawl, source code review, feature gap analysis

---

## What's Working Exceptionally Well

Before anything else: this is one of the most impressive "living documentation" sites I've seen for a personal project. The level of craft is genuinely high.

| Element | Why It Works |
|---|---|
| **Manifest-driven architecture** | `extract.ts` pulls constants, gotchas, tables, and actions from the live source. The site stays in sync with the codebase. |
| **Interactive Sandbox** | The split-screen organizer + player phone demo is a genuine product differentiator. It makes abstract realtime flows tangible. |
| **Engine Calculators** | The priority-score slider and partnership-cap visualizer turn opaque algorithm logic into something you can *feel*. |
| **Glossary filter UI** | Severity + category + text search with debounced client-side filtering is polished and fast. |
| **Search palette** | Custom Cmd+K modal with Pagefind backend — fast, keyboard-navigable, works in production. |
| **Ref-callback pattern explainer** | The realtime page's side-by-side bad vs good code blocks are genuinely educational. |
| **Phase badges** | The Phase 2–9 progression on section cards creates a sense of a living roadmap. |

---

## Critical Gaps (Content Drift / Outdated)

### 1. Realtime broadcast catalog is missing new events

**File:** `src/pages/realtime.astro` lines 73–99  
**Issue:** The broadcast event catalog only lists 4 events:
- `organizer_intervention` (still shows old payload: `"on_deck_cleared" | "match_cancelled"`)
- `session_closed`
- `auto_matchmaking_toggled`
- `cap_saturation`

**Missing:** `active_roster_changed` (added in commit `3817157`) and `draft_cap_phase` (added in `f1c7bc8`).  
**Fix:** Update the catalog array and add the new events with emitter/listener/why entries.

### 2. Database page promises an ER diagram that doesn't exist

**File:** `src/pages/database.astro` line 57  
> "Phase 2 will add a full ER diagram with FK arrows, trigger annotations, and RLS policy summaries per table."

This has been "Phase 2 — Up Next" for a while. The table list is useful but a visual diagram would be dramatically more valuable for understanding relationships.

### 3. `actions.astro` is missing new action files

The live-match-swap actions (`live-match-swap.ts`) and the draft-cap actions (`setCapAndClearDrafts` in `sessions.ts`) are not reflected in the actions catalog. The page shows 13 action files but the codebase now has more.

### 4. Constants table is missing new constants

`MAX_AUTO_DRAFTS_LARGE`, `MAX_AUTO_DRAFTS_XLARGE`, `DRAFT_CAP_LARGE_THRESHOLD`, `DRAFT_CAP_XLARGE_THRESHOLD` are in the source but may not be in the extracted manifest (need to verify `extract.ts` picks them up).

### 5. Component graph is hardcoded, not extracted

The D3 graph in `components.astro` appears to use static data. If you add a new component (e.g., `DraftCapPopover`, `LiveSwapSheet`), it won't appear until someone manually updates the graph data.

---

## Medium-Priority Improvements

### 6. Add a Migration Timeline page

**Why:** You have 20+ migrations in `supabase/migrations/`. A chronological timeline showing:
- Migration filename + date
- One-line description
- Tables/columns affected
- Whether it added an RPC, a trigger, or a schema change

…would be incredibly useful for onboarding and for understanding how the schema evolved.

**Implementation:** Parse migration filenames (they have timestamps) and extract the first SQL comment block from each file.

### 7. Add RLS Policy Explorer

**Why:** RLS is the #1 source of silent failures in this codebase (2 Critical gotchas are RLS-related). A page that shows:
- Per-table RLS policies
- Which policies are SELECT vs INSERT vs UPDATE vs DELETE
- Which auth role each policy applies to
- The actual policy SQL (read from migrations)

…would make the RLS surface area transparent.

### 8. Add a Test Coverage Dashboard

**Why:** You have 454 passing tests. A simple page that:
- Reads `coverage/lcov.info` or `coverage/lcov-report/`
- Shows coverage % per directory (`src/app/actions/`, `src/hooks/`, `src/components/organizer/`)
- Highlights uncovered files
- Links each module to its test file

…would turn testing from an invisible virtue into a visible metric.

### 9. Global search needs a visible trigger button

**Issue:** The search palette (Cmd+K) works, but there's no visible search icon/button in the nav. Mobile users may never discover it.

**Fix:** Add a magnifying glass icon in the top nav that opens the same modal. Also add a `/search` dedicated page for accessibility.

### 10. Add "Last Updated" timestamps per page

**Why:** When documentation is "living," readers need to know if what they're reading reflects the current codebase.

**Implementation:** In `BaseLayout.astro`, read `manifest.json`'s `_lastExtracted` field and render it in the footer:  
> "Extracted from source on 2026-06-02 at 09:58 UTC"

### 11. Dark mode toggle

The site renders beautifully in dark mode but some users prefer light. You already have `lightTokens` and `darkTokens` in the manifest. A simple toggle that swaps a `data-theme` attribute on `<html>` would unlock the light theme.

---

## New Feature Recommendations (High Impact)

### 12. Schema Drift Detector ⭐

**The idea:** A page that compares the live Supabase schema (fetched via API or introspection) against the migrations and the TypeScript types. Shows:
- Columns in DB but not in `database.ts` types
- Columns in types but not in DB
- RPCs defined in SQL but not callable from the app
- RLS policies that exist in migrations but may have been dropped

**Why:** This prevents the silent "it works on my machine" problem where local schema diverges from production.

**Implementation:** Use `supabase-js` introspection or the `pg_catalog` system tables via a read-only connection.

### 13. Action Signature Reference ⭐

**The idea:** Auto-generate API-style documentation for every server action. For each action:
- Function signature (params + types)
- Return type
- Auth requirements
- Tables/RPCs it touches
- Broadcast events it emits
- Related tests

**Why:** The actions page currently just lists names. Seeing the actual signatures would make this a true API reference.

**Implementation:** Extend `extract.ts` to parse action file ASTs and extract JSDoc + parameter types.

### 14. State Machine Visualizer ⭐

**The idea:** An interactive diagram showing the `queue_status` and `match_status` state machines.
- Nodes = states (`waiting`, `on_deck`, `playing`, `left`)
- Edges = transitions (what action causes each transition)
- Click an edge → jump to the flow trace that demonstrates it

**Why:** The glossary mentions state machines but there's no visual. This would be incredibly valuable for understanding the core domain logic.

### 15. Error Message Catalog

**The idea:** A searchable catalog of every error message in the app.
- Grouped by source (server actions, RPCs, client-side)
- Severity
- When it appears
- What to do about it

**Why:** You have dozens of error strings scattered across 12+ action files. Centralizing them makes debugging faster and reveals duplicate/inconsistent messages.

**Implementation:** Regex scan of `"Failed to..."`, `"Cannot..."`, `"Not authorized..."` across `src/app/actions/`.

### 16. Dependency Graph (Module-Level)

**The idea:** A page showing imports between modules.
- `useOrganizerData` → `useOrganizerSession`, `useOrganizerCourts`, etc.
- Circular dependencies highlighted in red
- Bundle size per module

**Why:** The component graph shows UI hierarchy. A module dependency graph shows code architecture. This would help with the M-006 circular ref issue you already identified.

### 17. Performance Budget Dashboard

**The idea:** Track bundle sizes and page performance over time.
- Next.js build output analysis
- Largest components by import cost
- Image optimization status
- Core Web Vitals scores

**Why:** As the app grows, this prevents gradual bloat.

---

## Quick Wins (Low Effort, Immediate Value)

| # | Task | Effort | Impact |
|---|---|---|---|
| 1 | Add `active_roster_changed` and `draft_cap_phase` to realtime broadcast catalog | 5 min | Fixes content drift |
| 2 | Add search icon to nav | 10 min | Improves discoverability |
| 3 | Add "Last extracted" timestamp to page footer | 5 min | Builds trust |
| 4 | Create `README.md` for the digital twin | 15 min | Helps future you / collaborators |
| 5 | Add `live-match-swap.ts` to actions catalog | 5 min | Fixes content drift |
| 6 | Verify `extract.ts` picks up new constants (`DRAFT_CAP_*`) | 10 min | Prevents silent extraction gaps |
| 7 | Add a `/search` page (not just modal) | 20 min | Accessibility + SEO |
| 8 | Add OpenGraph images per section | 30 min | Social sharing looks professional |

---

## Structural / Architectural Recommendations

### 18. The manifest.json is 64KB — consider code-splitting

`manifest.json` is loaded on every page (it's imported by `glossary.astro`, `engine.astro`, etc.). At 64KB parsed + 2181 lines, it will block initial render.

**Options:**
- Split into per-page chunks (`manifest.database.json`, `manifest.engine.json`)
- Or load it asynchronously via `fetch()` instead of `import`
- Or use Astro's `getStaticPaths` to inline only the needed data at build time

### 19. Add a CI check for extract freshness

**The idea:** A GitHub Actions workflow that runs `npm run extract` in the digital twin directory and fails if `manifest.json` has uncommitted changes. This prevents the site from drifting behind the source.

### 20. Link from code comments back to Digital Twin

**The idea:** In your main app's source files, add comments like:
```ts
// See: https://digital-twin-phi-three.vercel.app/engine#toctou
// See: https://digital-twin-phi-three.vercel.app/realtime#ref-callback
```

This creates bidirectional links: the twin documents the code, and the code points to the twin.

---

## Prioritized Roadmap

If I were maintaining this, here's what I'd do in order:

### Week 1 — Content Drift Fix
- [ ] Update realtime broadcast catalog (missing events)
- [ ] Add new actions to actions catalog
- [ ] Verify constants extraction
- [ ] Add "Last extracted" timestamp
- [ ] Write `README.md`

### Week 2 — Discoverability
- [ ] Add search icon to nav
- [ ] Add `/search` page
- [ ] Add OpenGraph meta tags
- [ ] Add dark mode toggle (you already have the tokens!)

### Week 3 — New Pages
- [ ] Migration Timeline
- [ ] RLS Policy Explorer
- [ ] State Machine Visualizer

### Month 2 — Advanced Features
- [ ] Schema Drift Detector
- [ ] Action Signature Reference
- [ ] Error Message Catalog
- [ ] Test Coverage Dashboard

---

## Summary

The Digital Twin is already a genuinely impressive piece of documentation engineering. The interactive elements (sandbox, calculators, component graph, flow traces) elevate it far beyond a typical docs site.

The main risks are **content drift** (the source evolves faster than the twin updates) and **missing structural documentation** (RLS, migrations, state machines). Fixing the drift issues is a 30-minute task. Adding the structural pages would make this a reference that new developers can use to become productive in hours rather than days.
