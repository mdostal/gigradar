// The complete public API for reading/writing gigs. Nothing outside
// src/lib/store should ever need to write raw SQL against this database —
// if a caller needs a new query shape, add a function here instead of
// reaching for getDb() + prepare() elsewhere.
import type { DatabaseSync } from "node:sqlite";
import type { Gig } from "../types.js";
import { getDb, withTransaction } from "./db.js";
import type { GigFilter, GigStatus, ScanSummary, SourceScanBatch, StoredGig } from "./types.js";

/** The store's primary key for a gig: stable across re-scans and sources. */
export function gigKey(sourceId: string, externalId: string): string {
  return `${sourceId}:${externalId}`;
}

interface GigRow {
  key: string;
  source_id: string;
  external_id: string;
  title: string;
  company: string | null;
  url: string;
  rate_min: number | null;
  rate_max: number | null;
  rate_unit: string | null;
  weekly_hours: number | null;
  remote: number | null;
  contract_to_hire: number | null;
  stage: string | null;
  posted_at: string | null;
  description: string | null;
  raw: string | null;
  tier: string | null;
  status: string;
  first_seen: string;
  last_seen: string;
  unavailable_since: string | null;
  reappeared_at: string | null;
}

function toStoredGig(row: GigRow): StoredGig {
  return {
    sourceId: row.source_id,
    externalId: row.external_id,
    key: row.key,
    title: row.title,
    company: row.company ?? undefined,
    url: row.url,
    rate: row.rate_unit
      ? {
          min: row.rate_min ?? undefined,
          max: row.rate_max ?? undefined,
          unit: row.rate_unit as NonNullable<Gig["rate"]>["unit"],
        }
      : undefined,
    weeklyHours: row.weekly_hours ?? undefined,
    remote: row.remote === null ? undefined : row.remote === 1,
    contractToHire: row.contract_to_hire === null ? undefined : row.contract_to_hire === 1,
    stage: (row.stage as Gig["stage"] | null) ?? undefined,
    postedAt: row.posted_at ?? undefined,
    description: row.description ?? undefined,
    raw: row.raw !== null ? JSON.parse(row.raw) : undefined,
    tier: (row.tier as Gig["tier"] | null) ?? undefined,
    status: row.status as GigStatus,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    unavailableSince: row.unavailable_since,
    reappearedAt: row.reappeared_at,
  };
}

interface UpsertOneResult {
  key: string;
  inserted: boolean;
  /** True iff this gig had a non-null unavailableSince immediately before this upsert. */
  reappeared: boolean;
}

/**
 * Insert-or-update a single gig row. Preserves `status` and `first_seen` on
 * an existing row — a re-scan must never reset an "applied" gig back to
 * "new", and firstSeen is meant to never move. Also clears
 * `unavailable_since` unconditionally: reappearing in a scan is definitionally
 * "not unavailable anymore", regardless of how it got flagged.
 */
function upsertOne(db: DatabaseSync, gig: Gig, now: string): UpsertOneResult {
  const key = gigKey(gig.sourceId, gig.externalId);
  const existing = db.prepare("SELECT unavailable_since FROM gigs WHERE key = ?").get(key) as
    | { unavailable_since: string | null }
    | undefined;

  const params = {
    key,
    source_id: gig.sourceId,
    external_id: gig.externalId,
    title: gig.title,
    company: gig.company ?? null,
    url: gig.url,
    rate_min: gig.rate?.min ?? null,
    rate_max: gig.rate?.max ?? null,
    rate_unit: gig.rate?.unit ?? null,
    weekly_hours: gig.weeklyHours ?? null,
    remote: gig.remote === undefined ? null : gig.remote ? 1 : 0,
    contract_to_hire: gig.contractToHire === undefined ? null : gig.contractToHire ? 1 : 0,
    stage: gig.stage ?? null,
    posted_at: gig.postedAt ?? null,
    description: gig.description ?? null,
    raw: gig.raw === undefined ? null : JSON.stringify(gig.raw),
    tier: gig.tier ?? null,
    now,
  };

  if (!existing) {
    db.prepare(
      `INSERT INTO gigs (
         key, source_id, external_id, title, company, url, rate_min, rate_max, rate_unit,
         weekly_hours, remote, contract_to_hire, stage, posted_at, description, raw, tier,
         status, first_seen, last_seen, unavailable_since, reappeared_at
       ) VALUES (
         :key, :source_id, :external_id, :title, :company, :url, :rate_min, :rate_max, :rate_unit,
         :weekly_hours, :remote, :contract_to_hire, :stage, :posted_at, :description, :raw, :tier,
         'new', :now, :now, NULL, NULL
       )`,
    ).run(params);
    return { key, inserted: true, reappeared: false };
  }

  const wasUnavailable = existing.unavailable_since !== null;
  // node:sqlite rejects named parameters that don't appear in the SQL text
  // (allowUnknownNamedParameters defaults to false), so this only binds the
  // subset of `params` this UPDATE actually references — not the full insert shape.
  db.prepare(
    `UPDATE gigs SET
       title = :title, company = :company, url = :url,
       rate_min = :rate_min, rate_max = :rate_max, rate_unit = :rate_unit,
       weekly_hours = :weekly_hours, remote = :remote, contract_to_hire = :contract_to_hire,
       stage = :stage, posted_at = :posted_at, description = :description, raw = :raw, tier = :tier,
       last_seen = :now,
       unavailable_since = NULL,
       reappeared_at = CASE WHEN :was_unavailable THEN :now ELSE reappeared_at END
     WHERE key = :key`,
  ).run({
    title: params.title,
    company: params.company,
    url: params.url,
    rate_min: params.rate_min,
    rate_max: params.rate_max,
    rate_unit: params.rate_unit,
    weekly_hours: params.weekly_hours,
    remote: params.remote,
    contract_to_hire: params.contract_to_hire,
    stage: params.stage,
    posted_at: params.posted_at,
    description: params.description,
    raw: params.raw,
    tier: params.tier,
    now: params.now,
    key: params.key,
    was_unavailable: wasUnavailable ? 1 : 0,
  });

  return { key, inserted: false, reappeared: wasUnavailable };
}

/**
 * Flags gigs from `sourceId` that are still marked available but weren't in
 * `seenKeys` this scan. Only call this for a source that returned >=1 gig —
 * see recordScan()'s doc for why a zero-result or errored source must never
 * reach here.
 */
function flagUnavailableForSource(
  db: DatabaseSync,
  sourceId: string,
  seenKeys: ReadonlySet<string>,
  now: string,
): string[] {
  const stillAvailable = db
    .prepare("SELECT key FROM gigs WHERE source_id = ? AND unavailable_since IS NULL")
    .all(sourceId) as { key: string }[];

  const flagged: string[] = [];
  const flagStmt = db.prepare("UPDATE gigs SET unavailable_since = :now WHERE key = :key");
  for (const row of stillAvailable) {
    if (!seenKeys.has(row.key)) {
      flagStmt.run({ now, key: row.key });
      flagged.push(row.key);
    }
  }
  return flagged;
}

export interface RecordScanOptions {
  /** Use a specific connection (tests). Defaults to the shared getDb(). */
  db?: DatabaseSync;
  /** Override the "now" timestamp (tests only). Defaults to `new Date().toISOString()`. */
  now?: string;
}

/**
 * Persists one radar scan's results and runs delisting detection.
 *
 * For every batch: upserts each gig (see upsertOne — status/firstSeen are
 * preserved, unavailableSince is cleared on reappearance). Then, ONLY for
 * batches that contained >=1 gig, flags every previously-available gig from
 * that same source that didn't reappear this scan as `unavailableSince`.
 *
 * The critical rule (see docs/ARCHITECTURE.md "no silent zero"): a source
 * that returned zero gigs, or that isn't in `batches` at all because its
 * fetch threw, NEVER causes a flag. Both cases look identical to this
 * function (the source contributed nothing to `sourcesWithResults`) — an
 * empty result is exactly as untrustworthy as an outage for the purpose of
 * declaring every one of that source's stored gigs delisted. Flagging on a
 * source outage would be a false-flag bug, not a real delisting signal.
 */
export function recordScan(batches: SourceScanBatch[], opts: RecordScanOptions = {}): ScanSummary {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();

  return withTransaction(db, () => {
    const upserted: ScanSummary["upserted"] = [];
    const reappeared: string[] = [];
    const flaggedUnavailable: string[] = [];
    const sourcesWithResults: string[] = [];

    for (const batch of batches) {
      const seenKeys = new Set<string>();
      for (const gig of batch.gigs) {
        if (gig.sourceId !== batch.sourceId) {
          throw new Error(
            `recordScan: gig.sourceId "${gig.sourceId}" (externalId "${gig.externalId}") ` +
              `does not match its batch's sourceId "${batch.sourceId}"`,
          );
        }
        const result = upsertOne(db, gig, now);
        seenKeys.add(result.key);
        upserted.push({ key: result.key, inserted: result.inserted });
        if (result.reappeared) reappeared.push(result.key);
      }

      // Zero gigs (source ran fine, found nothing) => skip entirely. Do not
      // touch unavailable_since for anything from this source this scan.
      if (batch.gigs.length > 0) {
        sourcesWithResults.push(batch.sourceId);
        flaggedUnavailable.push(...flagUnavailableForSource(db, batch.sourceId, seenKeys, now));
      }
    }

    return { upserted, reappeared, flaggedUnavailable, sourcesWithResults };
  });
}

export interface DbOption {
  /** Use a specific connection (tests). Defaults to the shared getDb(). */
  db?: DatabaseSync;
}

/** Fetch a single stored gig by its key (`${sourceId}:${externalId}`). */
export function getGig(key: string, opts: DbOption = {}): StoredGig | undefined {
  const db = opts.db ?? getDb();
  const row = db.prepare("SELECT * FROM gigs WHERE key = ?").get(key) as GigRow | undefined;
  return row ? toStoredGig(row) : undefined;
}

/** List stored gigs, optionally filtered by status / source / availability. Newest-first by firstSeen. */
export function listGigs(filter: GigFilter = {}, opts: DbOption = {}): StoredGig[] {
  const db = opts.db ?? getDb();
  const clauses: string[] = [];
  const params: Record<string, string> = {};

  if (filter.status) {
    clauses.push("status = :status");
    params.status = filter.status;
  }
  if (filter.sourceId) {
    clauses.push("source_id = :source_id");
    params.source_id = filter.sourceId;
  }
  if (filter.unavailable === true) clauses.push("unavailable_since IS NOT NULL");
  if (filter.unavailable === false) clauses.push("unavailable_since IS NULL");

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM gigs ${where} ORDER BY first_seen DESC`)
    .all(params) as unknown as GigRow[];
  return rows.map(toStoredGig);
}

/** Explicitly set a gig's status (e.g. the user marks it "applied"). Throws if the key doesn't exist. */
export function setStatus(key: string, status: GigStatus, opts: DbOption = {}): void {
  const db = opts.db ?? getDb();
  const result = db.prepare("UPDATE gigs SET status = :status WHERE key = :key").run({ status, key });
  if (Number(result.changes) === 0) {
    throw new Error(`gigradar store: setStatus: no gig with key "${key}"`);
  }
}
