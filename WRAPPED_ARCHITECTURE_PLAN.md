# WRAPPED_ARCHITECTURE_PLAN.md — Refined v2

## Session Wrapped — Technical Architecture Plan

> **Status:** Awaiting approval — NO code written yet.
> **Revision:** v2, incorporating Q&A answers
> **Scope:** End-to-end design for the "Session Wrapped" feature

---

## Design Decisions (Locked)

| Question | Decision |
|----------|----------|
| Scoring format | Primary: 31-point single game. Flexible — algorithm auto-detects format from `sessions.scoring`. Multi-set sessions use `match_games` for per-game analysis. |
| Awards per player | No cap — earn as many as you qualify for |
| Comedic awards | Always on, cannot be disabled |
| Unearnable awards | Silently hidden — no "locked" state shown |
| All-time career awards | **Excluded from this build** — session-scoped only |
| Nemesis cross-session H2H | Included — Nemesis shows lifetime head-to-head record |
| Partner skill badge | Shown on both the player's card and the partner's card |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Database Audit & Schema Notes](#2-database-audit--schema-notes)
3. [Pillar 1 — Scoring Format Detection](#pillar-1--scoring-format-detection)
4. [Pillar 2 — Data Aggregation Strategy](#pillar-2--data-aggregation-strategy)
5. [Pillar 3 — The Full Awards Catalogue](#pillar-3--the-full-awards-catalogue)
6. [Pillar 4 — Award Computation Logic](#pillar-4--award-computation-logic)
7. [Pillar 5 — Real-Time Routing & Flow](#pillar-5--real-time-routing--flow)
8. [Pillar 6 — UI & Shareability](#pillar-6--ui--shareability)
9. [Implementation Order](#implementation-order)
10. [Remaining Risks & Edge Cases](#remaining-risks--edge-cases)

---

## 1. Executive Summary

Session Wrapped fires the moment an organizer closes a session. Every connected player is redirected to a personalized, story-style summary of their stats, awards, and relationships — shareable to social media. Three core engineering challenges:

1. **Concurrency risk** — All players land on `/wrapped` simultaneously. Stats must be pre-computed during `closeSession()`, not re-calculated per request.
2. **Routing gap** — Nothing currently notifies players when a session ends. We extend the existing `session-events` broadcast channel with a `session_closed` event.
3. **Award diversity** — The award system must produce genuinely different results each session, not the same 3 awards for the same 3 people. The catalogue below contains 45 distinct awards across 12 categories.

---

## 2. Database Audit & Schema Notes

### Tables Used

| Table | Key Columns | Notes |
|-------|-------------|-------|
| `matches` | `id, session_id, status, team_a_score, team_b_score, is_mixed_level, court_id, created_at, started_at, completed_at` | Primary results table |
| `match_players` | `match_id, player_id, team` | Links players ↔ matches, also used for cross-session Nemesis query |
| `match_games` | `match_id, game_number, team_a_score, team_b_score, completed_at` | Used for multi-set sessions (best_of_3, best_of_5) |
| `sessions` | `id, scoring, is_active, ended_at` | `scoring` drives format detection |
| `profiles` | `id, display_name, skill_level` | Identity + skill badge on partner/nemesis cards |
| `queue_entries` | `player_id, session_id, status, joined_at, games_played, is_paused` | Queue timing data for bench-time awards |

### Existing Assets to Reuse

- `v_session_leaderboard` — already computes `games_played`, `wins`, `losses`, `points_for`, `points_against`, `point_diff`, `win_pct`. Wrapped base stats reuse this view directly.
- `get_player_streaks(p_session_id)` RPC — already computes session-scoped win streak.
- `session-events:{sessionId}` Realtime broadcast channel — already subscribed by every player.

### What Doesn't Exist Yet

- `session_wrapped_stats` table (pre-computed per-player results)
- `compute_session_wrapped(p_session_id)` Postgres RPC
- `session_closed` broadcast event type
- `/wrapped/[sessionId]/[playerId]` route

---

## Pillar 1 — Scoring Format Detection

The scoring format determines what thresholds are "interesting" for score-based awards. Rather than hardcoding 21 or 31, the algorithm uses **adaptive thresholds** derived from the session's `scoring` field and the actual score data.

### Format Resolution Table

| `sessions.scoring` | Score Source | Winning Score Reference | Close Game Threshold | Dominant Win Threshold | Near-Shutout Threshold |
|--------------------|-------------|-------------------------|----------------------|-----------------------|------------------------|
| `single` | `matches.team_a_score / team_b_score` | Inferred from MAX(winning score) across session — typically 31 | Margin ≤ 3 pts | Margin ≥ 15 pts | Loser scored ≤ 10 pts |
| `best_of_3` | Match level: `matches.*`; Game level: `match_games.*` | 2 games wins the match | Match decided by 3rd game | One team wins 2-0 | Any individual game ≤ 5 pts to loser |
| `best_of_5` | Same as above | 3 games wins the match | Match decided by 5th game | One team wins 3-0 | Any individual game ≤ 5 pts to loser |

### Winning Score Inference for Single-Game

Since the schema has no explicit `target_score` field, the RPC infers it:

```sql
-- For the current session, find the most common maximum score in completed matches.
-- In a 31-point game, most winning scores cluster at 31.
-- In a 21-point game, they cluster at 21.
v_winning_score = MODE() WITHIN GROUP (ORDER BY GREATEST(team_a_score, team_b_score))
  FROM matches
  WHERE session_id = p_session_id AND status = 'completed'
```

All threshold math (margin ≤ 3, margin ≥ 15, loser ≤ 10) uses `v_winning_score` as the reference. This means the thresholds automatically scale: in a 31-point gym, "near-shutout" is ≤ 10; in a 21-point gym, the same percentage would be ≤ 7.

---

## Pillar 2 — Data Aggregation Strategy

### Decision: Pre-Compute in `closeSession()`, Not On-the-Fly

When a session closes with 20+ players, all browsers receive the redirect simultaneously. On-demand calculation would trigger concurrent server renders all querying the same tables. Pre-computing eliminates this entirely.

**Execution order inside the updated `closeSession()`:**

```
Step 0 (NEW): compute_session_wrapped(sessionId)
  → Writes one row per player into session_wrapped_stats
  → Non-blocking on failure: session closes regardless; players see empty state gracefully

Step 1: Cancel active matches
Step 2: Dequeue all players  
Step 3: Close all courts
Step 4: Mark session inactive (is_active = false, ended_at = NOW())

Step 5 (NEW): broadcastSessionClosed(sessionId)
  → Fires ONLY after Step 0 returns — guarantees rows exist before redirect
```

### New Table: `session_wrapped_stats`

```sql
CREATE TABLE session_wrapped_stats (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  computed_at  timestamptz NOT NULL DEFAULT now(),

  -- Base stats (sourced from v_session_leaderboard)
  games_played  integer NOT NULL DEFAULT 0,
  wins          integer NOT NULL DEFAULT 0,
  losses        integer NOT NULL DEFAULT 0,
  points_for    integer NOT NULL DEFAULT 0,
  points_against integer NOT NULL DEFAULT 0,
  point_diff    integer GENERATED ALWAYS AS (points_for - points_against) STORED,
  win_pct       numeric(5,2) NOT NULL DEFAULT 0,
  win_streak    integer NOT NULL DEFAULT 0,
  session_rank  integer,

  -- Award codes: array of award_key strings the player earned
  -- e.g. ['marathoner', 'ice_in_veins', 'generous']
  earned_awards  text[] NOT NULL DEFAULT '{}',

  -- Award detail payloads (JSONB, one key per award that needs extra display data)
  award_data     jsonb NOT NULL DEFAULT '{}',

  UNIQUE (session_id, player_id)
);

ALTER TABLE session_wrapped_stats ENABLE ROW LEVEL SECURITY;

-- Players read only their own row
CREATE POLICY "Player reads own wrapped"
  ON session_wrapped_stats FOR SELECT
  USING (player_id = auth.uid());

-- Organizers can read all rows for their session
CREATE POLICY "Organizer reads session wrapped"
  ON session_wrapped_stats FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM session_organizers so
      WHERE so.session_id = session_wrapped_stats.session_id
        AND so.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_wrapped_stats.session_id
        AND s.created_by = auth.uid()
    )
  );
```

### The `award_data` JSONB Structure

Each earned award that requires extra display data contributes a key to the JSONB:

```json
{
  "marathoner": {
    "games_played": 11,
    "estimated_minutes": 143
  },
  "dynamic_duo": {
    "partner_id": "uuid",
    "partner_name": "Marcus",
    "partner_skill": "intermediate",
    "wins_together": 6,
    "games_together": 7
  },
  "nemesis": {
    "nemesis_id": "uuid",
    "nemesis_name": "Jay",
    "nemesis_skill": "advanced",
    "lifetime_faced": 14,
    "lifetime_wins": 5,
    "lifetime_losses": 9,
    "session_faced": 3,
    "is_true_nemesis": true
  },
  "the_wall": {
    "opponent_name": "Sarah",
    "times_rematched": 3,
    "all_wins": true
  },
  "human_yoyo": {
    "alternating_length": 8
  }
}
```

### `/wrapped` Route Query

One row, one query — all computation already done:

```ts
const { data } = await supabase
  .from("session_wrapped_stats")
  .select(`
    *,
    profiles!player_id ( display_name, skill_level ),
    sessions!session_id ( name, ended_at, scoring )
  `)
  .eq("session_id", sessionId)
  .eq("player_id", playerId)
  .single();
```

---

## Pillar 3 — The Full Awards Catalogue

### Rarity Key
- 🟢 **Common** — fires for 3+ players most sessions
- 🟡 **Uncommon** — fires for 1–3 players per session
- 🔴 **Rare** — 0–1 per session; some sessions have none
- ⚫ **Legendary** — fires roughly once every several sessions

### Archetype Key
- 💪 Performance / dominance
- 🧠 Smart / tactical
- ❤️ Social / relationship
- 😅 Comedic / self-aware (warm, never mean)
- 🎲 Chaos / statistical freak
- ⏱️ Grind / hustle

### Minimum Gate
All awards require `games_played ≥ 2` to fire. Awards with higher minimums state them explicitly. This prevents a player who played one match from winning half the awards on a technicality.

---

### Category 1 — Volume & Hustle

---

**🏃 The Marathoner** ⏱️ 🟢
Most completed matches in the session. The person who never sat down.
`award_data.marathoner`: `{ games_played, estimated_minutes }`
*MIN: games_played ≥ 4. Awarded to MAX(games_played); tie-break: estimated_minutes.*

---

**🏟️ The Last One Standing** ⏱️ 🟡
Played in the first match AND the last match of the session.
*Detection: player_id present in match with MIN(created_at) AND match with MAX(completed_at) for the session.*

---

**🦾 The Iron Shuttle** ⏱️ 🔴
Played 7+ matches with no break longer than 15 minutes between any two consecutive matches. Never truly rested.
*Detection: ordered match timeline — all consecutive gaps < 15 min AND COUNT(matches) ≥ 7.*

---

**⏰ The Shift Worker** ⏱️ 🟡
Longest unbroken playing chain: the maximum total duration of consecutive matches where no gap between them exceeded 10 minutes.
`award_data.shift_worker`: `{ chain_games, chain_minutes }`
*Awarded to MAX(chain duration); MIN: chain ≥ 4 matches.*

---

**🚀 The Opener** 🎲 🟢
Played in the very first match of the session.
*Detection: player_id in match with MIN(created_at) for the session. All players in that match earn this.*

---

**🔒 The Closer** 🎲 🟢
Played in the very last completed match of the session.
*Detection: player_id in match with MAX(completed_at). All players in that match earn this.*

---

**✈️ The Frequent Flier** ⏱️ 🟡
Shortest average gap between consecutive matches — barely left the court between games.
`award_data.frequent_flier`: `{ avg_wait_minutes }`
*MIN: 4 matches. Awarded to MIN(avg gap); only counts gaps < 30 min (longer gaps = normal rest, not relevant).*

---

### Category 2 — Win Rate & Dominance

---

**🏆 The Undefeated** 💪 🔴
Won every single completed match. No losses, no mercy.
*MIN: games_played ≥ 4. Detection: wins = games_played.*

---

**🎖️ The One-Loss Club** 💪 🟡
Only one loss all session.
*MIN: games_played ≥ 5. Detection: losses = 1.*

---

**🔬 The Surgeon** 🧠 🟡
Highest win percentage among all players.
*MIN: games_played ≥ 5. Awarded to MAX(win_pct).*

---

**🔥 The Hot Hand** 💪 🟡
Longest win streak at any point during the session.
*MIN: streak ≥ 4 wins. Awarded to MAX(win_streak).*
`award_data.hot_hand`: `{ peak_streak }`

---

**🗡️ The Assassin** 💪 🟡
Highest average winning margin per win. Wins big every time.
*MIN: wins ≥ 3. Detection: MAX(AVG(margin per win)).*
`award_data.assassin`: `{ avg_margin }`

---

**🔥 The Scorched Earth** 💪 🟡
Highest total cumulative point differential across all completed matches (wins + losses combined).
*Distinct from The Assassin — this rewards sustained dominance in points, not just wins.*
`award_data.scorched_earth`: `{ total_point_diff }`

---

**👑 The Session Top Dog** 💪 🟡
Ranked #1 on the session leaderboard (by composite: win_pct → point_diff → points_for).
`award_data.top_dog`: `{ session_rank: 1, games_played, wins, win_pct }`
*This is always given to exactly one player per session — guaranteed non-empty.*

---

### Category 3 — Clutch & Close Games

---

**🧊 Ice in the Veins** 💪 🟡
Most wins where the final margin was ≤ 3 points (single-game) or the match went to a deciding final game (multi-set).
`award_data.ice_in_veins`: `{ clutch_wins, total_close_games }`
*MIN: clutch_wins ≥ 2.*

---

**⚡ The Overtime Specialist** 💪 🔴
Won 2+ matches decided by exactly 1 point.
*Detection (single-game): ABS(score_diff) = 1 AND player won — COUNT ≥ 2.*
*Detection (multi-set): won the match in a deciding game that ended with margin = 1.*

---

**🎯 The Rubber Game Warrior** 🎲 🔴
In best-of-3 or best-of-5 sessions: won 2+ matches that went the full distance (3 or 5 games).
*Detection: matches where match_games COUNT = max_games for format AND player won — COUNT ≥ 2.*

---

**🪨 Stone Cold** 🧠 🟡
Never lost a single close game (margin ≤ 3) all session. Doesn't just win close ones — they don't lose them.
*MIN: games_played ≥ 4 AND at least 2 close matches occurred involving this player.*
*Detection: COUNT(lost matches WHERE margin ≤ 3) = 0.*

---

**😤 The Thrill Seeker** 🎲 🟡
Most total matches (wins AND losses) decided by ≤ 3 points. Just lives in chaos.
`award_data.thrill_seeker`: `{ total_close_games }`
*MIN: close_games ≥ 3.*

---

**🕐 The Buzzer Beater** 🎲 🔴
Won a match that started in the last 20 minutes of the session's active duration.
*Detection: match.started_at > (session.ended_at - INTERVAL '20 minutes') AND player won.*

---

**💥 The Comeback** 🎲 🔴
In a single-game session: won a match where they trailed by 10+ points at some point.
*Note: This requires match score progression data, which the current schema does NOT store. Flag as a Phase 2 award — implementation deferred until a score_snapshots table exists. Silently hidden for now.*

---

### Category 4 — Scoring & Point Records

---

**💯 The Century Club** 💪 🟡
Scored 100+ total points across all matches. (Scales to 70+ in 21-point sessions via v_winning_score reference.)
`award_data.century_club`: `{ total_points_for }`
*Detection: points_for ≥ (v_winning_score × 3.2) — roughly 100 pts in a 31-point session.*

---

**🛡️ The Fortress** 🧠 🟡
Fewest points conceded per match (best defensive average points-against).
`award_data.fortress`: `{ avg_points_against }`
*MIN: games_played ≥ 4. Awarded to MIN(points_against / games_played).*

---

**🚫 The Shutout Artist** 💪 🔴
Won a match where the opponent scored 10 or fewer points in a 31-point game (≤ 7 in 21-point). True dominance.
*Detection: player won AND opponent_score ≤ ROUND(v_winning_score × 0.32).*
`award_data.shutout_artist`: `{ opponent_score, player_score }`
*All players on the winning team in that match earn this.*

---

**🎱 The 30-All** 🎲 ⚫
Won a match at the maximum dramatic scoreline: exactly 1 point above (v_winning_score)–(v_winning_score - 1). In a 31-point gym: won 31–30.
*Detection: winning_score = v_winning_score AND losing_score = (v_winning_score - 1).*
`award_data.thirty_all`: `{ final_score: "31-30" }`

---

**😬 The Generous** 😅 🟢
Gave the most total points to opponents across the session (highest points_against).
*Comedic framing: "You donated 247 points to your opponents tonight. Very charitable."*
`award_data.generous`: `{ total_points_against }`
*Always fires — at least one player has the highest points_against.*

---

**🎯 The Sniper** 💪 🟡
Top quartile in BOTH win_pct AND points_for per game. Wins often AND scores a lot each time.
*Detection: win_pct rank ≤ 25th percentile (top) AND (points_for/games_played) rank ≤ 25th percentile (top).*

---

### Category 5 — Partnership & Team Chemistry

---

**🤝 Dynamic Duo** ❤️ 🟡
The partner they won with most often. Among all players, award goes to the pair with the highest combined wins together.
`award_data.dynamic_duo`: `{ partner_id, partner_name, partner_skill, wins_together, games_together, win_rate_together }`
*MIN: games_together ≥ 3. Both players on the winning pair receive this award, pointing at each other.*

---

**💑 The Inseparables** ❤️ 🟡
Played with the same partner more times than any other partner — and that partner was exclusively them in 4+ matches.
`award_data.inseparables`: `{ partner_id, partner_name, partner_skill, games_together }`
*MIN: games_together ≥ 4 with the same partner.*

---

**🫂 The Glue** ❤️ 🟡
Played with the most unique partners across the session. The social hub — played with everyone.
`award_data.glue`: `{ unique_partners }`
*MIN: unique_partners ≥ 4. Awarded to MAX(COUNT(DISTINCT partner_id)).*

---

**⚡ The Catalyst** ❤️ 🔴
Partners won at a significantly higher rate when playing WITH this person compared to when playing without them.
*Detection: For each other player P2, compute P2's win rate in matches WITH this player vs without. Average the uplift across all P2s. Awarded to MAX(avg uplift) WHERE uplift > 0.*
`award_data.catalyst`: `{ avg_partner_win_rate_uplift, partners_boosted }`
*MIN: played with ≥ 3 different partners, each having ≥ 2 matches without them for comparison.*

---

**🪖 The Swiss Army** 🧠 ⚫
Won matches with 4+ different partners AND maintained a positive overall win rate (≥ 60%). Versatile AND effective.
`award_data.swiss_army`: `{ unique_winning_partners, overall_win_pct }`
*MIN: games_played ≥ 6.*

---

**🎓 The Tutor** ❤️ 🔴
In mixed-level matches, was the highest-skilled player on their team — and won every single one.
*Detection: is_mixed_level=true AND player = MAX(skill rank on team) AND team won — all such matches.*
*MIN: 2 mixed-level matches in this configuration.*

---

### Category 6 — Nemesis & Rivalry

---

**⚔️ The Nemesis** ❤️ 🟡
The opponent this player has faced most across their entire history in the app (lifetime H2H across all sessions). Displayed with the rival's name, skill badge, and the full lifetime head-to-head record.
`award_data.nemesis`: `{`
  `nemesis_id, nemesis_name, nemesis_skill,`
  `lifetime_faced, lifetime_wins, lifetime_losses,`
  `session_faced, session_wins, session_losses,`
  `is_true_nemesis: (lifetime_losses > lifetime_wins)`
`}`
*MIN: lifetime_faced ≥ 3. Both players receive a Nemesis card pointing at each other.*

---

**🔁 The Rivalry** 🎲 🟡
Two players who faced each other 3+ times THIS session and split the record evenly (1–2 or 2–1 or 2–2).
*Detection: pair WHERE session_faced ≥ 3 AND ABS(wins - losses) ≤ 1. Both players receive this.*
`award_data.rivalry`: `{ rival_id, rival_name, rival_skill, times_faced, player_wins, player_losses }`

---

**🗡️ The Giant Slayer** 💪 🔴
Beat the player currently ranked #1 in the session leaderboard at least once.
*Detection: player's team won a match that contained session_rank=1 player on the opposing team.*
*The #1-ranked player cannot earn this award.*
`award_data.giant_slayer`: `{ victim_name, victim_skill, times_beaten }`

---

**🧱 The Wall** 🧠 🔴
Never lost to the same opponent twice in a row within the session. Every rematch was a revenge win.
*Detection: for each opponent faced ≥ 2 times, check match sequence by created_at — no two consecutive losses vs the same person.*
*MIN: faced any opponent ≥ 2 times.*

---

**🐉 The Dragon** 💪 🔴
Beat 5+ unique different opponents (individual players, not teams) across the session.
`award_data.dragon`: `{ unique_opponents_beaten }`
*Detection: COUNT(DISTINCT player_id on losing teams across won matches) ≥ 5.*

---

**🏆 The Unslayable** 💪 ⚫
Session's top-ranked player AND was never beaten by anyone ranked below them. No upset losses.
*Detection: session_rank = 1 AND zero losses to players ranked lower than them.*

---

### Category 7 — Consistency & Arc

---

**⏱️ The Metronome** 🧠 🟡
Smallest variance (standard deviation) in score margin across all matches. Always competitive, results always close, never blowing anyone out or getting blown out.
`award_data.metronome`: `{ stddev_margin }`
*MIN: games_played ≥ 5. Awarded to MIN(STDDEV(ABS(score_diff))).*

---

**💨 The Second Wind** 🎲 🔴
Lost 2+ consecutive matches mid-session, then won 3+ in a row after. The biggest personal arc of the night.
*Detection: sequence analysis — find pattern ...LL...WWW... in chronological match history.*
`award_data.second_wind`: `{ losing_streak, comeback_streak }`

---

**🕯️ The Slow Burn** 🧠 🟡
Win rate in the second half of the session (by time) was 20+ percentage points higher than the first half. Got noticeably better as the night went on.
`award_data.slow_burn`: `{ first_half_win_pct, second_half_win_pct, improvement }`
*MIN: games_played ≥ 6 (at least 3 per half).*

---

**🌅 The Fade** 😅 🟡
Win rate in the first half significantly higher than the second half. Started strong, then fell off a cliff.
*Comedic framing: "You peaked early. That first set? Legendary. Then... something happened."*
`award_data.fade`: `{ first_half_win_pct, second_half_win_pct, drop }`
*MIN: games_played ≥ 6. Only fires when drop ≥ 25 percentage points.*

---

**🚀 The Rocket Launch** 🎲 🟡
Lost their first 2 matches, then went on their best win streak of the session.
*Detection: first 2 matches = losses, then ≥ 3 consecutive wins later in chronological order.*
`award_data.rocket_launch`: `{ opening_losses: 2, comeback_streak }`

---

### Category 8 — Skill Dynamics & Mixed Level

---

**⬆️ The Level Up** 💪 🟡
Won the most matches where they were on the lower-average-skill team (mixed-level matches only).
`award_data.level_up`: `{ upsets_won }`
*MIN: won ≥ 2 mixed-level matches as the "underdog" team.*

---

**⚖️ The Equalizer** 🧠 🟡
Played in the most mixed-level matches of the session. The player the matchmaking system leans on to balance.
`award_data.equalizer`: `{ mixed_matches_played }`
*MIN: mixed_matches ≥ 3. Awarded to MAX(COUNT(is_mixed_level=true matches)).*

---

**💥 The Upset Machine** 🎲 🔴
Won the most matches against opponents whose average skill exceeded theirs by 2+ enum tiers.
`award_data.upset_machine`: `{ upsets, avg_skill_gap }`
*Detection: compute numeric skill rank (beginner=1 → advanced=7). Count wins where (avg opponent skill - own skill) ≥ 2.*
*MIN: upsets ≥ 2.*

---

### Category 9 — Court & Location

---

**🏠 The Landlord** 🎲 🟡
Played 4+ consecutive matches on the exact same court. Never left their kingdom.
`award_data.landlord`: `{ court_name, consecutive_matches }`
*Detection: 4+ consecutive matches (by created_at) with identical court_id.*

---

**🌍 The World Traveler** 🎲 🟡
Played on every court in the venue at least once during the session.
`award_data.world_traveler`: `{ courts_visited }`
*Detection: COUNT(DISTINCT court_id) = COUNT(total courts for session).*
*MIN: session has ≥ 3 courts.*

---

**🔑 The Evicted** 😅 🔴
Had the Landlord streak (3+ same court) — then lost that court. Their kingdom, taken.
*Comedic framing: "3 matches in a row on Court 1. Then Court 2. The audacity."*
`award_data.evicted`: `{ court_name, streak_before_eviction }`

---

### Category 10 — Time & Scheduling

---

**🌅 The Early Bird** ⏱️ 🟢
Played in the first completed match of the session.
*Detection: player_id in match with MIN(completed_at). All 4 players in that match earn this.*

---

**🦉 The Night Owl** ⏱️ 🟢
Played in the last completed match before session end.
*Detection: player_id in match with MAX(completed_at). All 4 players earn this.*

---

**⚡ The Speed Demon** 🎲 🔴
Won the fastest match of the session (shortest duration from started_at to completed_at).
`award_data.speed_demon`: `{ match_duration_minutes }`
*Detection: MIN(completed_at - started_at) WHERE status='completed' AND both timestamps non-null AND player won.*

---

**🏺 The War of Attrition** 😅 🔴
Played in the longest single match of the session by duration.
*Comedic framing: "That match took 47 minutes. Nobody asked why. Nobody needed to."*
`award_data.attrition`: `{ match_duration_minutes }`
*Detection: MAX(completed_at - started_at). All 4 players in that match earn this.*

---

**🪑 The Philosopher** 😅 🟡
Spent more total time waiting between matches than actually playing. The great observer.
*Comedic framing: "You studied the game deeply from the bench. 94 minutes of rich analysis."*
`award_data.philosopher`: `{ total_wait_minutes, total_play_minutes }`
*Detection: SUM(gaps between matches) > SUM(match durations). MIN: games_played ≥ 3.*

---

### Category 11 — Statistical Freaks

---

**🪀 The Human Yo-Yo** 🎲 🟡
W-L-W-L-W-L alternating pattern for 6+ consecutive matches. Perfectly, maddeningly inconsistent.
`award_data.human_yoyo`: `{ alternating_length }`
*Detection: sequence analysis on chronological match results — alternating ≥ 6 long.*

---

**👻 The Ghost** 🎲 ⚫
Played in 6+ matches and EVERY single one was decided by ≤ 3 points. Exists in a permanent zone of chaos.
*Detection: games_played ≥ 6 AND all matches have ABS(score_diff) ≤ 3.*
`award_data.ghost`: `{ games_played, max_margin: 3 }`

---

**🎰 The Coin Flip** 😅 🟡
Win rate is exactly or nearly 50% (between 45–55%) across ≥ 6 matches. The app literally cannot predict you.
*Comedic framing: "4 wins, 4 losses. A coin flip. Quantum badminton."*
`award_data.coin_flip`: `{ wins, losses, win_pct }`

---

**🧮 The Mathematician** 🎲 🔴
Every match they played was decided by a prime number margin (2, 3, 5, 7, 11, 13...).
*Detection: ALL completed matches WHERE ABS(score_diff) IN (2, 3, 5, 7, 11, 13, 17, 19). MIN: games_played ≥ 4.*

---

### Category 12 — Comedic / Humble (Warm, Never Mean)

---

**🏅 The Participation Trophy** 😅 🟢
Default floor award for players who played at least 1 match but didn't qualify for any other award.
*Only fires when earned_awards is empty after all other checks complete.*
*Framing: "You showed up. You played. That's the whole thing, honestly."*

---

**🎁 The Philanthropist** 😅 🟢
Lost the most matches this session. The person who gave everyone else a win.
*Comedic but warm framing: "You made 7 other people feel really good tonight. Very generous of you."*
*Distinct from The Generous (which is about points; this is about match losses).*
`award_data.philanthropist`: `{ losses }`
*Always fires — awarded to MAX(losses) if losses ≥ 3.*

---

**🤦 The One That Got Away** 😅 🔴
Lost 2+ matches by exactly 1 point. The cruelest stat in badminton.
*Comedic framing: "2 matches. 1 point apart. We don't talk about it."*
`award_data.one_that_got_away`: `{ narrow_losses }`

---

**🪞 The Mirror** 😅 🔴
Faced the same player as an opponent in 3+ matches AND the H2H record is exactly tied (e.g., 2-2 or 3-3 within the session). A perfect deadlock.
`award_data.mirror`: `{ rival_name, rival_skill, times_faced, session_record }`

---

**🛋️ The VIP Spectator** 😅 🟡
Had the single longest uninterrupted break from playing (gap > 30 min between two consecutive matches).
*Comedic framing: "You took a 42-minute break mid-session. We thought you left."*
`award_data.vip_spectator`: `{ longest_break_minutes }`
*MIN: games_played ≥ 3 (to confirm they came back).*

---

## Award Count Summary

| Category | Award Count | Rarity Spread |
|----------|-------------|---------------|
| Volume & Hustle | 7 | 4 Common/Uncommon, 3 Rare |
| Win Rate & Dominance | 7 | 5 Uncommon, 2 Rare |
| Clutch & Close Games | 7 | 3 Uncommon, 3 Rare, 1 deferred |
| Scoring & Point Records | 6 | 3 Uncommon, 2 Rare, 1 Legendary |
| Partnership & Team Chemistry | 6 | 3 Uncommon, 2 Rare, 1 Legendary |
| Nemesis & Rivalry | 6 | 3 Uncommon, 2 Rare, 1 Legendary |
| Consistency & Arc | 6 | 3 Uncommon, 2 Rare, 1 Rare |
| Skill Dynamics | 3 | 1 Uncommon, 2 Rare |
| Court & Location | 3 | 2 Uncommon, 1 Rare |
| Time & Scheduling | 5 | 2 Common, 2 Rare, 1 Uncommon |
| Statistical Freaks | 4 | 1 Uncommon, 2 Rare, 1 Legendary |
| Comedic / Humble | 5 | 3 Common/Uncommon, 2 Rare |
| **Total** | **45** | **~14 Common/Uncommon, ~25 Rare, ~5 Legendary** |

---

## Award Diversity Mechanics

### Why players won't get the same awards every session

1. **Context-dependence**: Most awards depend on who else played that night. You can only win The Giant Slayer if you beat the #1 player — who changes every session. You can only win Dynamic Duo if you partnered consistently with someone — which changes by rotation.

2. **Rarity throttle**: ~55% of awards are Rare or Legendary. In a 20-player session, most Rare awards fire for 0–1 players. In any given session, roughly 8–12 unique Rare awards will fire across the entire player pool — spread thin.

3. **Mutual exclusion by logic**: Some awards structurally conflict. You can't be both The Undefeated AND The Philanthropist. You can't be The Slow Burn AND The Fade. These natural conflicts diversify results without needing explicit exclusion rules.

4. **Sequence-dependent awards**: The Human Yo-Yo, Second Wind, Rocket Launch, and Fade all depend on the exact sequence of wins and losses — which varies enormously even if two players have the same final record.

5. **Comedic awards as equalizers**: The Generous, The Philosopher, The VIP Spectator, and The Philanthropist fire for players who might earn zero performance awards — ensuring every player gets something to share even on a hard night.

---

## Pillar 4 — Award Computation Logic

### Single Postgres RPC: `compute_session_wrapped(p_session_id UUID)`

All 45 award checks are computed in a single stored procedure to:
- Run in one transaction (consistent snapshot)
- Avoid N+1 queries per player
- Minimize round-trips from the Next.js server

The RPC structure (pseudocode, not final SQL):

```sql
CREATE OR REPLACE FUNCTION compute_session_wrapped(p_session_id UUID)
RETURNS void AS $$
DECLARE
  v_scoring sessions.scoring%TYPE;
  v_winning_score integer;
  v_players uuid[];
  -- ... per-player computation variables
BEGIN

  -- 1. Detect session format
  SELECT scoring INTO v_scoring FROM sessions WHERE id = p_session_id;
  
  -- 2. Infer winning score for single-game sessions
  IF v_scoring = 'single' THEN
    SELECT MODE() WITHIN GROUP (ORDER BY GREATEST(team_a_score, team_b_score))
    INTO v_winning_score
    FROM matches
    WHERE session_id = p_session_id AND status = 'completed';
  END IF;

  -- 3. Collect all players who participated
  SELECT ARRAY_AGG(DISTINCT qe.player_id)
  INTO v_players
  FROM queue_entries qe
  WHERE qe.session_id = p_session_id;

  -- 4. For each player, compute:
  --    a) Base stats (reuse v_session_leaderboard logic or direct query)
  --    b) All sequence-based awards (Yo-Yo, Second Wind, etc.) using ordered match CTEs
  --    c) All aggregate awards (Marathoner, Fortress, etc.)
  --    d) All cross-player awards (Giant Slayer, Catalyst, Dragon, etc.)
  --    e) Nemesis — cross-session H2H query
  --    f) Determine session_rank by ordering all players

  -- 5. UPSERT into session_wrapped_stats
  INSERT INTO session_wrapped_stats (
    session_id, player_id, games_played, wins, losses,
    points_for, points_against, win_pct, win_streak,
    session_rank, earned_awards, award_data
  ) VALUES (...)
  ON CONFLICT (session_id, player_id) DO UPDATE SET ...;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Sequence Analysis Pattern

For awards that require chronological match order (Human Yo-Yo, Second Wind, Rocket Launch, Fade, Slow Burn):

```sql
-- Ordered match results per player (CTE used throughout)
WITH ordered_matches AS (
  SELECT
    mp.player_id,
    m.id as match_id,
    m.created_at,
    m.court_id,
    m.team_a_score,
    m.team_b_score,
    mp.team,
    m.started_at,
    m.completed_at,
    CASE
      WHEN mp.team = 'a' AND m.team_a_score > m.team_b_score THEN true
      WHEN mp.team = 'b' AND m.team_b_score > m.team_a_score THEN true
      ELSE false
    END AS won,
    ABS(m.team_a_score - m.team_b_score) AS margin,
    ROW_NUMBER() OVER (PARTITION BY mp.player_id ORDER BY m.created_at) AS match_seq
  FROM match_players mp
  JOIN matches m ON m.id = mp.match_id
  WHERE m.session_id = p_session_id
    AND m.status = 'completed'
)
```

This CTE is computed once and referenced by all sequence-dependent award checks.

### Cross-Session Nemesis Query

The Nemesis award is the only one that queries outside the current session:

```sql
-- For each player, find their most frequent lifetime opponent
WITH lifetime_matchups AS (
  SELECT
    mp1.player_id AS player,
    mp2.player_id AS opponent,
    COUNT(*) AS times_faced,
    SUM(CASE WHEN (mp1.team = 'a' AND m.team_a_score > m.team_b_score)
              OR  (mp1.team = 'b' AND m.team_b_score > m.team_a_score)
             THEN 1 ELSE 0 END) AS player_wins,
    SUM(CASE WHEN (mp1.team = 'a' AND m.team_a_score < m.team_b_score)
              OR  (mp1.team = 'b' AND m.team_b_score < m.team_a_score)
             THEN 1 ELSE 0 END) AS player_losses
  FROM match_players mp1
  JOIN match_players mp2 ON mp2.match_id = mp1.match_id
    AND mp2.team != mp1.team
    AND mp2.player_id != mp1.player_id
  JOIN matches m ON m.id = mp1.match_id
    AND m.status = 'completed'
  -- No session filter — intentionally all sessions
  GROUP BY mp1.player_id, mp2.player_id
  HAVING COUNT(*) >= 3  -- minimum 3 lifetime matches to be a Nemesis
)
SELECT * FROM lifetime_matchups
ORDER BY times_faced DESC, player_losses DESC
LIMIT 1
```

---

## Pillar 5 — Real-Time Routing & Flow

### The Gap

`closeSession()` currently only redirects the organizer. Connected players get no signal.

### Solution: Extend `session-events` Broadcast

**Step 1:** Add `broadcastSessionClosed()` helper:
```ts
// New event type alongside existing 'organizer_intervention'
type: "session_closed", payload: { sessionId: string }
```

**Step 2:** Extend `subscribeToOrganizerBroadcast` in `realtime.ts` to handle `session_closed`.

**Step 3:** In `useOrganizerBroadcast` hook, on `session_closed` event:
```ts
router.push(`/wrapped/${sessionId}/${currentPlayerId}`)
```

### Execution Order (Updated `closeSession()`)

```
[NEW] Step 0: compute_session_wrapped(sessionId)    ← Pre-compute all Wrapped rows
Step 1: Cancel active matches
Step 2: Dequeue all players
Step 3: Close all courts
Step 4: Mark session inactive
[NEW] Step 5: broadcastSessionClosed(sessionId)     ← Redirect signal fires LAST
```

### Race Condition Matrix

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Player lands on /wrapped before their row exists | Empty state | Broadcast fires after RPC completes (Step 5 > Step 0) |
| Player's tab is backgrounded / offline | Misses broadcast | `/play` banner: "Session ended — see your Wrapped" |
| RPC fails to write rows | No data on /wrapped | Log error, session closes anyway, player sees graceful empty state |
| Player has zero completed matches | Sad Wrapped | Show minimal "You were here" card with session name + date + Participation Trophy |

---

## Pillar 6 — UI & Shareability

### Route Structure

```
src/app/wrapped/[sessionId]/[playerId]/
  page.tsx      ← Server Component, single SELECT, passes data down
  layout.tsx    ← Full-bleed layout: NO PwaNavBar, NO global header
```

### Component Tree

```
src/components/wrapped/
  wrapped-shell.tsx       ← "use client" — slide index, swipe gestures, keyboard nav
  slide-base.tsx          ← 9:16 container, explicit brand colors (no dark: variants)
  slide-opening.tsx       ← Session name, date, "Your Wrapped"
  slide-base-stats.tsx    ← GP · W · L · Win% in tabular-nums large type
  slide-rank.tsx          ← Session rank reveal (#3 of 18 players)
  slide-streak.tsx        ← Win streak highlight (only if ≥ 3)
  slide-awards.tsx        ← Grid of earned award cards (0–N, skipped if none)
  slide-dynamic-duo.tsx   ← Partner reveal with skill badge for both players
  slide-nemesis.tsx       ← Nemesis reveal with lifetime H2H and skill badge
  slide-share.tsx         ← Final CTA: share + download
  award-card.tsx          ← Reusable icon + name + description badge
```

### CSS Rules for html-to-image Capture

| Rule | Reason |
|------|---------|
| ✅ Use `flexbox` only inside capture div | Full support |
| ✅ Explicit hex/hsl colors only | `dark:` variants don't work in capture |
| ✅ Inline SVG for icons | Renders correctly |
| ✅ `aspect-ratio: 9/16` on container | Supported |
| ✅ `border-radius`, `box-shadow` | Supported |
| ❌ No `CSS grid` | Partial / inconsistent support |
| ❌ No `backdrop-filter` | Broken in most capture libraries |
| ❌ No Google Fonts via URL | Blocked by CORS during capture — embed as base64 |
| ❌ No `overflow: scroll` on capture element | Captures viewport only |
| ❌ No `filter` on parent with children | Z-index stacking context issues |

### Share Flow

```ts
const png = await toPng(shareCardRef.current, { pixelRatio: 3 });
// → 1170×2080px at 3× scale (native Instagram Story resolution)

if (navigator.canShare?.({ files: [file] })) {
  await navigator.share({ title: "My Session Wrapped", files: [file] });
} else {
  // Desktop fallback: trigger download
  triggerDownload(png, "my-wrapped.png");
}
```

---

## Implementation Order

> No code written until this plan is approved.

| Phase | Step | File(s) | Effort |
|-------|------|---------|--------|
| **Phase 1: Database** | 1.1 | New migration: `session_wrapped_stats` table + RLS | 30 min |
| | 1.2 | New migration: `compute_session_wrapped()` RPC — base stats + all 45 awards | 4–6 hrs |
| | 1.3 | New TypeScript types for `session_wrapped_stats` row and `award_data` JSONB | 30 min |
| **Phase 2: Session Close** | 2.1 | Update `closeSession()` in `sessions.ts` — call RPC at Step 0 | 30 min |
| | 2.2 | Add `broadcastSessionClosed()` to `broadcast.ts` | 15 min |
| | 2.3 | Extend `subscribeToOrganizerBroadcast` in `realtime.ts` + `useOrganizerBroadcast` hook | 30 min |
| **Phase 3: Route** | 3.1 | `/wrapped/[sessionId]/[playerId]/layout.tsx` — full-bleed, no nav | 15 min |
| | 3.2 | `/wrapped/[sessionId]/[playerId]/page.tsx` — server component, single query | 30 min |
| **Phase 4: UI Slides** | 4.1 | `slide-base.tsx` — 9:16 container, brand colors, progress dots | 1 hr |
| | 4.2 | `slide-opening.tsx`, `slide-base-stats.tsx`, `slide-rank.tsx`, `slide-streak.tsx` | 2 hrs |
| | 4.3 | `award-card.tsx` + `slide-awards.tsx` — dynamic grid of earned awards | 2 hrs |
| | 4.4 | `slide-dynamic-duo.tsx` + `slide-nemesis.tsx` (both with skill badges) | 1.5 hrs |
| | 4.5 | `slide-share.tsx` — html-to-image capture + navigator.share + download | 1.5 hrs |
| | 4.6 | `wrapped-shell.tsx` — slide sequencer, swipe gestures, keyboard nav | 1.5 hrs |
| **Phase 5: Edge Cases** | 5.1 | "Session ended" reconnect banner on `/play` page | 30 min |
| | 5.2 | Empty state on `/wrapped` when no stats row found | 30 min |
| | 5.3 | Minimum-match fallback card (0 completed matches) | 30 min |

**Estimated total: ~18–20 hours of implementation.**

---

## Remaining Risks & Edge Cases

| Risk | Severity | Mitigation |
|------|----------|------------|
| `compute_session_wrapped()` times out for very large sessions (50+ players) | Medium | Add `statement_timeout = '10s'` in RPC; fallback to empty state gracefully |
| Player opens `/wrapped` URL directly without being authenticated | Low | RLS blocks the query; redirect to `/` |
| Partner named in Dynamic Duo has since deleted their account | Low | `award_data` stores `partner_name` as plain text at compute time — name preserved even if profile deleted |
| Nemesis cross-session query is slow (full table scan across all matches) | Medium | Add index `CREATE INDEX idx_match_players_player ON match_players(player_id)` — likely already exists; verify |
| html-to-image fails on older iOS Safari | Medium | Catch error, show manual screenshot instructions as fallback |
| Session with only 2 players (edge case for a gym) | Low | Most awards silently hidden; Participation Trophy fires; graceful minimal Wrapped |

---

*No implementation begins until this plan is approved.*
