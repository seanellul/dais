import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `standalone` produces .next/standalone/server.js, which the Dockerfile runs.
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
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

export default nextConfig;
