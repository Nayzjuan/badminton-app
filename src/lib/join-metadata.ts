// ============================================================
// Open Graph / Twitter metadata for public join pages
// ============================================================
// Pure builder so unfurlers (Reclub, iMessage, Facebook) get a real
// preview instead of an empty card. Absolute URLs come from the root
// layout's `metadataBase`.
// ============================================================

import type { Metadata } from "next";

export function joinPageMetadata(input: {
  sessionName?: string | null;
  clubName?: string | null;
  canonicalPath: string;
}): Metadata {
  const title = input.sessionName
    ? `Join ${input.sessionName}`
    : input.clubName
      ? `Join ${input.clubName}`
      : "Join session";
  const description = input.sessionName
    ? `Open this link to join ${input.sessionName}${
        input.clubName ? ` at ${input.clubName}` : ""
      } and get in the queue.`
    : input.clubName
      ? `Open this link to join ${input.clubName}.`
      : "Open this link to join the session queue.";

  return {
    title,
    description,
    alternates: { canonical: input.canonicalPath },
    openGraph: {
      title,
      description,
      url: input.canonicalPath,
      type: "website",
      siteName: "Chillax Badminton",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}
