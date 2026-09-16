/** Slugs are organisation-scoped; the id makes public links unambiguous. */
export function publicPathFor(tournament: { id: string; slug: string }): string {
  return `/p/${encodeURIComponent(tournament.slug)}--${tournament.id}`;
}
