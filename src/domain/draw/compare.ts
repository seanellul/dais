/**
 * Orders text by UTF-16 code units, the same on every machine.
 *
 * A draw must reproduce exactly from its seed wherever it runs. String's
 * `localeCompare` orders "Åsa", "ben" and "Ben" differently depending on the
 * process locale and the ICU data Node was built with, so the draw never uses
 * it. This comparator only decides the draw; the UI may still show names in
 * whatever order suits people.
 */
export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
