/// <reference types="astro/client" />

interface Window {
  /** Exposed by BaseLayout's Mermaid module script for dynamic re-rendering in /flows */
  __mermaid?: typeof import("mermaid").default;
}
