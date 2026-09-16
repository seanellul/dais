import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Packages the pure domain layer must never import. The domain runs unchanged
// in the browser (judge PWA), in Node (server, tests) and in scripts.
const domainForbidden = [
  "next",
  "next/*",
  "react",
  "react/*",
  "react-dom",
  "react-dom/*",
  "drizzle-orm",
  "drizzle-orm/*",
  "pg",
  "@electric-sql/pglite",
  "@vercel/*",
  "pino",
  "exceljs",
  "@react-pdf/*",
  "idb",
  "@/server/*",
  "@/app/*",
  "@/judge/*",
  "@/ui/*",
  "@/components/*",
  "node:*",
  "fs",
  "path",
  "crypto",
  "os",
  "child_process",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: domainForbidden.map((pattern) => ({
            group: [pattern],
            message: "src/domain is pure: no framework, database, Node or app-layer imports.",
          })),
        },
      ],
    },
  },
  {
    files: ["src/judge/**/*.ts", "src/judge/**/*.tsx"],
    rules: {
      // Every chunk of the judge app must be in the service-worker precache.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "No dynamic import() in the judge app: lazy chunks are not precached for offline use.",
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "drizzle/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "public/sw.js",
    "public/j/sw.js",
    "public/j/swe-worker-*.js",
    "data/**",
  ]),
]);

export default eslintConfig;
