import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runner-registry-and-sidecar-lifecycle epic: actions.test.ts's own
// retrySourceAction tests mock "@/lib/apply/runner" entirely, so they
// never exercised the REAL getSource() registry lookup that had the "no
// such registered source" bug (registerAllSources() was never called
// before this epic). This file deliberately does NOT mock runner.ts,
// register-all.ts, or the source registry -- register-all.ts's own real
// dynamic import() calls run for real here, including for the other 8
// adapters (harmless: their fetch() is never invoked, since the config
// below only enables "braintrust"). Only braintrust's OWN fetch is
// replaced -- via a full module mock that still calls the REAL
// registerSource() the same way the real braintrust.ts does -- so this
// exercises the real registration wiring while staying network-free.
// (An earlier draft of this test called registerSource() directly in
// beforeEach, independent of registerAllSources() -- reverting the actual
// fix didn't make that version fail, because it registered the test
// source itself regardless of whether registerAllSources() ran. This
// version was verified the correct way round: it FAILS with "no such
// registered source" when retrySourceAction's registerAllSources() call
// is removed, and passes once it's restored.)
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/notify/desktop", () => ({ sendDesktopNotification: vi.fn(async () => undefined) }));
vi.mock("@/lib/config/env-store", () => ({ resolveLlmCredential: () => undefined }));
vi.mock("@/lib/sources/braintrust", async () => {
  const { registerSource } = await import("@/lib/sources/source");
  registerSource({ id: "braintrust", label: "Braintrust (test double)", auth: "none", fetch: async () => [] });
  return {};
});

const loadConfigMock = vi.fn();
vi.mock("@/lib/config/load", () => ({ loadConfig: () => loadConfigMock() }));

import { closeDb, getDb } from "@/lib/store/db";
import { listIssues, raiseIssue } from "@/lib/notify/issues";
import { retrySourceAction } from "../actions";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-retry-integration-"));
  vi.stubEnv("GIGRADAR_DB_PATH", path.join(tmpDir, "gigs.db"));
  getDb();

  loadConfigMock.mockReturnValue({
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    groups: [{ id: "g1", label: "Group 1", needs: { engagementProfiles: [], freshStageOnly: false, remoteOnly: false } }],
    sources: [{ id: "braintrust", enabled: true }],
  });
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("retrySourceAction against the REAL registry (registerAllSources() genuinely runs, not a mocked runRadar)", () => {
  it("succeeds end-to-end and resolves the issue -- exactly the path that reported 'no such registered source' before registerAllSources() was wired in", async () => {
    await raiseIssue({
      severity: "warning",
      source: "runRadar:braintrust",
      title: "Source fetch failed",
      message: "timeout",
      context: { sourceId: "braintrust" },
    });

    const result = await retrySourceAction("braintrust");

    expect(result).toEqual({ ok: true, data: { ok: true, foundCount: 0 } });
    expect(listIssues({ open: true })).toHaveLength(0);
  });
});
