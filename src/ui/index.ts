/**
 * Dais components. Each one is small, typed, keyboard-operable and follows the
 * active theme (neutral or ESU Cayman, light or dark) through the tokens in
 * src/app/globals.css. docs/DESIGN.md lists them with their purpose.
 *
 * Client-only components ("use client") are exported from here too; importing
 * them from a Server Component is fine, the boundary sits inside each file.
 */

export { ActionButton, type ActionButtonProps } from "./action-button";
export { BandBar, findBand, sortBands, type BandBarProps, type BandMatch } from "./band-bar";
export { Banner, type BannerKind, type BannerProps } from "./banner";
export { cn } from "./cn";
export { ColourThemeScope, type ColourThemeScopeProps } from "./colour-theme-scope";
export { EmptyState, type EmptyStateProps } from "./empty-state";
export { Kbd } from "./kbd";
export {
  LiveRegion,
  LiveRegionProvider,
  POLITE_BATCH_MS,
  useAnnounce,
  type Announce,
  type AnnounceOptions,
} from "./live-region";
export { NowCard, type NowCardProps } from "./now-card";
export {
  NumberField,
  rangeError,
  type NumberFieldProps,
  type NumberFieldSize,
} from "./number-field";
export { OverallField, type OverallFieldProps } from "./overall-field";
export { PageHeader, type PageHeaderProps } from "./page-header";
export { PresentationToggle, usePresentationMode } from "./presentation-toggle";
export { PrintPage, type PrintPageProps, type PrintStatus } from "./print-page";
export {
  ProgressStrip,
  clampProgress,
  type Progress,
  type ProgressStripProps,
} from "./progress-strip";
export { RoleTag, type RoleTagProps } from "./role-tag";
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from "./segmented-control";
export { SIDE_LABELS, SideTag, type SideTagProps } from "./side-tag";
export { StatusChip, type StatusChipProps, type StatusChipVariant } from "./status-chip";
export { StepRow, type StepRowProps, type StepStatus } from "./step-row";
export { Stepper, type StepperProps } from "./stepper";
export { StickyActionBar, type StickyActionBarProps } from "./sticky-action-bar";
export { Tabular } from "./tabular";
export {
  COLOUR_THEMES,
  PRESENTATION_STORAGE_KEY,
  THEME_COOKIE,
  parseColourTheme,
  readColourThemeFromCookies,
  type ColourTheme,
  type CookieReader,
} from "./theme";
export { ThemeToggle } from "./theme-toggle";
