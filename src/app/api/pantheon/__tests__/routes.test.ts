// pantheon-adapter story (PANT-1207). The /api/pantheon/* route handlers
// end to end: real auth against a stand-in for core-api's secrets facade
// (global fetch stubbed to write the token file where the request asks, as
// Portunus does), real adapter, real store, test-double source.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Gig } from "@/lib/types";

const TOKEN = "route-test-operator-token";
let nextGigs: Gig[] = [];

vi.mock("@/lib/config/load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/load")>()),
  loadConfig: () => ({
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
          remoteOnly: true,
        },
      },
    ],
    sources: [{ id: "pantheon-route-test-source", enabled: true }],
  }),
}));
vi.mock("@/lib/sources/register-all", () => ({ registerAllSources: async () => {} }));

import { registerSource } from "@/lib/sources/source";
import { closeDb, getDb } from "@/lib/store";
import { inFlightRun } from "@/lib/pantheon/adapter";
import { resetOperatorTokenCache } from "@/lib/pantheon/auth";
import { GET as getLatestRun, POST as triggerRun } from "../runs/route";
import { GET as getRun } from "../runs/[id]/route";
import { GET as getShortlistRoute } from "../shortlist/route";
import { POST as stageDraftRoute } from "../drafts/route";

let slowGate: Promise<void> | undefined;
registerSource({
  id: "pantheon-route-test-source",
  label: "test double",
  auth: "none",
  fetch: async () => {
    await slowGate;
    return nextGigs;
  },
});

let tmpDir: string;
let secretsDir: string;
let facadeStatus = 200;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-pantheon-routes-test-"));
  secretsDir = path.join(tmpDir, "secrets");
  fs.mkdirSync(secretsDir);
  process.env.GIGRADAR_DB_PATH = path.join(tmpDir, "gigs.db");
  process.env.PANTHEON_SECRETS_SHARED_DIR = secretsDir;
  process.env.PANTHEON_CORE_API_URL = "http://core-api.test:3012";
  getDb();
  resetOperatorTokenCache();
  facadeStatus = 200;
  slowGate = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://core-api.test:3012/api/secrets/inject");
      const body = JSON.parse(String(init?.body)) as { path: string; key: string };
      if (facadeStatus === 200) fs.writeFileSync(body.path, `${body.key}=${TOKEN}\n`);
      return new Response("{}", { status: facadeStatus });
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  nextGigs = [
    { sourceId: "pantheon-route-test-source", externalId: "remote", title: "Fractional CTO", url: "https://example.com/1", remote: true },
    { sourceId: "pantheon-route-test-source", externalId: "onsite", title: "Fractional CTO", url: "https://example.com/2", remote: false },
  ];
});

afterEach(async () => {
  await inFlightRun();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  closeDb();
  for (const k of ["GIGRADAR_DB_PATH", "PANTHEON_SECRETS_SHARED_DIR", "PANTHEON_CORE_API_URL"]) delete process.env[k];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(url: string, init: RequestInit & { token?: string | null } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set("x-pantheon-operator-token", init.token ?? TOKEN);
  return new Request(`http://gigradar.test${url}`, { ...init, headers });
}

describe("/api/pantheon routes", () => {
  it("trigger -> status -> shortlist, with reasons for both a passed and a rejected gig", async () => {
    const triggered = await triggerRun(req("/api/pantheon/runs", { method: "POST" }));
    expect(triggered.status).toBe(202);
    const { run } = (await triggered.json()) as { run: { id: string; status: string } };
    expect(run.status).toBe("running");

    await inFlightRun();
    const status = await getRun(req(`/api/pantheon/runs/${run.id}`), { params: Promise.resolve({ id: run.id }) });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { run: unknown }).run).toMatchObject({ id: run.id, status: "succeeded", passedCount: 1, rejectedCount: 1 });

    const latest = (await (await getLatestRun(req("/api/pantheon/runs"))).json()) as { run: { id: string } };
    expect(latest.run.id).toBe(run.id);

    const shortlist = await getShortlistRoute(req("/api/pantheon/shortlist"));
    expect(shortlist.status).toBe(200);
    expect(shortlist.headers.get("cache-control")).toBe("no-store");
    const body = (await shortlist.json()) as { passed: { reasons: string[] }[]; rejected: { reasons: string[]; checks: unknown[] }[] };
    expect(body.passed).toHaveLength(1);
    expect(body.passed[0]!.reasons.length).toBeGreaterThan(0);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.reasons).toContain("✗ not remote");
    expect(body.rejected[0]!.checks).toContainEqual({ result: "fail", text: "✗ not remote" });

    // The injected token file never lingers on the shared volume.
    expect(fs.readdirSync(secretsDir)).toEqual([]);
  });

  it("409s a trigger while a run is in flight", async () => {
    let release!: () => void;
    slowGate = new Promise<void>((r) => (release = r));
    const first = await triggerRun(req("/api/pantheon/runs", { method: "POST" }));
    const second = await triggerRun(req("/api/pantheon/runs", { method: "POST" }));
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    release();
  });

  it("401s every route without a valid operator token", async () => {
    for (const res of [
      await triggerRun(req("/api/pantheon/runs", { method: "POST", token: null })),
      await getLatestRun(req("/api/pantheon/runs", { token: "wrong" })),
      await getRun(req("/api/pantheon/runs/x", { token: null }), { params: Promise.resolve({ id: "x" }) }),
      await getShortlistRoute(req("/api/pantheon/shortlist", { token: "wrong" })),
      await stageDraftRoute(req("/api/pantheon/drafts", { method: "POST", token: null, body: "{}" })),
    ]) {
      expect(res.status).toBe(401);
    }
    expect(await inFlightRun()).toBeUndefined();
  });

  it("503s (fails closed) when the facade cannot supply the operator token", async () => {
    facadeStatus = 502;
    const res = await triggerRun(req("/api/pantheon/runs", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(await inFlightRun()).toBeUndefined();
  });

  it("404s status and shortlist before any run, and 400s a draft request without a key", async () => {
    expect((await getLatestRun(req("/api/pantheon/runs"))).status).toBe(404);
    expect((await getShortlistRoute(req("/api/pantheon/shortlist"))).status).toBe(404);
    expect((await stageDraftRoute(req("/api/pantheon/drafts", { method: "POST", body: "{}" }))).status).toBe(400);
    expect((await stageDraftRoute(req("/api/pantheon/drafts", { method: "POST", body: "not json" }))).status).toBe(400);
  });
});
