import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendDesktopNotificationMock = vi.fn(async (_n: { title: string; body: string }) => undefined);
vi.mock("../desktop.js", () => ({ sendDesktopNotification: (n: { title: string; body: string }) => sendDesktopNotificationMock(n) }));

import { closeDb, getDb } from "../../store/db.js";
import { listIssues, raiseIssue, resolveIssue } from "../issues.js";

let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-issues-test-"));
  db = getDb({ path: path.join(tmpDir, "gigs.db") });
  sendDesktopNotificationMock.mockClear();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("raiseIssue", () => {
  it("persists a real row and returns its id, firing exactly one desktop notification", async () => {
    const id = await raiseIssue(
      { severity: "warning", source: "runRadar:gofractional", title: "Source fetch failed", message: "timeout" },
      { db, now: "2026-01-01T00:00:00.000Z" },
    );

    expect(id).toBeTruthy();
    const all = listIssues({}, { db });
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      id,
      severity: "warning",
      source: "runRadar:gofractional",
      title: "Source fetch failed",
      message: "timeout",
      context: null,
      raisedAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: null,
    });
    expect(sendDesktopNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("persists context as real JSON, round-tripped correctly", async () => {
    const id = await raiseIssue(
      {
        severity: "error",
        source: "autofire-submit:braintrust:1",
        title: "Auto-fire submit failed",
        message: "Cloudflare blocked the form",
        context: { gigKey: "braintrust:1", sourceId: "braintrust" },
      },
      { db, now: "2026-01-01T00:00:00.000Z" },
    );

    expect(listIssues({}, { db }).find((i) => i.id === id)?.context).toEqual({
      gigKey: "braintrust:1",
      sourceId: "braintrust",
    });
  });

  it("dedupes on (source, title) against an already-OPEN issue -- no new row, no new notification, returns the existing id", async () => {
    const first = await raiseIssue(
      { severity: "warning", source: "runRadar:gofractional", title: "Source fetch failed", message: "timeout 1" },
      { db, now: "2026-01-01T00:00:00.000Z" },
    );
    const second = await raiseIssue(
      { severity: "warning", source: "runRadar:gofractional", title: "Source fetch failed", message: "timeout 2 (different message)" },
      { db, now: "2026-01-02T00:00:00.000Z" },
    );

    expect(second).toBe(first);
    expect(listIssues({}, { db })).toHaveLength(1);
    expect(sendDesktopNotificationMock).toHaveBeenCalledTimes(1); // not fired again
    // The original row is untouched -- second raise's message/timestamp never overwrote it.
    expect(listIssues({}, { db })[0]?.message).toBe("timeout 1");
    expect(listIssues({}, { db })[0]?.raisedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("a RESOLVED issue with the same (source, title) does NOT suppress a fresh raise -- a new row is created", async () => {
    const first = await raiseIssue(
      { severity: "warning", source: "runRadar:gofractional", title: "Source fetch failed", message: "timeout 1" },
      { db, now: "2026-01-01T00:00:00.000Z" },
    );
    resolveIssue(first, { db, now: "2026-01-01T01:00:00.000Z" });

    const second = await raiseIssue(
      { severity: "warning", source: "runRadar:gofractional", title: "Source fetch failed", message: "timeout 2" },
      { db, now: "2026-01-02T00:00:00.000Z" },
    );

    expect(second).not.toBe(first);
    expect(listIssues({}, { db })).toHaveLength(2);
    expect(sendDesktopNotificationMock).toHaveBeenCalledTimes(2);
  });

  it("different (source, title) pairs are never deduped against each other", async () => {
    await raiseIssue({ severity: "warning", source: "a", title: "X", message: "m" }, { db, now: "2026-01-01T00:00:00.000Z" });
    await raiseIssue({ severity: "warning", source: "b", title: "X", message: "m" }, { db, now: "2026-01-01T00:00:00.000Z" });
    await raiseIssue({ severity: "warning", source: "a", title: "Y", message: "m" }, { db, now: "2026-01-01T00:00:00.000Z" });

    expect(listIssues({}, { db })).toHaveLength(3);
  });
});

describe("resolveIssue", () => {
  it("sets resolvedAt and removes it from listIssues({open:true})", async () => {
    const id = await raiseIssue({ severity: "error", source: "a", title: "X", message: "m" }, { db, now: "2026-01-01T00:00:00.000Z" });

    resolveIssue(id, { db, now: "2026-01-02T00:00:00.000Z" });

    expect(listIssues({ open: true }, { db })).toHaveLength(0);
    expect(listIssues({ open: false }, { db })).toHaveLength(1);
    expect(listIssues({ open: false }, { db })[0]?.resolvedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("throws for a nonexistent id", () => {
    expect(() => resolveIssue("nonexistent-id", { db })).toThrow(/no issue with id/);
  });
});

describe("listIssues", () => {
  it("returns everything, newest-raised-first, when no filter is given", async () => {
    await raiseIssue({ severity: "warning", source: "a", title: "X", message: "m" }, { db, now: "2026-01-01T00:00:00.000Z" });
    await raiseIssue({ severity: "error", source: "b", title: "Y", message: "m" }, { db, now: "2026-01-02T00:00:00.000Z" });

    const all = listIssues({}, { db });
    expect(all.map((i) => i.title)).toEqual(["Y", "X"]);
  });

  it("returns an empty list when nothing has ever been raised", () => {
    expect(listIssues({}, { db })).toEqual([]);
  });
});
