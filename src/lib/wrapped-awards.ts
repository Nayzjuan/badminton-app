// ============================================================
// Award Metadata — shared between server and client
// ============================================================
// Defines display metadata for every award slug the
// compute_session_wrapped() RPC can emit. Used by the award
// card renderer on the Wrapped page.
//
// Rarity tiers:   common | uncommon | rare | legendary
// Each award has:   emoji, title, subtitle template, rarity
//
// Templates can use {value} tokens that the renderer replaces
// with data from the award_data JSONB column.
// ============================================================

export type AwardRarity = "common" | "uncommon" | "rare" | "legendary";

export type AwardMeta = {
  slug: string;
  emoji: string;
  title: string;
  /** Short, punchy description shown on the card. {tokens} are replaced at render time. */
  subtitle: string;
  rarity: AwardRarity;
};

export const AWARD_META: Record<string, AwardMeta> = {
  // ── PERFORMANCE ────────────────────────────────────────────
  undefeated_champion: {
    slug: "undefeated_champion",
    emoji: "👑",
    title: "Undefeated Champion",
    subtitle: "Played {games} games and didn't drop a single one. Absolutely untouchable tonight.",
    rarity: "legendary",
  },
  dominant_night: {
    slug: "dominant_night",
    emoji: "💥",
    title: "Dominant Night",
    subtitle: "{win_pct}% win rate. You weren't just winning — you were making a statement.",
    rarity: "rare",
  },
  solid_outing: {
    slug: "solid_outing",
    emoji: "💪",
    title: "Solid Outing",
    subtitle: "{win_pct}% win rate. Consistent, reliable, dangerous.",
    rarity: "uncommon",
  },
  glass_half_full: {
    slug: "glass_half_full",
    emoji: "⚖️",
    title: "Glass Half Full",
    subtitle: "{wins}W – {losses}L. Perfectly balanced, as all things should be.",
    rarity: "common",
  },
  session_mvp: {
    slug: "session_mvp",
    emoji: "🏆",
    title: "Session MVP",
    subtitle: "Ranked #1 tonight. The whole gym knows your name.",
    rarity: "legendary",
  },

  // ── SCORING ────────────────────────────────────────────────
  point_machine: {
    slug: "point_machine",
    emoji: "🎯",
    title: "Point Machine",
    subtitle:
      "{total_points} points scored tonight. The scoreboard was basically your highlight reel.",
    rarity: "uncommon",
  },
  shutout_artist: {
    slug: "shutout_artist",
    emoji: "🔒",
    title: "Shutout Artist",
    subtitle: "Won a game without letting them score. That's not badminton — that's an execution.",
    rarity: "legendary",
  },
  top_scorer: {
    slug: "top_scorer",
    emoji: "📈",
    title: "Top Scorer",
    subtitle: "{points} total points — more than anyone else in the session.",
    rarity: "rare",
  },
  point_diff_king: {
    slug: "point_diff_king",
    emoji: "📊",
    title: "+/- King",
    subtitle: "+{point_diff} point differential. Nobody controlled margins like you did.",
    rarity: "rare",
  },

  // ── STREAKS ────────────────────────────────────────────────
  hot_streak: {
    slug: "hot_streak",
    emoji: "🔥",
    title: "Hot Streak",
    subtitle: "{streak} wins in a row at some point. Momentum is a real thing.",
    rarity: "uncommon",
  },
  on_fire: {
    slug: "on_fire",
    emoji: "🔥🔥",
    title: "On Fire",
    subtitle: "{streak} consecutive wins. You were running this gym.",
    rarity: "rare",
  },
  unstoppable: {
    slug: "unstoppable",
    emoji: "⚡",
    title: "Unstoppable",
    subtitle: "{streak} wins in a row. That streak had its own gravitational pull.",
    rarity: "legendary",
  },

  // ── VOLUME ─────────────────────────────────────────────────
  battle_tested: {
    slug: "battle_tested",
    emoji: "🛡️",
    title: "Battle Tested",
    subtitle: "{games} games tonight. You were out there putting in the work.",
    rarity: "uncommon",
  },
  marathon_night: {
    slug: "marathon_night",
    emoji: "🏃",
    title: "Marathon Night",
    subtitle: "{games} games. Your legs had a different opinion but you didn't listen.",
    rarity: "rare",
  },
  court_hermit: {
    slug: "court_hermit",
    emoji: "🏠",
    title: "Court Hermit",
    subtitle: "{games} games. You basically live here now.",
    rarity: "legendary",
  },
  most_active: {
    slug: "most_active",
    emoji: "⚡",
    title: "Most Active",
    subtitle: "{games} games — nobody played more than you tonight.",
    rarity: "uncommon",
  },

  // ── RESILIENCE ─────────────────────────────────────────────
  grinds: {
    slug: "grinds",
    emoji: "💎",
    title: "The Grind",
    subtitle: "{losses} losses and you never stopped showing up. That's character.",
    rarity: "uncommon",
  },
  never_say_die: {
    slug: "never_say_die",
    emoji: "🤞",
    title: "Never Say Die",
    subtitle:
      "{losses} losses tonight. You're either building resilience or something is deeply wrong.",
    rarity: "uncommon",
  },
  sunset_surge: {
    slug: "sunset_surge",
    emoji: "🌅",
    title: "Sunset Surge",
    subtitle: "Won {final_wins} of your last 3 games. Saved the best for last.",
    rarity: "uncommon",
  },
  fast_starter: {
    slug: "fast_starter",
    emoji: "🚀",
    title: "Fast Starter",
    subtitle: "Won your very first game of the night. Came in and made a statement immediately.",
    rarity: "common",
  },

  // ── NEMESIS / H2H ──────────────────────────────────────────
  my_nemesis: {
    slug: "my_nemesis",
    emoji: "😤",
    title: "Found My Nemesis",
    subtitle:
      "{nemesis_name} beat you {loss_count} times tonight. Respectfully: we have a problem.",
    rarity: "uncommon",
  },
  kryptonite: {
    slug: "kryptonite",
    emoji: "🧲",
    title: "I'm Your Kryptonite",
    subtitle: "Beat {victim_name} {win_count} times. They're going to be practicing this week.",
    rarity: "uncommon",
  },

  // ── SCORE-BASED FLAVOR ─────────────────────────────────────
  close_call_survivor: {
    slug: "close_call_survivor",
    emoji: "😅",
    title: "Close Call Survivor",
    subtitle: "Won {narrow_wins} games by 2 points or less. Your heart rate sponsored this award.",
    rarity: "rare",
  },
  heartbreaker: {
    slug: "heartbreaker",
    emoji: "💔",
    title: "The Heartbreaker",
    subtitle:
      "Lost {narrow_losses} games by 2 points or less. The margin was this thin. Every. Single. Time.",
    rarity: "uncommon",
  },
  deuce_magnet: {
    slug: "deuce_magnet",
    emoji: "🎭",
    title: "Deuce Magnet",
    subtitle: "{deuce_games} of your games went to 30-30. Drama follows you everywhere.",
    rarity: "uncommon",
  },

  // ── COMEDIC ────────────────────────────────────────────────
  participation_trophy: {
    slug: "participation_trophy",
    emoji: "🫶",
    title: "Participation Trophy",
    subtitle:
      "0 wins. But you laced up your shoes and showed up. That's genuinely half the battle.",
    rarity: "common",
  },
  the_punching_bag: {
    slug: "the_punching_bag",
    emoji: "🥊",
    title: "The Punching Bag",
    subtitle: "{losses} losses — the most in the session. You're essentially a public service.",
    rarity: "common",
  },
  scoreboard_decorator: {
    slug: "scoreboard_decorator",
    emoji: "🎨",
    title: "Scoreboard Decorator",
    subtitle: "Got shutout in a game. You really let them have their moment.",
    rarity: "common",
  },
  just_getting_started: {
    slug: "just_getting_started",
    emoji: "🌱",
    title: "Just Getting Started",
    subtitle: "Played {games} game(s) this session. Your story is just beginning.",
    rarity: "common",
  },

  // ── PERFORMANCE (NEW) ──────────────────────────────────────
  comeback_kid: {
    slug: "comeback_kid",
    emoji: "🔄",
    title: "Comeback Kid",
    subtitle: "Lost your first two games — then won {comeback_wins}. Adjustments matter.",
    rarity: "rare",
  },
  the_closer: {
    slug: "the_closer",
    emoji: "🎯",
    title: "The Closer",
    subtitle: "Won your very last game of the night. You went out on top.",
    rarity: "uncommon",
  },
  ice_cold: {
    slug: "ice_cold",
    emoji: "🧊",
    title: "Ice Cold",
    subtitle: "Lost your first AND last game. The ends bookended you tonight.",
    rarity: "common",
  },
  clean_sweep: {
    slug: "clean_sweep",
    emoji: "🧹",
    title: "Clean Sweep",
    subtitle: "Won all three of your last three games. Closed the night out perfect.",
    rarity: "rare",
  },
  back_to_back: {
    slug: "back_to_back",
    emoji: "🔁",
    title: "Back-to-Back",
    subtitle: "{streaks} separate winning streaks tonight. You kept finding the next gear.",
    rarity: "uncommon",
  },

  // ── MARGIN / DOMINANCE (NEW) ───────────────────────────────
  blowout_king: {
    slug: "blowout_king",
    emoji: "💨",
    title: "Blowout King",
    subtitle: "{avg_margin}-pt average winning margin across {wins} wins. Surgical.",
    rarity: "rare",
  },
  heartless: {
    slug: "heartless",
    emoji: "😐",
    title: "Heartless",
    subtitle: "{big_wins} wins by 8+ points. No close calls. No mercy.",
    rarity: "uncommon",
  },
  sniper: {
    slug: "sniper",
    emoji: "🔫",
    title: "The Sniper",
    subtitle: "{clean_wins} wins by 5–7 points. Clinical precision, no drama.",
    rarity: "uncommon",
  },
  defensive_wall: {
    slug: "defensive_wall",
    emoji: "🧱",
    title: "Defensive Wall",
    subtitle: "{avg_pa} avg points conceded per game — lowest in the session.",
    rarity: "rare",
  },

  // ── SOCIAL / PARTNER (NEW) ─────────────────────────────────
  social_butterfly: {
    slug: "social_butterfly",
    emoji: "🦋",
    title: "Social Butterfly",
    subtitle: "Played with {partners} different partners tonight. The whole gym had a turn.",
    rarity: "uncommon",
  },
  loyal_partner: {
    slug: "loyal_partner",
    emoji: "🤝",
    title: "Ride or Die",
    subtitle: "Played {shared_games} games with {partner_name}. Built a real partnership.",
    rarity: "uncommon",
  },
  mixed_master: {
    slug: "mixed_master",
    emoji: "🎲",
    title: "Mixed Master",
    subtitle: "Won {mixed_wins} mixed-level matches. You played up and survived.",
    rarity: "uncommon",
  },

  // ── RIVALRY / DRAMA (NEW) ──────────────────────────────────
  the_rematch: {
    slug: "the_rematch",
    emoji: "⚔️",
    title: "The Rematch",
    subtitle: "Faced the same pair {encounters} times tonight. They won't forget you.",
    rarity: "rare",
  },
  redemption_arc: {
    slug: "redemption_arc",
    emoji: "📈",
    title: "Redemption Arc",
    subtitle: "Lost to a pair earlier — beat them later. The script flipped.",
    rarity: "rare",
  },
  friendly_fire: {
    slug: "friendly_fire",
    emoji: "😅",
    title: "Friendly Fire",
    subtitle: "Got matched against someone you also partnered with tonight. Awkward.",
    rarity: "common",
  },

  // ── COMEDIC / PERSONALITY (NEW) ────────────────────────────
  benchwarmer: {
    slug: "benchwarmer",
    emoji: "🪑",
    title: "Professional Benchwarmer",
    subtitle: "1 game played all session. The vibes were elsewhere.",
    rarity: "common",
  },
  the_warmup_act: {
    slug: "the_warmup_act",
    emoji: "🎪",
    title: "The Warm-Up Act",
    subtitle: "{games} games, every loss by {avg_margin}+ pts avg. Brutal night out there.",
    rarity: "common",
  },
  own_worst_enemy: {
    slug: "own_worst_enemy",
    emoji: "🙃",
    title: "Own Worst Enemy",
    subtitle: "Both lost to AND beat {opponent_name} tonight. You contain multitudes.",
    rarity: "common",
  },
  the_veteran: {
    slug: "the_veteran",
    emoji: "🎖️",
    title: "The Veteran",
    subtitle: "All-time top-3 in games played. The OG showed up tonight.",
    rarity: "rare",
  },

  // ── SPECIAL / MILESTONE (NEW) ──────────────────────────────
  century_club: {
    slug: "century_club",
    emoji: "💯",
    title: "Century Club",
    subtitle: "{alltime_games} all-time games. Built different. Welcome to the 100 club.",
    rarity: "legendary",
  },
  // One-time, club-wide honor — only ever held by whoever was the FIRST
  // player in the club to ever reach 100 all-time games. Distinct from
  // century_club (which every player earns on crossing 100, every time).
  first_to_100: {
    slug: "first_to_100",
    emoji: "🥇",
    title: "First to 100",
    subtitle: "The first player in the club to ever reach 100 all-time games. History remembers.",
    rarity: "legendary",
  },
  night_cap: {
    slug: "night_cap",
    emoji: "🌙",
    title: "Night Cap",
    subtitle: "Played in the very last match of the session. You closed the gym down.",
    rarity: "common",
  },
  early_bird: {
    slug: "early_bird",
    emoji: "🐦",
    title: "Early Bird",
    subtitle: "Played in the first match of the session. First in, leading from the front.",
    rarity: "common",
  },
  skill_slayer: {
    slug: "skill_slayer",
    emoji: "🗡️",
    title: "Skill Slayer",
    subtitle: "Beat a team rated 2+ skill levels above yours. {upset_wins} upset(s) tonight.",
    rarity: "rare",
  },
  double_trouble: {
    slug: "double_trouble",
    emoji: "👬",
    title: "Double Trouble",
    subtitle: "You and a partner both had 3+ win streaks tonight. Dynamic duo energy.",
    rarity: "rare",
  },

  // ── Cross-session awards (added migration 20260510) ──────────────────────

  momentum: {
    slug: "momentum",
    emoji: "🌊",
    title: "On a Wave",
    subtitle:
      "You ended last session on a {prior_streak}-game streak and won your first game tonight. The momentum carried.",
    rarity: "rare",
  },
  consistent_dominator: {
    slug: "consistent_dominator",
    emoji: "👑",
    title: "Consistent Dominator",
    subtitle:
      "70%+ win rate in {dominant_sessions} of your last 3 sessions. You don't have off nights.",
    rarity: "legendary",
  },
  bounced_back: {
    slug: "bounced_back",
    emoji: "📈",
    title: "Bounced Back",
    subtitle: "Last session: {last_win_pct}%. Tonight: {this_win_pct}%. That's a comeback.",
    rarity: "uncommon",
  },
  nemesis_slayer: {
    slug: "nemesis_slayer",
    emoji: "⚔️",
    title: "Nemesis Slayer",
    subtitle:
      "You finally beat the player who's had your number. They were up {alltime_deficit} on you all-time.",
    rarity: "rare",
  },
  settled_the_score: {
    slug: "settled_the_score",
    emoji: "✅",
    title: "Settled the Score",
    subtitle: "You were losing that all-time head-to-head. Tonight you levelled it — or better.",
    rarity: "rare",
  },
  the_dynasty: {
    slug: "the_dynasty",
    emoji: "🏛️",
    title: "The Dynasty",
    subtitle:
      "You've beaten the same opponent {wins} times all-time with a 70%+ win rate. They know your name.",
    rarity: "legendary",
  },
  serial_rivals: {
    slug: "serial_rivals",
    emoji: "🔁",
    title: "Serial Rivals",
    subtitle:
      "You've faced the same opponent across {sessions_faced} different sessions. This is personal.",
    rarity: "uncommon",
  },
  soulmates: {
    slug: "soulmates",
    emoji: "💞",
    title: "Soulmates",
    subtitle: "{games} games together across {sessions} sessions. Some partnerships just work.",
    rarity: "rare",
  },
  winning_formula: {
    slug: "winning_formula",
    emoji: "🧪",
    title: "Winning Formula",
    subtitle:
      "{win_rate}% win rate across {games} games with your go-to partner. Don't fix what ain't broken.",
    rarity: "uncommon",
  },
};

// Rarity sort order (legendary first)
const RARITY_ORDER: Record<AwardRarity, number> = {
  legendary: 0,
  rare: 1,
  uncommon: 2,
  common: 3,
};

/**
 * Sort awards so rarer ones appear first on the Wrapped page.
 */
export function sortAwardsByRarity(slugs: string[]): string[] {
  return [...slugs].sort((a, b) => {
    const ra = RARITY_ORDER[AWARD_META[a]?.rarity ?? "common"] ?? 3;
    const rb = RARITY_ORDER[AWARD_META[b]?.rarity ?? "common"] ?? 3;
    return ra - rb;
  });
}

/**
 * Display cap — return at most `n` awards, sorted rarest-first.
 * Used by the Wrapped page so the feed stays scannable when a player
 * earns many awards (e.g. session MVP + multiple milestones).
 *
 * Default cap of 6 fits comfortably on a phone screen and guarantees
 * the most prestigious tier is always shown first.
 */
export function topAwardsByRarity(slugs: string[], n: number = 6): string[] {
  return sortAwardsByRarity(slugs).slice(0, n);
}

/**
 * Replace {token} placeholders in a subtitle template with
 * values from the award_data JSONB for that specific award.
 */
export function renderSubtitle(slug: string, data: Record<string, unknown>): string {
  const meta = AWARD_META[slug];
  if (!meta) return "";
  return meta.subtitle.replace(/\{(\w+)\}/g, (_, key) => {
    const val = data[key];
    if (val === undefined || val === null) return "";
    if (typeof val === "number") {
      // Show win_pct as integer percentage
      if (key === "win_pct") return `${Math.round(Number(val))}`;
      return String(val);
    }
    return String(val);
  });
}
