import type { ReactNode } from "react";

import type { ColourTheme } from "@/ui/theme";

export interface ColourThemeScopeProps {
  theme: ColourTheme;
  children: ReactNode;
}

/**
 * Applies a colour theme to everything inside it. The tokens in globals.css
 * are custom properties, so a `data-theme` attribute on any ancestor is
 * enough; the wrapper is `display: contents` and takes no space.
 *
 * The organiser layout wraps its shell in this after reading the cookie:
 *
 *   const theme = readColourThemeFromCookies(await cookies());
 *   return <ColourThemeScope theme={theme}>...</ColourThemeScope>;
 *
 * The root layout must not do this: reading a cookie there would make every
 * route dynamic, including the judge app that the service worker precaches.
 */
export function ColourThemeScope({ theme, children }: ColourThemeScopeProps) {
  return (
    <div data-theme={theme} className="contents">
      {children}
    </div>
  );
}
