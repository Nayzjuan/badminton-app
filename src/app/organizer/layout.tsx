import { Chakra_Petch } from "next/font/google";
import type { ReactNode } from "react";

// Chakra Petch is scoped here so the font preload hint and CSS variable
// are only injected for organizer routes — not the player or TV views.
// The root layout's --font-command falls back to Inter on non-organizer
// pages, which is acceptable since font-command is only used by
// organizer command-center components.
const chakra = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-chakra",
});

export default function OrganizerLayout({ children }: { children: ReactNode }) {
  return <div className={chakra.variable}>{children}</div>;
}
