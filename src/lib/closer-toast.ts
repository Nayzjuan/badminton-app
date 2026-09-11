/**
 * Organizer-board copy for "someone closed this session".
 *
 * Players never call this — they keep the awards toast. Named copy only
 * when the closer is a different person; the closer's other tab (same
 * actorId) and a nameless poll/row signal fall back to the generic line.
 */
export function closerToastMessage(
  fallback: string,
  viewerId: string,
  actor?: { actorId?: string | null; actorName?: string | null }
): string {
  if (actor?.actorName && actor.actorId && actor.actorId !== viewerId) {
    return `${actor.actorName} closed the session.`;
  }
  return fallback;
}
