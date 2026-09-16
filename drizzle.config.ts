import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` needs no database. `drizzle-kit studio` and
// `drizzle-kit migrate` need DATABASE_URL; the app itself migrates PGlite via
// scripts/migrate.ts so local development never needs drizzle-kit at all.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/dais",
  },
  strict: true,
  verbose: true,
});
