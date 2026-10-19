// pantheon-adapter story (PANT-1207): no path through the Pantheon adapter
// can submit an application. Assisted, not auto (ARCHITECTURE.md's
// data-integrity rule 4) has to hold across the API boundary too — the
// adapter may STAGE a draft, never approve, fire, or submit one.
//
// Three independent checks, so no single refactor can quietly open a path:
// 1. the route tree is exactly the expected set, each exporting only the
//    expected HTTP methods, with no submit/approve/fire-shaped segment;
// 2. no adapter source file references the submit adapter registry, the
//    auto-fire evaluator, or a draft-status transition past `draft`;
// 3. behaviorally, the one write the adapter allows — staging a draft —
//    leaves it at `draft` with a registered SubmitAdapter never called.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Gig } from "../../types.js";

vi.mock("../../apply/draft.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../apply/draft.js")>()),
  generateDraft: vi.fn(async () => ({ coverText: "Staged cover letter.", answers: [] })),
}));

import { saveConfig } from "../../config/save.js";
import { registerSource } from "../../sources/source.js";
import { registerSubmitAdapter } from "../../submit/adapter.js";
import { closeDb, getDb, getDraft, getGig } from "../../store/index.js";
import { inFlightRun, stageDraft, startRun, type AdapterDeps } from "../adapter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.resolve(here, "..");
const routesDir = path.resolve(here, "../../../app/api/pantheon");

/** Every route the adapter serves, and the only methods each may export. */
const EXPECTED_ROUTES: Record<string, string[]> = {
  "runs/route.ts": ["GET", "POST"],
  "runs/[id]/route.ts": ["GET"],
  "shortlist/route.ts": ["GET"],
  "drafts/route.ts": ["POST"],
};
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

describe("the Pantheon adapter exposes no submit path", () => {
  it("serves exactly the expected routes, none shaped like submit/approve/fire", () => {
    const routes = walk(routesDir)
      .filter((f) => path.basename(f) === "route.ts")
      .map((f) => path.relative(routesDir, f).split(path.sep).join("/"))
      .sort();
    expect(routes).toEqual(Object.keys(EXPECTED_ROUTES).sort());
    for (const r of routes) expect(r).not.toMatch(/submit|approve|fire|send/i);
  });

  it("each route module exports only its expected HTTP methods", async () => {
    for (const [route, methods] of Object.entries(EXPECTED_ROUTES)) {
      const mod = (await import(path.join(routesDir, route))) as Record<string, unknown>;
      const exported = HTTP_METHODS.filter((m) => typeof mod[m] === "function");
      expect({ route, exported }).toEqual({ route, exported: methods });
    }
  });

  it("no adapter source file references a submit, approve, or auto-fire capability", () => {
    const forbidden = [
      "submit/adapter",
      "getSubmitAdapter",
      "listSubmitAdapters",
      "apply/autofire",
      "evaluateAutoFire",
      "attemptAutoFire",
      "markDraftSubmitted",
      "markDraftSubmitting",
      "setDraftStatus",
      "scheduler/",
    ];
    const files = [...walk(libDir), ...walk(routesDir)].filter((f) => f.endsWith(".ts") && !f.includes(`${path.sep}__tests__${path.sep}`));
    expect(files.length).toBeGreaterThan(4);
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
      for (const word of forbidden) expect({ file: path.basename(f), hit: src.includes(word) ? word : null }).toEqual({ file: path.basename(f), hit: null });
    }
  });
});

describe("staging a draft through the adapter stops at `draft`", () => {
  let tmpDir: string;
  let nextGigs: Gig[] = [];
  const submit = vi.fn();

  registerSource({ id: "pantheon-no-submit-source", label: "test double", auth: "none", fetch: async () => nextGigs });
  registerSubmitAdapter({ id: "pantheon-no-submit-source", submit });

  const config: Config = {
    profile: { name: "Test User", roles: ["Fractional CTO"], skills: [], timezone: "UTC" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: {
          engagementProfiles: [
            { id: "p", label: "Any", types: ["contract", "fractional"], minRate: 0, highRate: 999, maxHours: 99, maxHoursAtHighRate: 99, rateUnit: "hour" },
          ],
          freshStageOnly: false,
          remoteOnly: false,
        },
      },
    ],
    sources: [{ id: "pantheon-no-submit-source", enabled: true }],
    applyProfile: { email: "test@example.com" },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-pantheon-no-submit-test-"));
    process.env.GIGRADAR_DB_PATH = path.join(tmpDir, "gigs.db");
    getDb();
    const saved = saveConfig(config as unknown as Record<string, unknown>);
    expect(saved.ok).toBe(true);
    nextGigs = [{ sourceId: "pantheon-no-submit-source", externalId: "1", title: "Fractional CTO", url: "https://example.com/jobs/1" }];
  });

  afterEach(() => {
    closeDb();
    delete process.env.GIGRADAR_DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists the draft as `draft`, leaves the gig `new`, and never calls a registered SubmitAdapter", async () => {
    const deps: AdapterDeps = {
      loadConfigFn: () => config,
      registerSourcesFn: async () => {},
      resolveSecretsFn: async () => ({ ANTHROPIC_API_KEY: "facade-injected" }),
    };
    startRun(deps);
    await inFlightRun();

    const staged = await stageDraft({ key: "pantheon-no-submit-source:1" }, deps);
    expect(staged.status).toBe("draft");
    expect(getDraft("pantheon-no-submit-source:1")?.status).toBe("draft");
    expect(getGig("pantheon-no-submit-source:1")?.status).toBe("new");
    expect(submit).not.toHaveBeenCalled();
  });
});
