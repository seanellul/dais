/**
 * shadcn's `cn` alias (components.json points its `utils` alias here).
 *
 * Re-exported from `@/ui/cn` so the generated components in
 * `src/components/ui` merge classes with the same engine as the rest of Dais,
 * one that knows the type scale (`text-h3`, `text-body-lg`, ...) and the
 * `elevation-*` utilities. See docs/DESIGN.md, "Class merging".
 */
export { cn } from "@/ui/cn";
