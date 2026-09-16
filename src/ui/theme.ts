/**
 * Theme constants shared by the layouts, the toggles and the settings page.
 *
 * Two independent switches exist:
 *   - colour theme: "neutral" (default) or "esu" (ESU Cayman). Chosen per
 *     organisation, stored in the THEME_COOKIE cookie, applied as a
 *     data-theme attribute by `ColourThemeScope` in the organiser layout.
 *     The root layout reads no cookie, so the public and judge routes can be
 *     prerendered.
 *   - mode: light, dark or system. Chosen per browser by next-themes, applied
 *     as <html class="dark">.
 *
 * Presentation mode is a third, browser-local switch (see presentation-toggle.tsx).
 */

export const THEME_COOKIE = "dais-theme";

export type ColourTheme = "neutral" | "esu";

export const COLOUR_THEMES: readonly ColourTheme[] = ["neutral", "esu"];

/** Turns a raw cookie or form value into a colour theme. Unknown values mean neutral. */
export function parseColourTheme(value: string | null | undefined): ColourTheme {
  return value === "esu" ? "esu" : "neutral";
}

/**
 * The part of Next's cookie store that `readColourThemeFromCookies` needs.
 * Structural on purpose: src/ui stays free of next/headers, so client
 * components can import this module.
 */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/**
 * Reads the colour theme from a request's cookies. Call it from a nested
 * layout that may be dynamic (the organiser shell), never from the root
 * layout: `const theme = readColourThemeFromCookies(await cookies())`.
 */
export function readColourThemeFromCookies(store: CookieReader): ColourTheme {
  return parseColourTheme(store.get(THEME_COOKIE)?.value);
}

/** localStorage key for presentation mode ("on" or "off"). */
export const PRESENTATION_STORAGE_KEY = "dais-presentation";
