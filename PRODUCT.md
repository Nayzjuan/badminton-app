# Impeccable Design Context — Chillax Badminton App

## Design Context

### Users

Recreational badminton players at an organised session (Thursday Night Badminton style venue). They check their phone standing courtside, often with one hand, in a loud gym with overhead lighting. The primary job: "where am I in the queue, and who else is waiting?" Secondary: "am I about to be called?" They want a fast, glanceable answer — not a dense data table.

### Brand Personality

**3 words: fast · competitive · electric**

The app should feel like a live sports broadcast mixed with a video-game HUD — not a generic booking system. Players are here to compete. The UI should feel like it belongs on the scoreboard at a real badminton venue, not in a hospital portal.

### Aesthetic Direction

- **Visual tone**: Sporty-futuristic. Athletic precision. Think a live tournament bracket app or a marathon runner tracker — high contrast, bold numerals, sharp geometry.
- **Dark mode**: Deep cool navy (`oklch(0.07 0.012 245)`) as the canvas. Electric emerald (`oklch(0.76 0.17 155)`) for active/in-queue states. Amber (`oklch(0.78 0.17 62)`) for on-deck urgency. Electric teal (`oklch(0.79 0.18 188)`) for organizer/command states.
- **Light mode**: Pale cool slate (`oklch(0.96 0.006 245)`) canvas. Same accent palette but darker variants for contrast on white.
- **Fonts already in project**: Barlow Condensed (bold italic display numerals), JetBrains Mono (stats/codes), Chakra Petch (command/organizer), Inter (body).
- **Anti-references**: Generic SaaS dashboards, healthcare apps, booking software, anything that looks like Tailwind UI default components.
- **References**: Live tournament brackets, stadium scoreboards, Formula 1 timing screens, sports analytics dashboards.

### Design Principles

1. **Glanceable hierarchy** — the most important info (your position, your name) must read from 2 metres away in bright gym lighting.
2. **Athletic precision** — every element has a reason to exist. No decorative cards, no lorem ipsum padding. Lean and decisive.
3. **Position is identity** — the queue position number is the hero of the waitlist. It should dominate visually.
4. **Live-data feel** — the UI should feel like it could update at any moment. Subtle animations, live counts, status pulses.
5. **Sporty not sterile** — use the Barlow Condensed italic for numbers and headings. Avoid corporate rounded rectangles with drop shadows.

---

## Organizer Dashboard Context

### Users
Session organizers — primarily on a tablet (portrait/landscape), must also work on a phone. Used mid-session in a sports hall: noisy, fast-moving, time-pressured. Often also a player, glancing between rallies. Needs at-a-glance state with minimal taps.

### Brand Personality (Organizer View)
Fast · Precise · Tactical — the organizer dashboard is a **command center**, not a player portal. Operational, sharp, efficient.

### Aesthetic Direction (Organizer View)
- **Token system**: All colours use the `cc-*` OKLCH token family (`cc-amber`, `cc-red`, `cc-accent`, etc.). Never raw Tailwind colour utilities (`amber-200`, `orange-50`) in the organizer view.
- **Geometry**: Clip-cut polygons (`clip-cut`, `clip-cut-sm`) reinforce the tactical aesthetic. Rounded corners are for the player view.
- **Typography**: `font-command` (Chakra Petch) for operational labels, buttons, and status headings. `font-display` (Barlow Condensed) for numbers.
- **Anti-reference**: Generic SaaS admin (Stripe/Linear) — no soft white cards, blue links, or enterprise neutrality.

### Organizer Design Principles
1. **Token consistency** — use `cc-amber`, `cc-red`, `cc-accent`. Never raw Tailwind colour classes in the organizer view.
2. **Geometry over roundness** — clip-cut polygons and sharp angles reinforce the tactical aesthetic.
3. **Tablet-first tap targets** — minimum 44px touch targets; never require precision taps.
4. **At-a-glance legibility** — status must be scannable in < 1 second.
