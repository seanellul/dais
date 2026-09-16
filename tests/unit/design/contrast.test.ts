/**
 * WCAG 2.2 AA contrast check over the design tokens in src/app/globals.css.
 *
 * The test parses the four token blocks (neutral light, neutral dark, ESU
 * Cayman light, ESU Cayman dark), resolves each combination the way the CSS
 * cascade does, and asserts the ratios that matter: text on every surface,
 * muted text, control borders, and the text on primary and action buttons.
 * If a token changes, this test says which pair broke and by how much.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CSS_PATH = path.resolve(__dirname, "../../../src/app/globals.css");

/* ------------------------------------------------------------------ */
/* A tiny CSS block parser                                             */
/* ------------------------------------------------------------------ */

interface Block {
  selector: string;
  declarations: Record<string, string>;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Splits top-level `selector { ... }` rules. Nested blocks stay in the body. */
function parseTopLevelBlocks(css: string): Block[] {
  const blocks: Block[] = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  let selector = "";

  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    if (char === "{") {
      if (depth === 0) {
        selector = css.slice(selectorStart, i).trim();
        bodyStart = i + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ selector, declarations: parseDeclarations(css.slice(bodyStart, i)) });
        selectorStart = i + 1;
      }
    } else if (char === ";" && depth === 0) {
      // A top-level statement such as @import; skip it.
      selectorStart = i + 1;
    }
  }
  return blocks;
}

/** Reads `--name: value;` pairs at the top level of a block body. */
function parseDeclarations(body: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ";" && depth === 0) {
      addDeclaration(declarations, body.slice(start, i));
      start = i + 1;
    }
  }
  addDeclaration(declarations, body.slice(start));
  return declarations;
}

function addDeclaration(target: Record<string, string>, text: string): void {
  const colon = text.indexOf(":");
  if (colon === -1) return;
  const name = text.slice(0, colon).trim();
  const value = text.slice(colon + 1).trim();
  if (name.startsWith("--")) target[name] = value;
}

/* ------------------------------------------------------------------ */
/* Theme resolution                                                    */
/* ------------------------------------------------------------------ */

type Theme = "neutral" | "esu";
type Mode = "light" | "dark";

const css = stripComments(readFileSync(CSS_PATH, "utf8"));
const blocks = parseTopLevelBlocks(css);

function findBlock(match: (selector: string) => boolean): Block {
  const block = blocks.find((candidate) => match(candidate.selector));
  if (!block) throw new Error("Token block not found in globals.css");
  return block;
}

const neutralLight = findBlock((s) => s.startsWith(":root") && s.includes('[data-mode="light"]'));
const neutralDark = findBlock((s) => s.startsWith(".dark") && !s.includes("esu"));
const esuLight = findBlock((s) => s === '[data-theme="esu"]');
const esuDark = findBlock((s) => s.startsWith(".dark:where") && s.includes("esu"));

/** Merges blocks in cascade order, as the browser would for <html>. */
function tokensFor(theme: Theme, mode: Mode): Record<string, string> {
  const order = [neutralLight];
  if (mode === "dark") order.push(neutralDark);
  if (theme === "esu") order.push(esuLight);
  if (theme === "esu" && mode === "dark") order.push(esuDark);
  return Object.assign({}, ...order.map((block) => block.declarations));
}

/** Follows var(--x) references until a literal value remains. */
function resolve(tokens: Record<string, string>, name: string, depth = 0): string {
  if (depth > 10) throw new Error(`Circular token: ${name}`);
  const value = tokens[name];
  if (value === undefined) throw new Error(`Missing token: ${name}`);
  const reference = /^var\((--[\w-]+)/.exec(value);
  return reference ? resolve(tokens, reference[1], depth + 1) : value;
}

/* ------------------------------------------------------------------ */
/* WCAG maths                                                          */
/* ------------------------------------------------------------------ */

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) throw new Error(`Not a six-digit hex colour: ${hex}`);
  return [0, 2, 4].map((offset) => parseInt(clean.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  );
  return (light + 0.05) / (dark + 0.05);
}

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

interface Pair {
  foreground: string;
  background: string;
  minimum: number;
}

/** Text is 4.5:1; borders and focus rings, as UI boundaries, are 3:1. */
const PAIRS: Pair[] = [
  { foreground: "--text", background: "--bg", minimum: 4.5 },
  { foreground: "--text", background: "--surface", minimum: 4.5 },
  { foreground: "--text", background: "--surface-sunken", minimum: 4.5 },
  { foreground: "--text", background: "--surface-raised", minimum: 4.5 },
  { foreground: "--text-secondary", background: "--bg", minimum: 4.5 },
  { foreground: "--text-secondary", background: "--surface", minimum: 4.5 },
  { foreground: "--text-secondary", background: "--surface-sunken", minimum: 4.5 },
  { foreground: "--text-muted", background: "--bg", minimum: 4.5 },
  { foreground: "--text-muted", background: "--surface", minimum: 4.5 },
  { foreground: "--text-muted", background: "--surface-raised", minimum: 4.5 },
  { foreground: "--border-strong", background: "--surface", minimum: 3 },
  { foreground: "--border-strong", background: "--surface-raised", minimum: 3 },
  { foreground: "--focus", background: "--surface", minimum: 3 },
  { foreground: "--focus", background: "--bg", minimum: 3 },
  { foreground: "--on-primary", background: "--primary", minimum: 4.5 },
  { foreground: "--on-primary", background: "--primary-hover", minimum: 4.5 },
  { foreground: "--on-action", background: "--action", minimum: 4.5 },
  { foreground: "--on-action", background: "--action-hover", minimum: 4.5 },
  { foreground: "--link", background: "--bg", minimum: 4.5 },
  { foreground: "--link", background: "--surface", minimum: 4.5 },
  { foreground: "--accent-text", background: "--surface", minimum: 4.5 },
  { foreground: "--success", background: "--success-surface", minimum: 4.5 },
  { foreground: "--success", background: "--surface", minimum: 4.5 },
  { foreground: "--warning", background: "--warning-surface", minimum: 4.5 },
  { foreground: "--warning", background: "--surface", minimum: 4.5 },
  { foreground: "--danger", background: "--danger-surface", minimum: 4.5 },
  { foreground: "--danger", background: "--surface", minimum: 4.5 },
  { foreground: "--info", background: "--info-surface", minimum: 4.5 },
  { foreground: "--info", background: "--surface", minimum: 4.5 },
  { foreground: "--side-gov", background: "--side-gov-surface", minimum: 4.5 },
  { foreground: "--side-gov", background: "--surface", minimum: 4.5 },
  { foreground: "--side-opp", background: "--side-opp-surface", minimum: 4.5 },
  { foreground: "--side-opp", background: "--surface", minimum: 4.5 },
  { foreground: "--on-highlight", background: "--highlight-surface", minimum: 4.5 },
  { foreground: "--text", background: "--highlight-soft", minimum: 4.5 },
  { foreground: "--on-topbar", background: "--topbar", minimum: 4.5 },
  { foreground: "--teal-text", background: "--surface", minimum: 4.5 },
  { foreground: "--teal-text", background: "--bg", minimum: 4.5 },
];

const COMBINATIONS: { theme: Theme; mode: Mode }[] = [
  { theme: "neutral", mode: "light" },
  { theme: "neutral", mode: "dark" },
  { theme: "esu", mode: "light" },
  { theme: "esu", mode: "dark" },
];

describe.each(COMBINATIONS)("$theme theme, $mode mode", ({ theme, mode }) => {
  const tokens = tokensFor(theme, mode);

  it.each(PAIRS)("$foreground on $background is at least $minimum:1", (pair) => {
    const foreground = resolve(tokens, pair.foreground);
    const background = resolve(tokens, pair.background);
    const ratio = contrastRatio(foreground, background);
    expect(
      ratio,
      `${pair.foreground} ${foreground} on ${pair.background} ${background} is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(pair.minimum);
  });
});

describe("token blocks", () => {
  it("finds all four theme blocks", () => {
    expect(neutralLight.selector).toContain(":root");
    expect(neutralDark.selector).toContain(".dark");
    expect(esuLight.selector).toBe('[data-theme="esu"]');
    expect(esuDark.selector).toContain('[data-theme="esu"]');
  });

  it("keeps the spec's headline colours", () => {
    expect(neutralLight.declarations["--bg"]).toBe("#f4f6f8");
    expect(neutralLight.declarations["--primary"]).toBe("#1f4e8c");
    expect(neutralLight.declarations["--side-opp"]).toBe("#7a3b5e");
    expect(neutralDark.declarations["--primary"]).toBe("#7fb0f0");
    expect(esuLight.declarations["--bg"]).toBe("#f6f1e7");
    expect(esuLight.declarations["--primary"]).toBe("#0a2540");
    expect(esuLight.declarations["--action"]).toBe("#e87f5a");
    expect(esuLight.declarations["--highlight-surface"]).toBe("#f2d9a4");
    expect(esuDark.declarations["--primary"]).toBe("#2cb8c9");
  });

  it("ESU dark redefines every token that ESU light sets, so dark never shows light values", () => {
    // Cascade order is neutral light, neutral dark, ESU light, ESU dark. Any
    // token ESU light sets but ESU dark does not would leak a light value
    // into dark mode.
    const missing = Object.keys(esuLight.declarations).filter(
      (name) => !(name in esuDark.declarations),
    );
    expect(missing).toEqual([]);
  });

  it("neutral dark only overrides tokens the neutral light block defines", () => {
    const unknown = Object.keys(neutralDark.declarations).filter(
      (name) => !(name in neutralLight.declarations),
    );
    expect(unknown).toEqual([]);
  });

  it("every theme block sets the same colour tokens as the neutral light master list", () => {
    const colourNames = Object.keys(neutralLight.declarations).filter((name) =>
      /^#/.test(neutralLight.declarations[name]),
    );
    for (const block of [neutralDark, esuLight, esuDark]) {
      const missing = colourNames.filter((name) => !(name in block.declarations));
      expect(missing, `${block.selector} is missing`).toEqual([]);
    }
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#1f4e8c", "#ffffff")).toBeCloseTo(8.31, 1);
  });
});
