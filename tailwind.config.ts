import type { Config } from "tailwindcss";

// Minimal v4-compatible config.
// Theme tokens and content scanning are handled by globals.css
// via @import "tailwindcss" and @theme inline {}.
// Only the dark mode strategy and legacy animate plugin live here.
const config: Config = {
  darkMode: "class",
};

export default config;
