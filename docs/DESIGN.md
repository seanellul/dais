# Dais design system

This document explains how the Dais interface is built: the tokens, the two
themes, light and dark modes, presentation mode, the component inventory,
print and the accessibility checklist. The code lives in `src/app/globals.css`,
`src/app/print.css`, `src/app/layout.tsx` and `src/ui/`. The gallery at
`/design` renders every component in every theme and mode.

## Direction

"Order of the day": the calm of a printed order paper. Generous white, ruled
tables, a serif display face for names and headings, tabular numerals wherever
numbers matter, one accent for the single primary action on a screen, tinted
(not saturated) status surfaces, and motion only when data changes. No
gradients, no glass, no large drop shadows, no emoji.

Principles the components follow:

1. One primary action per screen. `ActionButton` is that action; everything else
   is a plain shadcn `Button`.
2. Plain tournament words in every string (see `CLAUDE.md`, Vocabulary).
3. Status is never colour alone. Chips and tags carry an icon and text.
4. Works on a 390px phone with one thumb and on a projector at three metres.

## Token architecture

Three layers, each defined once in `globals.css`:

```
primitives (hex values)
  -> Dais semantic tokens   --bg, --surface, --text, --primary, --success-surface ...
     -> shadcn aliases      --background, --card, --ring, --destructive ...
        -> Tailwind theme   bg-surface, text-text-muted, font-display ...
```

Themes override **semantic tokens only**. The shadcn aliases point at semantic
tokens with `var()`, so every shadcn component follows the active theme
without its own theme code. `@theme inline` exposes both sets to Tailwind, so a
utility such as `bg-success-surface` or `text-primary-foreground` reads the
same token.

### Selecting a theme and mode

| Switch            | Where it lives                        | Applied as                                  |
| ----------------- | ------------------------------------- | ------------------------------------------- |
| Colour theme      | cookie `dais-theme` (`neutral`/`esu`) | `data-theme="esu"` on a wrapper element     |
| Light / dark      | next-themes, per browser              | `<html class="dark">` or `.light`           |
| Presentation mode | localStorage `dais-presentation`      | `<html data-presentation="on">`             |
| Forced panel      | a page element                        | `data-mode="light\|dark"`, `data-theme="…"` |

The root layout reads **no** cookie, header or search param. A request API in
the root layout would make every route dynamic, including the judge app that
the service worker must precache and the public page that should be cached.
Instead, a nested layout that is dynamic anyway (the organiser shell) reads
the cookie and wraps its content:

```tsx
import { cookies } from "next/headers";
import { ColourThemeScope, readColourThemeFromCookies } from "@/ui";

// The LayoutProps key is the layout's own route ("/" for a route-group layout).
export default async function OrgLayout({ children }: LayoutProps<"/">) {
  const theme = readColourThemeFromCookies(await cookies());
  return <ColourThemeScope theme={theme}>{children}</ColourThemeScope>;
}
```

`ColourThemeScope` renders a `display: contents` div with `data-theme`. The
tokens are custom properties, so the attribute works on any ancestor. The
marketing and judge layouts do not read the cookie and stay static.

`data-mode` exists for the design gallery and any preview that must show a
mode regardless of the viewer's setting. It resets the **colours** to the
neutral theme; the fonts follow `data-theme`, so a panel that wants neutral
fonts inside an ESU page sets `data-theme="neutral"` too. The `dark:` Tailwind
variant honours `data-mode`: it applies inside `.dark` or `[data-mode="dark"]`
but never inside `[data-mode="light"]`.

### Cascade order

The token blocks all have specificity (0,1,0), so source order decides:

1. `:root, [data-mode="light"]` — neutral light colours. The master list.
2. `:root, [data-theme="neutral"]` — neutral fonts (`--type-body`,
   `--type-display`, `--type-display-alt`, `--type-mono`).
3. `.dark, [data-mode="dark"]` — neutral dark colours.
4. `[data-theme="esu"]` — ESU Cayman light colours and fonts.
5. `.dark:where([data-theme="esu"])`, `[data-mode="dark"]:where([data-theme="esu"])`,
   `:where(.dark) [data-theme="esu"]:where(:not([data-mode="light"]))` — ESU
   Cayman dark. The third selector is the wrapper case: `data-theme` on a
   descendant of a dark `<html>`. `:where()` keeps specificity flat.
6. `[data-presentation="on"]` — presentation overrides, repeated at (0,2,0)
   for `[data-theme]` and `[data-mode]` elements, because an element's own
   token beats an inherited one.

Rule: the ESU dark block must redefine every token the ESU light block sets,
or a light value would leak into dark mode. `tests/unit/design/contrast.test.ts`
enforces this, and also that every theme block sets every colour token.

### Semantic tokens

Surfaces and text: `--bg`, `--surface`, `--surface-sunken`, `--surface-raised`,
`--text`, `--text-secondary`, `--text-muted`, `--text-inverse`, `--border`,
`--border-strong` (inputs and controls, 3:1), `--divider`.

Actions: `--primary`, `--primary-hover`, `--primary-surface`, `--on-primary`;
`--action`, `--action-hover`, `--on-action` (the one accent; equals primary in
neutral, coral in ESU); `--link`, `--accent-text`, `--focus`.

Status: `--success`, `--warning`, `--danger`, `--info`, each with a
`-surface`. Sides: `--side-gov`, `--side-opp`, each with a `-surface`.
Highlight: `--highlight-surface`, `--on-highlight`, `--highlight-soft`
(provisional banners, the current step). `--band-fill` (single hue for the band
bar). `--topbar`, `--on-topbar`. `--teal` (decorative only), `--teal-text`.

Spacing: `--space-1` (4px) … `--space-24` (96px); Tailwind's numeric scale
agrees (`p-4` = 16px). Radius: `--radius-sm` 4, `--radius-md` 8, `--radius-lg`
12, `--radius-xl` 16, `--radius-pill` 999; these also drive `rounded-sm…xl` and
`rounded-pill`. Elevation: `--shadow-1/2/3`, used through `elevation-0/1/2/3`
utilities (dark mode and presentation mode set them to none). Motion:
`--dur-fast` 120ms, `--dur-base` 200, `--dur-slow` 320, `--dur-deliberate` 600,
`--dur-shuffle` 1200; `--ease-standard`, `--ease-emphasized`, `--ease-exit`.
Reduced motion sets durations to 0. Layers: `--z-sticky` 10, `--z-drawer` 20,
`--z-dialog` 30, `--z-toast` 40. Density: `--row-h` (40px; `StepRow` and any
`DataTable` row use it as `min-height`), `--control-h` (44px; `ActionButton`
md and `PresentationToggle`), `--chip-fs`.

### Palette

Neutral light: bg `#f4f6f8`, surface `#ffffff`, text `#16202b`, secondary
`#46525f`, muted `#5b6874`, border `#d5dbe1`, border-strong `#8b96a1`, primary
`#1f4e8c`, success `#1f7a4d`, warning `#8a5a00`, danger `#b3261e`, gov
`#1f4e8c`, opp `#7a3b5e`, highlight `#fff8e6`.

Neutral dark: bg `#0b1117`, surface `#0f1720`, raised `#16212c`, text
`#e8edf2`, muted `#93a0ad`, primary `#7fb0f0` on `#0b1117`, success `#6fcf97`,
warning `#f2c56b`, danger `#f28b82`, opp `#d79bc0`. Status surfaces are 16%
tints of the status colour over the surface.

ESU Cayman light: bg `#f6f1e7`, surface `#fffdf8`, text `#061628`, primary navy
`#0a2540`, action coral `#e87f5a` with `#061628` text (buttons and the band bar
only), accent text `#b84d2a`, highlight sand `#f2d9a4`, teal `#2cb8c9`
(decorative only), topbar `#061628`.

ESU Cayman dark: bg `#061628`, surface `#0a2540`, raised `#11315a`, text
`#eef2f7`, muted `#a9b8cc`, primary and link `#2cb8c9`, action `#e87f5a`,
highlight `#3a3320` with `#f2d9a4` text.

Four values differ from the planning spec, each because the spec value failed
the ratio the contrast test enforces:

| Token                          | Spec      | Shipped   | Reason                              |
| ------------------------------ | --------- | --------- | ----------------------------------- |
| neutral dark `--border-strong` | `#55636f` | `#5e6d79` | 2.92:1 on the surface; now 3.39:1   |
| ESU light `--side-opp`         | `#b84d2a` | `#ad4624` | 4.32:1 on its surface; now 4.85:1   |
| ESU light `--teal-text`        | `#167c8a` | `#14707d` | 4.35:1 on the page; now 5.12:1      |
| ESU dark `--border-strong`     | (none)    | `#6b829c` | 3.92:1 on surface, 3.29:1 on raised |

Also note: neutral light `--border-strong` is 3.01:1 on the surface but 2.78:1
on the page background. Put inputs on a surface (card or fieldset), not
directly on the page.

## Typography

Fonts load through `next/font/google` in `layout.tsx`, self-hosted at build
time, `display: swap`, latin subset:

| Variable                  | Font             | Used as                                    |
| ------------------------- | ---------------- | ------------------------------------------ |
| `--font-inter`            | Inter            | body, neutral (`--font-sans`)              |
| `--font-source-serif-4`   | Source Serif 4   | display, neutral                           |
| `--font-fraunces`         | Fraunces         | display, ESU (`--font-display`)            |
| `--font-instrument-serif` | Instrument Serif | large numerals, ESU (`--font-display-alt`) |
| `--font-inter-tight`      | Inter Tight      | body, ESU (`--font-sans-esu`)              |
| `--font-jetbrains-mono`   | JetBrains Mono   | codes and seeds (`--font-mono`)            |

Only Inter and Source Serif 4 are preloaded. The others download when a page
uses them, so the judge phone fetches no display font. Fonts follow the colour
theme, not the mode: a print sheet or a light panel inside an ESU page keeps
the ESU faces.

Scale (Tailwind utilities, size/line-height at a 16px root): `text-display-xl`
44/48, `text-display` 32/38, `text-h1` 28/34, `text-h2` 22/28, `text-h3` 18/24,
`text-body-lg` 18/28, `text-body` 16/24, `text-body-sm` 14/20, `text-caption`
12/16, `text-numeral-xl` 56/60, `text-numeral-lg` 40/44, `text-numeral` 28/32,
`text-mono` 14/20, `text-eyebrow` (12px, uppercase, +0.08em, secondary colour;
the only uppercase). Weights 400, 500, 600 only.

Tabular numerals are on by default for `<table>`, `.tabular`, `<time>`, code,
and numeric inputs. Use `<Tabular>` for inline numbers in prose.

### Class merging: import `cn` from `@/ui/cn`

The `cn` helper from the "cn" package resolves conflicting Tailwind classes,
but it only knows Tailwind's own scale. It reads a custom size such as
`text-h3` or `text-body-lg` as a text **colour**, so `cn("text-h3 text-text")`
silently drops one of them. `src/ui/cn.ts` registers the type scale and the
`elevation-*` utilities with the merge engine. Every file in `src/ui` and
`src/app` imports `cn` from `@/ui/cn` (also exported from `@/ui`). The shadcn
files in `src/components/ui` import it from `@/lib/utils`, which re-exports
the same extended `cn`, so a custom `text-*` size passed through a shadcn
component's `className` merges correctly too. Keep that import when a shadcn
component is regenerated: the generator writes `from "cn"`.
`tests/unit/design/components.test.ts` pins the behaviour.

## Presentation mode

`<html data-presentation="on">` raises the root font size to 20px (125%),
sets `--row-h` to 52px and `--control-h` to 48px, chip text to 16px, uses
`--border-strong` for `--border`, and drops level-1 shadows. It persists per
browser in localStorage and follows changes made in another tab.
`usePresentationMode()` reads and writes it; `PresentationToggle` is the button
for the organiser top bar. Any mounted caller keeps the attribute in sync, so
the organiser shell should render the toggle (or call the hook) on every page.
The "p" shortcut belongs to the shell's key handler, which should call the
hook's setter.

## Component inventory (`src/ui`)

| Component                           | Purpose                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ActionButton`                      | The one accent button per screen; `.action-button` class, 44px (md) or 56px (lg).              |
| `StatusChip`                        | Pill with icon and text: neutral, success, warning, danger, info, muted-struck.                |
| `Banner`                            | Page-level state with `role="status"`: provisional, offline, sandbox, readonly, info.          |
| `StepRow`                           | One run-sheet line: number, status, title, summary, action, overflow. At least `--row-h` tall. |
| `NowCard`                           | Large numeral and progress strip for the dashboard.                                            |
| `ProgressStrip`, `clampProgress`    | Thin bar with a text label ("2 of 4 scored").                                                  |
| `EmptyState`                        | Title, one sentence, one action.                                                               |
| `SideTag`, `RoleTag`                | Gov/Opp and PM/LO/GM/OM, full label always available.                                          |
| `BandBar`, `findBand`               | Five segments, one hue, filled to the active band.                                             |
| `NumberField`, `rangeError`         | Score input: numeric keypad, 16px text, 48px tall, ARIA wiring, its own `min`/`max` check.     |
| `OverallField`                      | Large numeral input, band bar, band description (live region).                                 |
| `SegmentedControl`                  | Accessible radio group, 48px (md, judge) or 44px (sm, organiser toolbars).                     |
| `Stepper`                           | Numbered steps in a labelled group with `aria-current="step"`.                                 |
| `StickyActionBar`                   | Bottom bar with safe-area padding.                                                             |
| `LiveRegionProvider`, `useAnnounce` | Polite (batched, one per 3s, `createPoliteQueue`) and assertive announcements.                 |
| `PrintPage`                         | A4 wrapper with header and footer stamps; forces light mode on screen.                         |
| `PageHeader`                        | The page h1 (focusable, id `page-title`), subtitle, actions.                                   |
| `ColourThemeScope`                  | Applies a colour theme to its children (`data-theme` wrapper).                                 |
| `Tabular`, `Kbd`                    | Inline helpers.                                                                                |
| `ThemeToggle`                       | Light / dark / system.                                                                         |
| `PresentationToggle`                | Presentation mode on/off.                                                                      |

`NumberField` validates `min` and `max` itself, because its input is
`type="text"` (for the numeric keypad) and the browser ignores those
attributes there. A value outside the range shows "Enter a whole number from
0 to 33.", sets `aria-invalid` and links the message with `aria-describedby`.
A caller's `error` prop replaces that message.

Everything else (Button, Card, Dialog, Drawer, Table, Tabs, Select, Textarea,
Tooltip, Skeleton, Toaster) is shadcn from `src/components/ui`, themed through
the aliases.

## Print

`src/app/print.css` (imported once in the root layout): `@page` A4 with 14mm
margins, a named `landscape` page for results, navigation and buttons hidden,
black on white regardless of theme, `thead` repeated on every page,
`break-inside: avoid` on rows, cards and fieldsets, one `.print-page` per
sheet with `break-after: page`. Header stamp: tournament, document, generated
time, Provisional/Published. Footer: organisation name. No URLs after links.
Use `.print-only` and `.screen-only` for content that exists in one medium.

On screen, `PrintPage` sets `data-mode="light"` on itself, so an organiser in
dark mode previews light-mode chips, borders and secondary text on the white
sheet. Fonts still follow the theme.

## Accessibility checklist (WCAG 2.2 AA)

- Contrast: text 4.5:1, borders and focus 3:1, enforced by
  `tests/unit/design/contrast.test.ts` over every theme and mode.
- Structure: `lang="en-GB"`; skip link to `#main` in the root layout; each
  route group's layout renders `<main id="main" tabIndex={-1}>` with the
  group's header, nav and footer **beside** it, so banner, navigation, main
  and contentinfo are all top-level landmarks (`src/app/(marketing)/layout.tsx`
  is the model); one h1 per page via `PageHeader`; tables with `<caption>` and
  `th scope`.
- Focus: one 3px ring in `--focus` with 2px offset on every element; the shell
  should focus `#page-title` after navigation; `scroll-padding-bottom` keeps
  fields visible above the sticky bar.
- Status: never colour alone; chips and tags carry icon and text; side and role
  tags carry the full word for screen readers.
- Forms: `NumberField` wires label, hint and error with `aria-describedby` and
  `aria-invalid`, and checks its own range; inputs are 16px or larger;
  `inputmode="numeric"`.
- Targets: 44px minimum (`--control-h`); 48px on the judge sheet (`touch-target`,
  `SegmentedControl` md).
- Live regions: one polite (batched) and one assertive, through `useAnnounce`.
- Motion: durations come from tokens that go to 0 under
  `prefers-reduced-motion`; nothing auto-plays longer than 1.2s.
- Forced colours: chips, banners and band segments keep visible borders.
- Zoom and reflow: layouts use rem and flex/grid; presentation mode is a
  root font-size change, so 200% zoom needs no special handling.
