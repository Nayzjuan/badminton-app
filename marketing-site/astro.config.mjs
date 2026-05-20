import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// Marketing site — no MDX, no Pagefind, no extraction pipeline.
// React powers the interactive sandbox island (SandboxRoot + PlayerPhone).
export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
