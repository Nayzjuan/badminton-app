import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// Marketing site — no MDX, no Pagefind, no extraction pipeline.
// React is kept for the interactive OrganizerSandbox island (Phase 3).
export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
