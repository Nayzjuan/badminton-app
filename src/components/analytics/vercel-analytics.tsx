"use client";

import { Analytics } from "@vercel/analytics/react";
import { canonicalizeAnalyticsPath } from "@/lib/registration-analytics";

export function VercelAnalytics({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;

  return (
    <Analytics
      beforeSend={(event) => {
        try {
          return { ...event, url: canonicalizeAnalyticsPath(event.url) };
        } catch {
          return null;
        }
      }}
    />
  );
}
