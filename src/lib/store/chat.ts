// Persistence for the chat co-pilot's memory (chat-copilot-self-tuning
// epic). Mirrors drafts.ts's shape: a thin, typed layer over two tables
// (chat_sessions, chat_preferences — schema.ts) — the only place in the
// codebase that writes raw SQL against either. Nothing outside
// src/lib/store should ever need to.
//
// Deliberately SDK-agnostic: `history` here is an opaque JSON-serializable
// array, never typed as `Anthropic.MessageParam[]` — that typing (and the
// "narrow seam a future Mnemosyne integration swaps behind" framing) lives
// one layer up, in src/lib/chat/memory.ts, which is the only caller of
// this file. Keeping the Anthropic SDK type out of src/lib/store keeps
// this module reusable if a future LLM-provider migration changes the
// in-memory message shape.
import { getDb } from "./db.js";
import type { DbOption } from "./gigs.js";
import type { StoredChatPreference } from "./types.js";

interface ChatSessionRow {
  session_id: string;
  history: string;
  updated_at: string;
}

interface ChatPreferenceRow {
  note: string;
  session_id: string | null;
  created_at: string;
}

/** Upserts `sessionId`'s complete history — a whole-blob replace, not an append. See this file's header comment for why a one-row-per-message shape isn't used. */
export function saveChatSessionHistory(sessionId: string, history: unknown[], opts: DbOption & { now?: string } = {}): void {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO chat_sessions (session_id, history, updated_at)
     VALUES (:session_id, :history, :now)
     ON CONFLICT(session_id) DO UPDATE SET
       history = excluded.history,
       updated_at = excluded.updated_at`,
  ).run({ session_id: sessionId, history: JSON.stringify(history), now });
}

/** Returns `sessionId`'s persisted history, or undefined if none was ever saved (never an empty array as a stand-in for "not found"). */
export function loadChatSessionHistory(sessionId: string, opts: DbOption = {}): unknown[] | undefined {
  const db = opts.db ?? getDb();
  const row = db.prepare("SELECT * FROM chat_sessions WHERE session_id = ?").get(sessionId) as ChatSessionRow | undefined;
  if (!row) return undefined;
  return JSON.parse(row.history) as unknown[];
}

/** Removes `sessionId`'s persisted history. Idempotent — deleting an already-gone/unknown session is a silent no-op. */
export function deleteChatSessionHistory(sessionId: string, opts: DbOption = {}): void {
  const db = opts.db ?? getDb();
  db.prepare("DELETE FROM chat_sessions WHERE session_id = ?").run(sessionId);
}

/** Appends one preference note — append-only, never UPDATE/DELETE (see schema.ts's own comment on this table). `sessionId` is optional context, not a foreign key. */
export function recordChatPreference(note: string, sessionId: string | undefined, opts: DbOption & { now?: string } = {}): void {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO chat_preferences (session_id, note, created_at) VALUES (:session_id, :note, :now)`,
  ).run({ session_id: sessionId ?? null, note, now });
}

/** Every recorded preference note, oldest first (chronological — how the notes actually accumulated), optionally capped at `limit` most-recent. */
export function listChatPreferences(limit?: number, opts: DbOption = {}): StoredChatPreference[] {
  const db = opts.db ?? getDb();
  const rows =
    limit === undefined
      ? (db.prepare("SELECT * FROM chat_preferences ORDER BY created_at ASC").all() as unknown as ChatPreferenceRow[])
      : (db.prepare("SELECT * FROM chat_preferences ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as ChatPreferenceRow[]).reverse();
  return rows.map((row) => ({ note: row.note, sessionId: row.session_id, createdAt: row.created_at }));
}
