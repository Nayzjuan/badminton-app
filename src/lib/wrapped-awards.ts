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
    subtitle: "{total_points} points scored tonight. The scoreboard was basically your highlight reel.",
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
    subtitle: "{losses} losses tonight. You're either building resilience or something is deeply wrong.",
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
    subtitle: "{nemesis_name} beat you {loss_count} times tonight. Respectfully: we have a problem.",
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
    subtitle: "Lost {narrow_losses} games by 2 points or less. The margin was this thin. Every. Single. Time.",
    rarity: "uncommon",
  },
  deuce_magnet: {
    slug: "deuce_magnet",
    emoji: "🎭",
    title: "Deuce Magnet",
    subtitle: "{deuce_games} of your games went to 20-20. Drama follows you everywhere.",
    rarity: "uncommon",
  },

  // ── COMEDIC ────────────────────────────────────────────────
  participation_trophy: {
    slug: "participation_trophy",
    emoji: "🫶",
    title: "Participation Trophy",
    subtitle: "0 wins. But you laced up your shoes and showed up. That's genuinely half the battle.",
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
};

// Rarity sort order (legendary first)
const RARITY_ORDER: Record<AwardRarity, number> = {
  legendary: 0,
  rare:      1,
  uncommon:  2,
  common:    3,
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
