/**
 * Public surface of the database layer. Services import from here:
 *
 *   import { getDb, schema, type Db, type Tx } from "@/server/db";
 *   import { teams, type TeamRow } from "@/server/db";
 */
export * from "./schema";
export * from "./relations";
export {
  getDb,
  closeDb,
  getDbDriver,
  migrateDb,
  schema,
  type Db,
  type Tx,
  type Schema,
  type DbDriver,
  type MigrationReport,
} from "./client";
