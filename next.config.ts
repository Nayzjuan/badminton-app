// ============================================================
// next.config.ts
// ============================================================
// The service worker (public/sw.js) is hand-crafted and does
// not require a build plugin. Registration is handled by
// src/components/serwist-register.tsx at runtime.
// ============================================================

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16 defaults to Turbopack. Declaring turbopack: {} here
  // suppresses the "webpack config present but no turbopack config"
  // warning in case any plugin adds a webpack entry.
  turbopack: {},
};

export default nextConfig;
