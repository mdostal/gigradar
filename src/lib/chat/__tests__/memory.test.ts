import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../store/db.js";
import { deleteSessionHistory, listPreferences, loadSessionHistory, recordPreference, saveSessionHistory } from "../memory.js";

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-chat-memory-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const HISTORY_V1: Anthropic.MessageParam[] = [{ role: "user", content: "hello" }];
const HISTORY_V2: Anthropic.MessageParam[] = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi there" },
];

describe("chat memory: session history", () => {
  it("returns undefined for a session that was never saved", () => {
    expect(loadSessionHistory("never-saved", { db })).toBeUndefined();
  });

  it("round-trips a saved session's history exactly", () => {
    saveSessionHistory("s1", HISTORY_V1, { db });

    expect(loadSessionHistory("s1", { db })).toEqual(HISTORY_V1);
  });

  it("a second save for the same sessionId REPLACES the history wholesale (upsert, not append)", () => {
    saveSessionHistory("s1", HISTORY_V1, { db });
    saveSessionHistory("s1", HISTORY_V2, { db });

    expect(loadSessionHistory("s1", { db })).toEqual(HISTORY_V2);
  });

  it("deleteSessionHistory removes the row -- a subsequent load returns undefined", () => {
    saveSessionHistory("s1", HISTORY_V1, { db });

    deleteSessionHistory("s1", { db });

    expect(loadSessionHistory("s1", { db })).toBeUndefined();
  });

  it("deleteSessionHistory on an unknown sessionId is a silent no-op", () => {
    expect(() => deleteSessionHistory("never-existed", { db })).not.toThrow();
  });

  it("two different sessionIds never collide", () => {
    saveSessionHistory("s1", HISTORY_V1, { db });
    saveSessionHistory("s2", HISTORY_V2, { db });

    expect(loadSessionHistory("s1", { db })).toEqual(HISTORY_V1);
    expect(loadSessionHistory("s2", { db })).toEqual(HISTORY_V2);
  });
});

describe("chat memory: preferences (append-only)", () => {
  it("recordPreference() with a sessionId round-trips through listPreferences()", () => {
    recordPreference("CFO/Finance titles are never a fit for the CTO group", "s1", { db });

    const prefs = listPreferences(undefined, { db });

    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({ note: "CFO/Finance titles are never a fit for the CTO group", sessionId: "s1" });
    expect(typeof prefs[0]?.createdAt).toBe("string");
  });

  it("recordPreference() with no sessionId succeeds and the stored row's sessionId is null", () => {
    recordPreference("a note with no session context", undefined, { db });

    const prefs = listPreferences(undefined, { db });

    expect(prefs[0]?.sessionId).toBeNull();
  });

  it("every recorded note survives -- append-only, never overwritten", () => {
    recordPreference("note 1", "s1", { db, now: "2026-01-01T00:00:00.000Z" });
    recordPreference("note 2", "s1", { db, now: "2026-01-02T00:00:00.000Z" });
    recordPreference("note 3", "s2", { db, now: "2026-01-03T00:00:00.000Z" });

    const prefs = listPreferences(undefined, { db });

    expect(prefs.map((p) => p.note)).toEqual(["note 1", "note 2", "note 3"]);
  });

  it("listPreferences() orders by createdAt ascending (chronological)", () => {
    recordPreference("later", "s1", { db, now: "2026-01-02T00:00:00.000Z" });
    recordPreference("earlier", "s1", { db, now: "2026-01-01T00:00:00.000Z" });

    const prefs = listPreferences(undefined, { db });

    expect(prefs.map((p) => p.note)).toEqual(["earlier", "later"]);
  });

  it("listPreferences(limit) returns only the N most recent, still chronologically ordered", () => {
    recordPreference("note 1", "s1", { db, now: "2026-01-01T00:00:00.000Z" });
    recordPreference("note 2", "s1", { db, now: "2026-01-02T00:00:00.000Z" });
    recordPreference("note 3", "s1", { db, now: "2026-01-03T00:00:00.000Z" });

    const prefs = listPreferences(2, { db });

    expect(prefs.map((p) => p.note)).toEqual(["note 2", "note 3"]);
  });
});
