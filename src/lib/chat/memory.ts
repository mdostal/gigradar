// chat-copilot-self-tuning epic. The narrow read/write interface
// agent-chat-loop.ts calls for everything persistence-related — it never
// touches src/lib/store's chat_sessions/chat_preferences tables directly.
// This is the seam a future Mnemosyne-backed implementation swaps behind
// (design-discussion.md §6.1): "session breakdown," richer decision/
// preference modeling, whatever Mnemosyne integration eventually looks
// like, lands here as a rewritten implementation of these same five
// functions — no other file in this epic (or anything else that grows to
// depend on it) needs to change.
//
// v1 is deliberately simple (the owner's own words, 2026-09-02: "the
// memory first version can be simple"): a thin pass-through to
// src/lib/store/chat.ts's SQLite-backed functions, with the
// Anthropic.MessageParam[] typing this module owns (store/chat.ts itself
// stays SDK-agnostic — see that file's own header comment).
import type Anthropic from "@anthropic-ai/sdk";
import {
  deleteChatSessionHistory,
  listChatPreferences,
  loadChatSessionHistory,
  recordChatPreference,
  saveChatSessionHistory,
  type DbOption,
  type StoredChatPreference,
} from "../store/index.js";

/** Returns `sessionId`'s persisted conversation history, or undefined if none was ever saved. */
export function loadSessionHistory(sessionId: string, opts: DbOption = {}): Anthropic.MessageParam[] | undefined {
  const history = loadChatSessionHistory(sessionId, opts);
  return history as Anthropic.MessageParam[] | undefined;
}

/** Upserts `sessionId`'s complete conversation history — a whole-blob replace, not an append. */
export function saveSessionHistory(sessionId: string, history: Anthropic.MessageParam[], opts: DbOption & { now?: string } = {}): void {
  saveChatSessionHistory(sessionId, history, opts);
}

/** Removes `sessionId`'s persisted conversation history. Idempotent. */
export function deleteSessionHistory(sessionId: string, opts: DbOption = {}): void {
  deleteChatSessionHistory(sessionId, opts);
}

/**
 * Records a durable preference note. Called from two places: the chat
 * loop's UNGATED `note_preference` tool (runs immediately, no approval —
 * a memory note is not a config.json/behavior change, owner's own ruling)
 * and an APPROVED `propose_config_edit`'s own `reason` field (so gigradar
 * remembers the reasoning behind a real change, not just the change
 * itself).
 */
export function recordPreference(note: string, sessionId: string | undefined, opts: DbOption & { now?: string } = {}): void {
  recordChatPreference(note, sessionId, opts);
}

/** Every recorded preference note, oldest first, optionally capped at `limit` most-recent. */
export function listPreferences(limit?: number, opts: DbOption = {}): StoredChatPreference[] {
  return listChatPreferences(limit, opts);
}
