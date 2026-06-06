// ============================================================
// 404 Not Found — App Router
// ============================================================
// Rendered when Next.js cannot match a route.
// Server Component — no "use client" needed.
// ============================================================

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 text-center">
      <div className="space-y-2">
        <p className="font-command text-[9px] uppercase tracking-[0.24em] text-muted-foreground">
          404
        </p>
        <h1 className="font-display text-4xl font-bold italic text-foreground">Page Not Found</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          This page doesn&apos;t exist or has been moved.
        </p>
      </div>
      <Link
        href="/"
        className="clip-cut-sm bg-primary px-6 py-3 font-command text-[10px]
                   uppercase tracking-[0.14em] text-primary-foreground
                   hover:brightness-110 transition-all"
      >
        Go home
      </Link>
    </div>
  );
}
