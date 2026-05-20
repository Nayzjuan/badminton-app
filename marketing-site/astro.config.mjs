import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Marketing site — no MDX, no Pagefind, no extraction pipeline.
// React powers the interactive sandbox island (SandboxRoot + PlayerPhone).
//
// @bbmt/digital-twin alias:
//   Points Vite directly at the digital-twin's SandboxRoot source file.
//   The 15 sandbox files no longer live as copies under marketing-site/src/sandbox/ —
//   Vite resolves the alias, follows the relative imports inside SandboxRoot.tsx
//   as they exist in digital-twin/src/sandbox/, and bundles them on demand.
//
//   server.fs.allow: ['..'] lets the Vite dev server read files from the
//   sibling digital-twin/ directory (one level above marketing-site/).
//   The build process already follows imports across directory boundaries
//   regardless of this setting — this only affects the dev server.
//
// ⚠️  DEPLOY REQUIREMENT:
//   This alias requires the full monorepo to be present (digital-twin/ must
//   exist as a sibling of marketing-site/). GitHub-integrated Vercel deploys
//   always clone the full repo and will work correctly. CLI-only deploys
//   (e.g. `vercel --prod` run from inside marketing-site/) will fail because
//   digital-twin/ is not uploaded. Use GitHub-integrated deploys only.
export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@bbmt/digital-twin': path.resolve(__dirname, '../digital-twin/src/sandbox/SandboxRoot.tsx'),
      },
      // Force Vite to resolve these from marketing-site/node_modules even when
      // the importing file lives under digital-twin/. Without dedupe, Vite walks
      // up from digital-twin/ and fails on Vercel where only marketing-site deps
      // are installed.
      dedupe: [
        'react',
        'react-dom',
        '@dnd-kit/core',
        '@dnd-kit/sortable',
        '@dnd-kit/modifiers',
        '@dnd-kit/utilities',
      ],
    },
    server: {
      fs: {
        allow: [path.resolve(__dirname, '..')],
      },
    },
  },
});
