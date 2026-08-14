// Durable, severity-tiered "needs attention" issues (notifications-epic).
// The one place anything in gigradar reports something a human should see
// and act on -- not just a console.error line invisible unless someone is
// watching the terminal. See design-discussion.md in this epic's docs for
// the full rationale (the owner's own directive after the GoFractional
// Cloudflare-verification finding: "we just note it... add a notifications
// epic... a warning, then the error symbol for different levels of issues").
import crypto from "node:crypto";
import { sendDesktopNotification } from "./desktop.js";
import { getDb } from "../store/index.js";
import type { DbOption } from "../store/index.js";

export type IssueSeverity = "warning" | "error";

export interface RaiseIssueInput {
  severity: IssueSeverity;
  /** e.g. "runRadar:gofractional", "autofire-submit:braintrust:123" -- combined with `title` as the dedupe key (see raiseIssue()'s own doc comment). */
  source: string;
  title: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface StoredIssue {
  id: string;
  severity: IssueSeverity;
  source: string;
  title: string;
  message: string;
  context: Record<string, unknown> | null;
  raisedAt: string;
  resolvedAt: string | null;
}

interface IssueRow {
  id: string;
  severity: string;
  source: string;
  title: string;
  message: string;
  context: string | null;
  raised_at: string;
  resolved_at: string | null;
}

function toStoredIssue(row: IssueRow): StoredIssue {
  return {
    id: row.id,
    severity: row.severity as IssueSeverity,
    source: row.source,
    title: row.title,
    message: row.message,
    context: row.context ? (JSON.parse(row.context) as Record<string, unknown>) : null,
    raisedAt: row.raised_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Reports something needing attention. Dedupes on `(source, title)`
 * against currently-OPEN issues only: if an open issue already exists with
 * the same pair, this returns ITS id unchanged -- no new row, no new
 * desktop notification, no bump to `raised_at`. A RESOLVED issue with the
 * same pair does NOT suppress a new raise (see design-discussion.md §4) --
 * that's a fresh occurrence, not a repeat of the still-open one.
 *
 * The desktop notification is best-effort (sendDesktopNotification() never
 * throws) and only fires for a genuinely new (post-dedupe) issue -- same
 * "no per-item spam" discipline runNotifyOnGreenMatch() already
 * established for green-tier matches.
 */
export async function raiseIssue(input: RaiseIssueInput, opts: DbOption & { now?: string } = {}): Promise<string> {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();

  const existing = db
    .prepare(`SELECT id FROM issues WHERE source = :source AND title = :title AND resolved_at IS NULL`)
    .get({ source: input.source, title: input.title }) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO issues (id, severity, source, title, message, context, raised_at, resolved_at)
     VALUES (:id, :severity, :source, :title, :message, :context, :raised_at, NULL)`,
  ).run({
    id,
    severity: input.severity,
    source: input.source,
    title: input.title,
    message: input.message,
    context: input.context ? JSON.stringify(input.context) : null,
    raised_at: now,
  });

  await sendDesktopNotification({ title: `gigradar: ${input.title}`, body: input.message });

  return id;
}

/** Marks an issue resolved. Throws if no issue exists with that id -- same "throw on missing row" convention as setDraftStatus()/setStatus(). */
export function resolveIssue(id: string, opts: DbOption & { now?: string } = {}): void {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();
  const result = db.prepare(`UPDATE issues SET resolved_at = :now WHERE id = :id`).run({ now, id });
  if (Number(result.changes) === 0) {
    throw new Error(`gigradar notify: resolveIssue: no issue with id "${id}"`);
  }
}

/** Lists issues, newest-raised-first. `filter.open === true` -> only unresolved; `false` -> only resolved; omitted -> both. */
export function listIssues(filter: { open?: boolean } = {}, opts: DbOption = {}): StoredIssue[] {
  const db = opts.db ?? getDb();
  const where = filter.open === true ? "WHERE resolved_at IS NULL" : filter.open === false ? "WHERE resolved_at IS NOT NULL" : "";
  const rows = db.prepare(`SELECT * FROM issues ${where} ORDER BY raised_at DESC`).all() as unknown as IssueRow[];
  return rows.map(toStoredIssue);
}
