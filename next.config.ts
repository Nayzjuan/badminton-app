// ============================================================
// next.config.ts
// ============================================================
// The service worker (public/sw.js) is hand-crafted and does
// not require a build plugin. Registration is handled by
// src/components/serwist-register.tsx at runtime.
// ============================================================

import type { NextConfig } from "next";

// ── Security headers applied to every route ───────────────────────────────
//
// source: "/(.*)" applies these headers to ALL routes, including
// _next/static/, API routes, and favicon.ico. For static assets the
// headers are harmless overhead. For API routes it is safe as long as
// no endpoint needs to be embedded in an iframe or served cross-origin.
//
// ⚠️  If an OAuth callback or embeddable widget route is ever added,
// override X-Frame-Options and frame-ancestors on that specific route
// by adding a second entry to the headers() array with a narrower source.
//
// CSP uses unsafe-inline/unsafe-eval because Next.js App Router injects
// hydration scripts inline. frame-ancestors and connect-src still provide
// meaningful protection even with those flags set.
//
// X-Frame-Options is included alongside CSP frame-ancestors for older
// browser compatibility (IE11, some crawlers).
//
// connect-src covers the Supabase project subdomain. If the project is
// migrated to a custom domain, update the *.supabase.co pattern here.
//
// Strict-Transport-Security: 1-year max-age + includeSubDomains, NO preload.
// Vercel injects its own HSTS header on production, but declaring it here
// documents the policy in code and survives a platform move. Preload is
// intentionally omitted — submitting to the preload list locks every
// subdomain (including the Astro marketing site) into HTTPS-forever with
// a months-long removal path. Revisit once every subdomain is confirmed
// HTTPS-only.
const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js injects inline scripts for hydration — unsafe-inline required
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      // Supabase REST + Realtime WebSocket
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      // Service worker scope
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // Next.js 16 defaults to Turbopack. Declaring turbopack: {} here
  // suppresses the "webpack config present but no turbopack config"
  // warning in case any plugin adds a webpack entry.
  turbopack: {},

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },

  // ── Legacy club-slug alias ────────────────────────────────────────────────
  // The founding "absorb all existing sessions" club (CHILLAX) was originally
  // seeded with the slug "legacy". It was renamed to "chillax", but old links
  // still point at /c/legacy/... — bookmarks, live-session QR codes, and push
  // deep-links minted before the rename. This permanent redirect keeps every
  // one of those resolving. Realtime survives independently (channels key on
  // session UUID, not slug), so a mid-session rename only affects hard refreshes
  // of /c/legacy/... URLs, which this covers.
  async redirects() {
    return [
      {
        source: "/c/legacy/:path*",
        destination: "/c/chillax/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
