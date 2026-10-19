// Runs triggered through the Pantheon adapter (pantheon-adapter story,
// PANT-1207) and the MatchResults each one produced. See schema.ts's own
// header comment on `adapter_runs`/`adapter_run_results` for why the gate's
// reasons need a table of their own: runRadar() returns them, but
// recordScan() only ever persisted the stamped tier, so the explanation was
// gone the moment the run returned. Like every other module here, this is
// the only place that writes raw SQL against these two tables.
import { getDb, withTransaction } from "./db.js";
import { gigKey } from "./gigs.js";
import type { DbOption } from "./gigs.js";
import type { AdapterRunStatus, StoredAdapterRun, StoredAdapterRunResult } from "./types.js";
import type { MatchResult } from "../types.js";

interface AdapterRunRow {
  id: string;
  status: AdapterRunStatus;
  started_at: string;
  finished_at: string | null;
  sources_total: number | null;
  passed_count: number | null;
  rejected_count: number | null;
  new_count: number | null;
  errors: string;
  error: string | null;
}

interface AdapterRunResultRow {
  run_id: string;
  gig_key: string;
  pass: number;
  score: number;
  tier: StoredAdapterRunResult["tier"];
  reasons: string;
  gig: string;
}

function toStoredRun(row: AdapterRunRow): StoredAdapterRun {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    sourcesTotal: row.sources_total,
    passedCount: row.passed_count,
    rejectedCount: row.rejected_count,
    newCount: row.new_count,
    errors: JSON.parse(row.errors) as StoredAdapterRun["errors"],
    error: row.error,
  };
}

function toStoredResult(row: AdapterRunResultRow): StoredAdapterRunResult {
  return {
    runId: row.run_id,
    gigKey: row.gig_key,
    pass: row.pass === 1,
    score: row.score,
    tier: row.tier,
    reasons: JSON.parse(row.reasons) as string[],
    gig: JSON.parse(row.gig) as StoredAdapterRunResult["gig"],
  };
}

/** Inserts a new `running` row. */
export function createAdapterRun(id: string, opts: DbOption & { now?: string } = {}): StoredAdapterRun {
  const db = opts.db ?? getDb();
  db.prepare(`INSERT INTO adapter_runs (id, status, started_at) VALUES (:id, 'running', :started_at)`).run({
    id,
    started_at: opts.now ?? new Date().toISOString(),
  });
  return getAdapterRun(id, opts)!;
}

export interface CompleteAdapterRunInput {
  sourcesTotal: number;
  results: MatchResult[];
  newCount: number;
  errors: StoredAdapterRun["errors"];
}

/**
 * Settles a run as `succeeded` and stores every MatchResult it produced —
 * passed and rejected — in ONE transaction, so a reader never sees a
 * succeeded run with a partial shortlist. `reasons` is stored exactly as
 * runRadar() returned it; nothing here rewrites, filters, or scores it.
 */
export function completeAdapterRun(id: string, input: CompleteAdapterRunInput, opts: DbOption & { now?: string } = {}): void {
  const db = opts.db ?? getDb();
  const passedCount = input.results.filter((r) => r.pass).length;
  withTransaction(db, () => {
    const insert = db.prepare(
      `INSERT OR REPLACE INTO adapter_run_results (run_id, gig_key, pass, score, tier, reasons, gig)
       VALUES (:run_id, :gig_key, :pass, :score, :tier, :reasons, :gig)`,
    );
    for (const r of input.results) {
      const { raw: _raw, ...gig } = r.gig;
      insert.run({
        run_id: id,
        gig_key: gigKey(r.gig.sourceId, r.gig.externalId),
        pass: r.pass ? 1 : 0,
        score: r.score,
        tier: r.tier ?? null,
        reasons: JSON.stringify(r.reasons),
        gig: JSON.stringify(gig),
      });
    }
    db.prepare(
      `UPDATE adapter_runs SET status = 'succeeded', finished_at = :finished_at, sources_total = :sources_total,
         passed_count = :passed_count, rejected_count = :rejected_count, new_count = :new_count, errors = :errors
       WHERE id = :id`,
    ).run({
      id,
      finished_at: opts.now ?? new Date().toISOString(),
      sources_total: input.sourcesTotal,
      passed_count: passedCount,
      rejected_count: input.results.length - passedCount,
      new_count: input.newCount,
      errors: JSON.stringify(input.errors),
    });
  });
}

/** Settles a run as `failed` (runRadar()/loadConfig() threw) or `interrupted` (the process died mid-run). */
export function failAdapterRun(
  id: string,
  status: "failed" | "interrupted",
  error: string,
  opts: DbOption & { now?: string; sourcesTotal?: number } = {},
): void {
  const db = opts.db ?? getDb();
  db.prepare(
    `UPDATE adapter_runs SET status = :status, finished_at = :finished_at, error = :error,
       sources_total = COALESCE(:sources_total, sources_total)
     WHERE id = :id`,
  ).run({ id, status, error, finished_at: opts.now ?? new Date().toISOString(), sources_total: opts.sourcesTotal ?? null });
}

export function getAdapterRun(id: string, opts: DbOption = {}): StoredAdapterRun | undefined {
  const db = opts.db ?? getDb();
  const row = db.prepare(`SELECT * FROM adapter_runs WHERE id = ?`).get(id) as AdapterRunRow | undefined;
  return row ? toStoredRun(row) : undefined;
}

/** The most recently started run, optionally restricted to one status. `rowid` breaks a same-timestamp tie. */
export function getLatestAdapterRun(opts: DbOption & { status?: AdapterRunStatus } = {}): StoredAdapterRun | undefined {
  const db = opts.db ?? getDb();
  const row = (
    opts.status
      ? db.prepare(`SELECT * FROM adapter_runs WHERE status = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(opts.status)
      : db.prepare(`SELECT * FROM adapter_runs ORDER BY started_at DESC, rowid DESC LIMIT 1`).get()
  ) as AdapterRunRow | undefined;
  return row ? toStoredRun(row) : undefined;
}

/** Every stored result for `runId`, passed first, then by descending score — the same order runRadar() ranks its passers in. */
export function listAdapterRunResults(runId: string, opts: DbOption = {}): StoredAdapterRunResult[] {
  const db = opts.db ?? getDb();
  const rows = db
    .prepare(`SELECT * FROM adapter_run_results WHERE run_id = ? ORDER BY pass DESC, score DESC, gig_key ASC`)
    .all(runId) as unknown as AdapterRunResultRow[];
  return rows.map(toStoredResult);
}

export function getAdapterRunResult(runId: string, key: string, opts: DbOption = {}): StoredAdapterRunResult | undefined {
  const db = opts.db ?? getDb();
  const row = db.prepare(`SELECT * FROM adapter_run_results WHERE run_id = ? AND gig_key = ?`).get(runId, key) as
    | AdapterRunResultRow
    | undefined;
  return row ? toStoredResult(row) : undefined;
}
