/**
 * Class-name merging that knows the Dais type scale.
 *
 * `cn` from the "cn" package (a clsx + tailwind-merge replacement) decides
 * which of two conflicting Tailwind classes to keep. It only knows Tailwind's
 * default scale, so it reads every custom `text-*` utility from globals.css
 * (`text-h3`, `text-body-lg`, `text-caption`, ...) as a text COLOUR. Mixing
 * one with a real colour, `cn("text-h3 text-text")`, then drops one of them.
 *
 * This module registers the scale with the merge engine so a size and a
 * colour can live side by side, and `text-body-lg` replaces `text-sm` the way
 * `text-lg` would. Every Dais component and page imports `cn` from here.
 *
 * tests/unit/design/components.test.ts pins the behaviour.
 */

import { createCn } from "cn/config";

/** Every custom font-size utility in globals.css, without the `text-` prefix. */
export const TYPE_SCALE = [
  "display-xl",
  "display",
  "h1",
  "h2",
  "h3",
  "body-lg",
  "body",
  "body-sm",
  "caption",
  "numeral-xl",
  "numeral-lg",
  "numeral",
  "mono",
] as const;

/** The elevation utilities (`elevation-0` ... `elevation-3`), which conflict with each other. */
export const ELEVATION_LEVELS = ["0", "1", "2", "3"] as const;

export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TYPE_SCALE] }],
      elevation: [{ elevation: [...ELEVATION_LEVELS] }],
    },
  },
});
