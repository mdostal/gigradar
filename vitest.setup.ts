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
//
// SAME reasoning, extended to XDG_CONFIG_HOME (llm-provider-harness epic,
// custom-llm-source-credential-migration story): resolveLlmCredential()
// (now reachable from runRadar()'s own credential-resolution call sites,
// e.g. the scheduler's runCycle()) reads the vault key via
// getKeyConfigDir()/XDG_CONFIG_HOME (src/lib/security/key-path.ts) — a
// SEPARATE directory tree from XDG_DATA_HOME by design (the key never
// lives next to the data it protects). Found live: several
// scheduler/index.test.ts tests broke the moment runCycle() started
// resolving a credential, because one describe block's own
// `vi.stubEnv("XDG_CONFIG_HOME", ...)` (scoped only to its own
// beforeAll/afterAll, its temp dir deleted in afterAll) was never reverted
// via `vi.unstubAllEnvs()`, leaking a since-deleted path to every
// LATER-running test in the same file — invisible before because nothing
// outside that describe block ever read XDG_CONFIG_HOME. No
// GIGRADAR_KEY_PATH-style override sits above XDG_CONFIG_HOME
// (getKeyConfigDir()'s only override), so this has the identical
// no-conflict property XDG_DATA_HOME's own default already established
// above.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-test-default-xdg-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-test-default-xdg-config-"));
