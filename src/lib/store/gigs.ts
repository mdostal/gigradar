// The complete public API for reading/writing gigs. Nothing outside
// src/lib/store should ever need to write raw SQL against this database —
// if a caller needs a new query shape, add a function here instead of
// reaching for getDb() + prepare() elsewhere.
import type { DatabaseSync } from "node:sqlite";
import type { Gig } from "../types.js";
import { getDb, withTransaction } from "./db.js";
import type { GigFilter, GigStatus, OutcomeReason, ScanSummary, SourceScanBatch, StoredGig } from "./types.js";

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
  employment_type: string | null;
  stage: string | null;
  posted_at: string | null;
  description: string | null;
  raw: string | null;
  tier: string | null;
  matched_profile_ids: string | null;
  matched_group_ids: string | null;
  matched_group_tiers: string | null;
  ai_flags: string | null;
  match_score: number | null;
  matched_group_scores: string | null;
  status: string;
  outcome_reason: string | null;
  outcome_note: string | null;
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
    employmentType: (row.employment_type as Gig["employmentType"] | null) ?? undefined,
    stage: (row.stage as Gig["stage"] | null) ?? undefined,
    postedAt: row.posted_at ?? undefined,
    description: row.description ?? undefined,
    raw: row.raw !== null ? JSON.parse(row.raw) : undefined,
    tier: (row.tier as Gig["tier"] | null) ?? undefined,
    matchedProfileIds: row.matched_profile_ids !== null ? JSON.parse(row.matched_profile_ids) : undefined,
    matchedGroupIds: row.matched_group_ids !== null ? JSON.parse(row.matched_group_ids) : undefined,
    matchedGroupTiers: row.matched_group_tiers !== null ? JSON.parse(row.matched_group_tiers) : undefined,
    aiFlags: row.ai_flags !== null ? JSON.parse(row.ai_flags) : undefined,
    matchScore: row.match_score ?? undefined,
    matchedGroupScores: row.matched_group_scores !== null ? JSON.parse(row.matched_group_scores) : undefined,
    status: row.status as GigStatus,
    outcomeReason: (row.outcome_reason as OutcomeReason | null) ?? null,
    outcomeNote: row.outcome_note ?? null,
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
    employment_type: gig.employmentType ?? null,
    stage: gig.stage ?? null,
    posted_at: gig.postedAt ?? null,
    description: gig.description ?? null,
    raw: gig.raw === undefined ? null : JSON.stringify(gig.raw),
    tier: gig.tier ?? null,
    matched_profile_ids: gig.matchedProfileIds === undefined ? null : JSON.stringify(gig.matchedProfileIds),
    matched_group_ids: gig.matchedGroupIds === undefined ? null : JSON.stringify(gig.matchedGroupIds),
    matched_group_tiers: gig.matchedGroupTiers === undefined ? null : JSON.stringify(gig.matchedGroupTiers),
    ai_flags: gig.aiFlags === undefined ? null : JSON.stringify(gig.aiFlags),
    match_score: gig.matchScore ?? null,
    matched_group_scores: gig.matchedGroupScores === undefined ? null : JSON.stringify(gig.matchedGroupScores),
    now,
  };

  if (!existing) {
    db.prepare(
      `INSERT INTO gigs (
         key, source_id, external_id, title, company, url, rate_min, rate_max, rate_unit,
         weekly_hours, remote, contract_to_hire, employment_type, stage, posted_at, description, raw, tier,
         matched_profile_ids, matched_group_ids, matched_group_tiers, ai_flags, match_score, matched_group_scores, status, first_seen, last_seen, unavailable_since, reappeared_at
       ) VALUES (
         :key, :source_id, :external_id, :title, :company, :url, :rate_min, :rate_max, :rate_unit,
         :weekly_hours, :remote, :contract_to_hire, :employment_type, :stage, :posted_at, :description, :raw, :tier,
         :matched_profile_ids, :matched_group_ids, :matched_group_tiers, :ai_flags, :match_score, :matched_group_scores, 'new', :now, :now, NULL, NULL
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
       employment_type = :employment_type,
       stage = :stage, posted_at = :posted_at, description = :description, raw = :raw, tier = :tier,
       matched_profile_ids = :matched_profile_ids,
       matched_group_ids = :matched_group_ids,
       matched_group_tiers = :matched_group_tiers,
       ai_flags = :ai_flags,
       match_score = :match_score,
       matched_group_scores = :matched_group_scores,
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
    employment_type: params.employment_type,
    stage: params.stage,
    posted_at: params.posted_at,
    description: params.description,
    raw: params.raw,
    tier: params.tier,
    matched_profile_ids: params.matched_profile_ids,
    matched_group_ids: params.matched_group_ids,
    matched_group_tiers: params.matched_group_tiers,
    ai_flags: params.ai_flags,
    match_score: params.match_score,
    matched_group_scores: params.matched_group_scores,
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
 *
 * ALSO auto-classifies WHY, for the two cases where a delisting itself is
 * the only signal we'll ever get (status-reconciliation-outcomes story,
 * product-review-followups epic — owner's own words, 2026-09-01: "any that
 * we missed because they closed it or something (we didn't apply)" and
 * "they removed the contract"):
 *
 * - A `"new"` gig disappearing means we never even applied before it was
 *   gone — auto-archived with `outcomeReason: "expired_unapplied"`.
 * - An `"applied"`/`"interview"` gig disappearing with no explicit rejection
 *   (that would already have come through a status-reconciliation pass —
 *   see gofractional-status.ts/wellfound-status.ts) means the company most
 *   likely pulled or filled the role without telling us — auto-archived
 *   with `outcomeReason: "withdrawn"`.
 * - An already-`"archived"`/`"ignored"` gig going unavailable gets ONLY
 *   `unavailable_since` touched — never overwrites an existing outcome
 *   (e.g. one a status-reconciliation pass already set from a real,
 *   explicit platform label, which is more authoritative than this
 *   heuristic).
 */
function flagUnavailableForSource(
  db: DatabaseSync,
  sourceId: string,
  seenKeys: ReadonlySet<string>,
  now: string,
): string[] {
  const stillAvailable = db
    .prepare("SELECT key, status FROM gigs WHERE source_id = ? AND unavailable_since IS NULL")
    .all(sourceId) as { key: string; status: string }[];

  const flagged: string[] = [];
  const flagOnlyStmt = db.prepare("UPDATE gigs SET unavailable_since = :now WHERE key = :key");
  const flagAndArchiveStmt = db.prepare(
    `UPDATE gigs SET unavailable_since = :now, status = 'archived', outcome_reason = :outcome_reason, outcome_note = :outcome_note WHERE key = :key`,
  );
  for (const row of stillAvailable) {
    if (seenKeys.has(row.key)) continue;
    if (row.status === "new") {
      flagAndArchiveStmt.run({
        now,
        key: row.key,
        outcome_reason: "expired_unapplied" satisfies OutcomeReason,
        outcome_note: `Listing disappeared from ${sourceId} before we ever applied.`,
      });
    } else if (row.status === "applied" || row.status === "interview") {
      flagAndArchiveStmt.run({
        now,
        key: row.key,
        outcome_reason: "withdrawn" satisfies OutcomeReason,
        outcome_note: `Listing disappeared from ${sourceId} while our application was in progress — likely withdrawn, filled, or cancelled by the company.`,
      });
    } else {
      flagOnlyStmt.run({ now, key: row.key });
    }
    flagged.push(row.key);
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
      // A batch explicitly marked isFullScan:false (a status-reconciliation
      // backfill inserting one gig, never "here is everything this source
      // has") also never triggers delisting — see SourceScanBatch.isFullScan's
      // own doc comment for the real corruption bug this gate fixes.
      if (batch.gigs.length > 0 && batch.isFullScan !== false) {
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
  if (filter.groupId) {
    // Real JSON-array containment (json_each over the stringified array),
    // never a string LIKE/substring match -- a LIKE '%"a"%' style filter
    // would false-positive on a group id like "a2" containing "a". A gig
    // whose matched_group_ids is NULL (not yet evaluated against groups)
    // never matches: json_each(NULL) yields zero rows.
    clauses.push("EXISTS (SELECT 1 FROM json_each(matched_group_ids) WHERE json_each.value = :group_id)");
    params.group_id = filter.groupId;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM gigs ${where} ORDER BY first_seen DESC`)
    .all(params) as unknown as GigRow[];
  return rows.map(toStoredGig);
}

/**
 * customizable-tier-scoring epic. Every currently-stored `matchScore` for
 * `status: "new"` gigs matching `groupId` — "how does this gig compare to
 * everything you still need to decide on," not every gig ever seen. This
 * is the population `TierScoringMode: {kind:"percentile"}` ranks a new
 * gig's own score against (see `matching/score-tiering.ts`'s
 * `computeTier()`). Reuses `listGigs()`'s own filtering rather than a
 * second, duplicated query — a gig with no `matchScore` yet (e.g. not yet
 * re-scanned since this feature shipped) is simply excluded, never
 * counted as a zero.
 */
export function listGroupScores(groupId: string, opts: DbOption = {}): number[] {
  return listGigs({ groupId, status: "new" }, opts)
    .map((g) => g.matchScore)
    .filter((score): score is number => score !== undefined);
}

/** Explicitly set a gig's status (e.g. the user marks it "applied"). Throws if the key doesn't exist. */
export function setStatus(key: string, status: GigStatus, opts: DbOption = {}): void {
  const db = opts.db ?? getDb();
  const result = db.prepare("UPDATE gigs SET status = :status WHERE key = :key").run({ status, key });
  if (Number(result.changes) === 0) {
    throw new Error(`gigradar store: setStatus: no gig with key "${key}"`);
  }
}

/**
 * Explicitly set (or clear, passing `null`) a gig's `outcomeReason` +
 * `outcomeNote` — see `OutcomeReason`'s own doc comment (types.ts) for what
 * each value means and who sets it. Independent of `setStatus()` on
 * purpose: a status-reconciliation pass (gofractional-status.ts,
 * wellfound-status.ts) determines status and outcome from the SAME scraped
 * row but the two are conceptually separate axes, and `recordScan()`'s own
 * auto-archival path (see flagUnavailableForSource()) sets both together
 * via raw SQL rather than this function, so this stays a single-purpose
 * primitive rather than growing setStatus()'s own signature. Throws if the
 * key doesn't exist, same convention as setStatus().
 */
export function setOutcome(key: string, reason: OutcomeReason | null, note: string | null, opts: DbOption = {}): void {
  const db = opts.db ?? getDb();
  const result = db
    .prepare("UPDATE gigs SET outcome_reason = :outcome_reason, outcome_note = :outcome_note WHERE key = :key")
    .run({ outcome_reason: reason, outcome_note: note, key });
  if (Number(result.changes) === 0) {
    throw new Error(`gigradar store: setOutcome: no gig with key "${key}"`);
  }
}

/**
 * stale-tier-retier-and-archive story (config-rebuild-and-match-quality
 * epic): explicitly re-stamps a gig's `tier` outside a scan — recordScan()
 * already overwrites tier on every RE-SEEN scan (its own UPSERT), but a
 * gig that stops being returned by its source never gets touched again;
 * this is the same write, callable directly for that maintenance pass
 * without needing a fake scan batch. Throws if the key doesn't exist, same
 * convention as setStatus()/setOutcome().
 */
export function setTier(key: string, tier: Gig["tier"], opts: DbOption = {}): void {
  const db = opts.db ?? getDb();
  const result = db.prepare("UPDATE gigs SET tier = :tier WHERE key = :key").run({ tier: tier ?? null, key });
  if (Number(result.changes) === 0) {
    throw new Error(`gigradar store: setTier: no gig with key "${key}"`);
  }
}
