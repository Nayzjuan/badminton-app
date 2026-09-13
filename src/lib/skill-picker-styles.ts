// Shared skill-card colours — used by registration and the Google confirm
// / self-serve name screens so the six tiers stay visually identical.

export const SKILL_COLORS: Record<
  string,
  { descriptor: string; dot: string; idle: string; active: string }
> = {
  beginner: {
    descriptor: "Just starting out",
    dot: "bg-emerald-400 dark:bg-emerald-500",
    idle: "border-emerald-200 bg-emerald-50/60 hover:bg-emerald-50 dark:border-emerald-800/40 dark:bg-emerald-950/20 dark:hover:bg-emerald-950/30",
    active: "border-emerald-500 bg-emerald-100 dark:border-emerald-400 dark:bg-emerald-950/50",
  },
  lower_intermediate: {
    descriptor: "Getting consistent",
    dot: "bg-teal-400 dark:bg-teal-500",
    idle: "border-teal-200 bg-teal-50/60 hover:bg-teal-50 dark:border-teal-800/40 dark:bg-teal-950/20 dark:hover:bg-teal-950/30",
    active: "border-teal-500 bg-teal-100 dark:border-teal-400 dark:bg-teal-950/50",
  },
  intermediate: {
    descriptor: "Solid rallies",
    dot: "bg-sky-400 dark:bg-sky-500",
    idle: "border-sky-200 bg-sky-50/60 hover:bg-sky-50 dark:border-sky-800/40 dark:bg-sky-950/20 dark:hover:bg-sky-950/30",
    active: "border-sky-500 bg-sky-100 dark:border-sky-400 dark:bg-sky-950/50",
  },
  upper_intermediate: {
    descriptor: "Match-ready",
    dot: "bg-indigo-400 dark:bg-indigo-500",
    idle: "border-indigo-200 bg-indigo-50/60 hover:bg-indigo-50 dark:border-indigo-800/40 dark:bg-indigo-950/20 dark:hover:bg-indigo-950/30",
    active: "border-indigo-500 bg-indigo-100 dark:border-indigo-400 dark:bg-indigo-950/50",
  },
  lower_advanced: {
    descriptor: "Competitive play",
    dot: "bg-fuchsia-400 dark:bg-fuchsia-500",
    idle: "border-fuchsia-200 bg-fuchsia-50/60 hover:bg-fuchsia-50 dark:border-fuchsia-800/40 dark:bg-fuchsia-950/20 dark:hover:bg-fuchsia-950/30",
    active: "border-fuchsia-500 bg-fuchsia-100 dark:border-fuchsia-400 dark:bg-fuchsia-950/50",
  },
  advanced: {
    descriptor: "Tournament level",
    dot: "bg-purple-400 dark:bg-purple-500",
    idle: "border-purple-200 bg-purple-50/60 hover:bg-purple-50 dark:border-purple-800/40 dark:bg-purple-950/20 dark:hover:bg-purple-950/30",
    active: "border-purple-500 bg-purple-100 dark:border-purple-400 dark:bg-purple-950/50",
  },
};
