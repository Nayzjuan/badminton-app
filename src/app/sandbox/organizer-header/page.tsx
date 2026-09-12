// ============================================================
// Sandbox preview — Organizer session header
// Route: /sandbox/organizer-header
// ============================================================
// The header's failure mode is layout, and layout is only falsifiable against
// a real viewport: Tailwind's lg:/xl: prefixes are viewport media queries, so
// a width-constrained container proves nothing. Resize the window instead.
// ============================================================

import { OrganizerHeaderPreview } from "@/components/organizer/organizer-header-preview";

export default function SandboxOrganizerHeaderPage() {
  return <OrganizerHeaderPreview />;
}
