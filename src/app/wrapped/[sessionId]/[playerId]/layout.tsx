// ============================================================
// Wrapped Route Layout — full-bleed, no chrome
// ============================================================
// This layout intentionally provides nothing — it lets the
// Wrapped page render full-bleed without the PwaNavBar,
// sticky headers, or any other chrome from parent layouts.
//
// The PwaNavBar already suppresses itself on /wrapped/* via a
// pathname check. The pb-12 on <body> is fine — the Wrapped
// page uses fixed+inset-0 so it paints over that padding.
// ============================================================

export default function WrappedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
