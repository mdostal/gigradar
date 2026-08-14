// The ONE shared SQLite connection for this process. Every other file in
// src/lib/store calls getDb() — nothing here or outside this module should
// ever do `new DatabaseSync(...)` at a random call site.
//
// Driver choice: `node:sqlite`, not `better-sqlite3`. On this project's
// target Node (22.x) `node:sqlite` is real but still flag-gated
// (`--experimental-sqlite`) rather than a hard dependency that needs a
// native addon compiled (node-gyp) for every platform/arch/Node ABI
// combination gigradar might run on. That native-compile step is exactly
// the kind of thing that breaks silently on a contributor's machine or CI
// image; the built-in module has no install step at all. The tradeoff is
// living with the experimental flag until it's unflagged upstream — set via
// NODE_OPTIONS in this repo's npm scripts (see package.json).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { getDefaultDbPath } from "./path.js";
import { SCHEMA_SQL } from "./schema.js";

// `node:sqlite` is loaded via createRequire (not a static `import`) so a
// missing --experimental-sqlite flag surfaces as our own explainable error
// at first *use*, not as an opaque ESM load failure the moment this file is
// imported by anything (e.g. a route that doesn't even touch the store).
const nodeRequire = createRequire(import.meta.url);

/**
 * SQLite will keep retrying a locked write for up to this long before
 * throwing SQLITE_BUSY. This — plus WAL mode — is what lets a Next.js dev
 * server and a separate cron/CLI process share this one file without one of
 * them exploding on a lock collision.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

let shared: DatabaseSyncType | undefined;
let sharedPath: string | undefined;

function loadDatabaseSyncCtor(): typeof DatabaseSyncType {
  try {
    return (nodeRequire("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
  } catch (e) {
    throw new Error(
      "gigradar store: `node:sqlite` is not available in this Node process. " +
        "On Node 22 it ships behind a flag — run with `NODE_OPTIONS=--experimental-sqlite` " +
        "(or `node --experimental-sqlite ...`); this repo's npm scripts already set it. " +
        `Original error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** True for a node:sqlite error wrapping SQLITE_BUSY (code 5). */
function isSqliteBusyError(e: unknown): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException & { errcode?: number }).errcode === 5;
}

/** Synchronous sleep — node:sqlite's API is sync, so a real setTimeout can't be awaited here. */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `sql` and, if it throws SQLITE_BUSY, retries with a short backoff
 * until `maxWaitMs` elapses. Needed specifically for the two brand-new
 * connections racing to create the file, then convert it to WAL / create the
 * schema, at the exact same instant — that "cold start" moment can throw
 * SQLITE_BUSY even with `busy_timeout` set, because the exclusivity these
 * statements need is briefly independent of the standard busy handler.
 * (Normal reads/writes after the file exists rely on busy_timeout alone.)
 */
function execWithBusyRetry(db: DatabaseSyncType, sql: string, maxWaitMs: number): void {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  for (;;) {
    try {
      db.exec(sql);
      return;
    } catch (e) {
      attempt += 1;
      if (!isSqliteBusyError(e) || Date.now() >= deadline) throw e;
      sleepSyncMs(Math.min(10 * attempt, 100));
    }
  }
}

function openConnection(dbPath: string, busyTimeoutMs: number): DatabaseSyncType {
  const DatabaseSync = loadDatabaseSyncCtor();
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  // The `timeout` constructor option (busy_timeout) only landed in Node
  // v22.16.0 — on older 22.x it's silently ignored, so the explicit PRAGMA
  // below is what actually installs the busy handler on this repo's target
  // Node version.
  const db = new DatabaseSync(dbPath, { timeout: busyTimeoutMs });
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  // WAL: readers don't block writers and vice versa — the two-process
  // (dev server + cron) scenario this store exists for. In-memory databases
  // don't support WAL and just stay in "memory" mode; that's fine, tests use those.
  // Wrapped in the busy-retry helper: two connections racing to create this
  // file and flip it to WAL for the first time can otherwise collide.
  execWithBusyRetry(db, "PRAGMA journal_mode = WAL", busyTimeoutMs);
  db.exec("PRAGMA foreign_keys = ON");
  execWithBusyRetry(db, SCHEMA_SQL, busyTimeoutMs);
  ensureColumn(db, "gigs", "employment_type", "TEXT");
  ensureColumn(db, "gigs", "matched_profile_ids", "TEXT");
  ensureDraftsSubmittingStatus(db);
  return db;
}

/**
 * Adds `column` to `table` if it doesn't already exist. Needed because
 * `SCHEMA_SQL`'s `CREATE TABLE IF NOT EXISTS` is a no-op against a DB file
 * that already exists (see schema.ts's own header comment: this repo has no
 * migrations framework, so a shape change under existing data needs an
 * explicit guarded `ALTER TABLE` step here) — this node:sqlite build
 * doesn't support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` syntax
 * (confirmed: throws a syntax error), so the existence check is done in JS
 * via `PRAGMA table_info` instead of relying on SQL-level idempotency.
 */
function ensureColumn(db: DatabaseSyncType, table: string, column: string, sqlType: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
}

/**
 * Adds `'submitting'` to `application_drafts.status`'s CHECK constraint on a
 * pre-existing DB (graduated-auto-fire-trust epic). Unlike ensureColumn()'s
 * plain `ALTER TABLE ... ADD COLUMN`, SQLite cannot ALTER a CHECK constraint
 * in place — the only way to change one is the standard SQLite
 * rebuild-via-temp-table dance: rename the old table out of the way, create
 * a fresh one from SCHEMA_SQL's current (already-updated) definition, copy
 * every row across, drop the renamed original. Wrapped in one transaction so
 * a crash mid-migration never leaves the table half-renamed.
 *
 * Idempotent: checks the table's own stored SQL (sqlite_master.sql) for the
 * literal 'submitting' value before doing anything — a fresh DB (whose
 * application_drafts was just created from the up-to-date SCHEMA_SQL by the
 * exec above) already has it and this is a no-op.
 */
function ensureDraftsSubmittingStatus(db: DatabaseSyncType): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'application_drafts'`)
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'submitting'")) return;

  withTransaction(db, () => {
    db.exec(`ALTER TABLE application_drafts RENAME TO application_drafts_pre_submitting`);
    execWithBusyRetry(db, SCHEMA_SQL, DEFAULT_BUSY_TIMEOUT_MS);
    db.exec(`INSERT INTO application_drafts SELECT * FROM application_drafts_pre_submitting`);
    db.exec(`DROP TABLE application_drafts_pre_submitting`);
  });
}

export interface GetDbOptions {
  /** Override the db file path. Defaults to GIGRADAR_DB_PATH env, then the XDG data dir. Pass ":memory:" in tests. */
  path?: string;
  busyTimeoutMs?: number;
}

/**
 * Returns the process-wide shared connection, opening it on first call.
 * Safe to call from anywhere in src/lib/store; callers elsewhere should go
 * through the query/upsert functions in ./gigs.ts instead of calling this
 * directly, so nothing outside this module ever writes raw SQL.
 */
export function getDb(opts: GetDbOptions = {}): DatabaseSyncType {
  const dbPath = opts.path ?? process.env.GIGRADAR_DB_PATH ?? getDefaultDbPath();

  if (shared?.isOpen) {
    if (sharedPath === dbPath) return shared;
    throw new Error(
      `gigradar store: getDb() already holds a connection open at "${sharedPath}"; ` +
        `refusing to silently switch to "${dbPath}" in the same process. ` +
        "Call closeDb() first if you really mean to swap databases (tests do this between cases).",
    );
  }

  shared = openConnection(dbPath, opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
  sharedPath = dbPath;
  return shared;
}

/** Closes the shared connection if open. For tests and graceful shutdown. */
export function closeDb(): void {
  if (shared?.isOpen) shared.close();
  shared = undefined;
  sharedPath = undefined;
}

/** Runs `fn` inside BEGIN IMMEDIATE / COMMIT, rolling back if `fn` throws. */
export function withTransaction<T>(db: DatabaseSyncType, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
