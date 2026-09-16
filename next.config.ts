import type { NextConfig } from "next";
import { randomUUID } from "node:crypto";
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "src/judge/sw.ts",
  swDest: "public/j/sw.js",
  swUrl: "/j/sw.js",
  scope: "/j/",
  register: false,
  cacheOnNavigation: false,
  reloadOnOnline: false,
  disable: process.env.NODE_ENV !== "production",
  additionalPrecacheEntries: [{ url: "/j/", revision: randomUUID() }],
});

const nextConfig: NextConfig = {
  // `standalone` produces .next/standalone/server.js, which the Dockerfile runs.
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // Keep the installed judge app inside its /j/ service-worker scope.
  skipTrailingSlashRedirect: true,
  async headers() {
    return [
      {
        source: "/j/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/j/" },
        ],
      },
    ];
  },
  // Native / Node-only packages must not be bundled into the server build.
  serverExternalPackages: [
    "pg",
    "pino",
    "pino-pretty",
    "exceljs",
    "@react-pdf/renderer",
    "@electric-sql/pglite",
  ],
};

export default withSerwist(nextConfig);
