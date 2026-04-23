-- ============================================================
-- VIP Player Tags
-- ============================================================
-- Adds two nullable columns to profiles so organizers can assign
-- a floating prestige badge to specific players.
--
-- Assignment workflow (no app UI needed):
--   Supabase Dashboard → Table Editor → profiles
--   → find player by display_name
--   → set vip_tag  = label text  (e.g. 'DEV', 'MVP')
--   → set vip_theme = theme key  (e.g. 'cyber-neon', 'gold-prestige')
--   → to remove: set both columns to NULL
--
-- Available theme keys (must match VIP_THEMES in src/lib/vip-config.ts):
--   cyber-neon | gold-prestige | crimson-elite | violet-spark
--   emerald-legend | solar-flare | arctic-ice | rose-titan
--   toxic-lime | silver-phantom
-- ============================================================

alter table public.profiles
  add column if not exists vip_tag   text default null,
  add column if not exists vip_theme text default null;

comment on column public.profiles.vip_tag is
  'VIP display label shown as a floating badge (e.g. DEV, MVP). Null = no tag.';

comment on column public.profiles.vip_theme is
  'VIP theme key controlling visual treatment. Must match a key in src/lib/vip-config.ts VIP_THEMES.';
