// Global safety net (notifications-epic): NO test should ever be able to
// write to the owner's REAL gigradar database, even incidentally -- e.g. a
// scheduler/backoff test that has nothing to do with the store, but
// exercises a code path (runCycle's error handling) that now happens to
// call a store function (raiseIssue()) it was never written to know about.
// Found live: several pre-existing scheduler tests were silently polluting
// the real production database with fixture rows ("flaky"/"boom") before
// this setup file existed.
//
// This sets a throwaway default DATA DIR for the WHOLE test run, applied
// BEFORE any test file's own module-level code runs — via XDG_DATA_HOME,
// NOT GIGRADAR_DB_PATH. That choice matters: GIGRADAR_DB_PATH sits ABOVE
// XDG_DATA_HOME in getDb()'s own resolution order (see src/lib/store/db.ts),
// so setting it globally would have silently overridden every test that
// isolates itself via its own XDG_DATA_HOME override (e.g.
// src/mcp/__tests__/server.test.ts, which spawns a real child process that
// reads XDG_DATA_HOME fresh from its own inherited environment) — confirmed
// live: that was the exact regression this file's first version caused.
// XDG_DATA_HOME, layered the same way every existing test already uses it,
// has no such conflict: a test that reassigns process.env.XDG_DATA_HOME
// per-test simply overrides this default for its own duration. Any test
// that wants its own isolated temp db via an explicit getDb({path}) call is
// unaffected either way — an explicit path always wins over both env vars.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-test-default-xdg-data-"));
