import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../../lib/config/save.js";
import { closeDb, getGig, listGigs, recordScan } from "../../lib/store/index.js";
import type { Gig } from "../../lib/types.js";
import { GIG_STATUS_VALUES, createServer } from "../server.js";

// Same XDG_DATA_HOME/XDG_CONFIG_HOME test-isolation pattern this project
// already uses everywhere (src/lib/config/__tests__/load.test.ts,
// save.test.ts) — this suite never touches a real user's actual config.json,
// gigs.db, or vault key. GIG_STATUS_VALUES exported from server.ts so this
// suite exercises the exact real enum, never a hand-copied duplicate.
let tmpDataDir: string;
let tmpConfigDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;
const envVarsTouchedByTests = new Set<string>();

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-mcp-test-data-"));
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-mcp-test-config-"));
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = tmpDataDir;
  process.env.XDG_CONFIG_HOME = tmpConfigDir;
});

afterEach(() => {
  closeDb();
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  for (const varName of envVarsTouchedByTests) delete process.env[varName];
  envVarsTouchedByTests.clear();
  vi.restoreAllMocks();
});

/** A minimal, ConfigSchema-valid config document (see src/lib/config/schema.ts). */
function validConfigDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile: { name: "Ada", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: {
          engagementProfiles: [
            {
              id: "fractional-contract",
              label: "Fractional/contract",
              types: ["contract", "fractional"],
              minRate: 100,
              highRate: 250,
              maxHours: 20,
              maxHoursAtHighRate: 40,
              rateUnit: "hour",
            },
          ],
          freshStageOnly: false,
          remoteOnly: false,
        },
      },
    ],
    sources: [],
    ...overrides,
  };
}

function makeGig(overrides: Partial<Gig> & { sourceId: string; externalId: string; title: string }): Gig {
  return {
    url: `https://example.com/${overrides.sourceId}/${overrides.externalId}`,
    ...overrides,
  };
}

/** Connects a fresh createServer() to a real Client over InMemoryTransport — the real tool-registration + input-validation path, not a direct handleXxx() call. */
async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gigradar-test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Parses a tool result's single text content block back into JSON (every non-error tool result here is JSON). */
function parseJsonResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]?.text ?? "null");
}

describe("createServer: tool registration", () => {
  it("exposes exactly the 5 documented tools", async () => {
    const { client, close } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "get_gig",
        "get_status_summary",
        "list_gigs",
        "run_scan",
        "update_gig_status",
      ]);
    } finally {
      await close();
    }
  });

  it("get_gig's and update_gig_status's `key` schema description documents it as opaque/from list_gigs, never agent-constructed", async () => {
    const { client, close } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      for (const name of ["get_gig", "update_gig_status"]) {
        const tool = tools.find((t) => t.name === name);
        const keyDescription = (tool?.inputSchema.properties as Record<string, { description?: string }>)?.key
          ?.description;
        expect(keyDescription, `${name}'s key description`).toBeDefined();
        expect(keyDescription).toMatch(/opaque/i);
        expect(keyDescription).toMatch(/list_gigs/);
      }
    } finally {
      await close();
    }
  });

  it("update_gig_status's status schema restricts to exactly the real GigStatus enum values", async () => {
    const { client, close } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "update_gig_status");
      const statusSchema = (tool?.inputSchema.properties as Record<string, { enum?: string[] }>)?.status;
      expect(statusSchema?.enum?.slice().sort()).toEqual([...GIG_STATUS_VALUES].sort());
    } finally {
      await close();
    }
  });
});

describe("list_gigs", () => {
  it("given a tier filter, returns exactly the gigs listGigs() itself would return for that filter", async () => {
    recordScan([
      {
        sourceId: "braintrust",
        gigs: [
          { ...makeGig({ sourceId: "braintrust", externalId: "1", title: "Green Gig" }), tier: "green" },
          { ...makeGig({ sourceId: "braintrust", externalId: "2", title: "Yellow Gig" }), tier: "yellow" },
          { ...makeGig({ sourceId: "braintrust", externalId: "3", title: "Red Gig" }), tier: "red" },
        ],
      },
    ]);

    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({ name: "list_gigs", arguments: { tier: "green" } });
      const gigs = parseJsonResult(result) as { key: string }[];

      const expected = listGigs().filter((g) => g.tier === "green");
      expect(gigs.map((g) => g.key).sort()).toEqual(expected.map((g) => g.key).sort());
      expect(gigs).toHaveLength(1);
      expect(gigs[0]?.key).toBe("braintrust:1");
    } finally {
      await close();
    }
  });

  it("filters by status, passed straight through to listGigs()'s own GigFilter", async () => {
    recordScan([
      { sourceId: "braintrust", gigs: [makeGig({ sourceId: "braintrust", externalId: "1", title: "A" })] },
    ]);
    // Second gig, then mark it applied so the two rows differ by status.
    recordScan([
      { sourceId: "braintrust", gigs: [makeGig({ sourceId: "braintrust", externalId: "2", title: "B" })] },
    ]);
    const { setStatus } = await import("../../lib/store/gigs.js");
    setStatus("braintrust:2", "applied");

    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({ name: "list_gigs", arguments: { status: "applied" } });
      const gigs = parseJsonResult(result) as { key: string }[];
      expect(gigs.map((g) => g.key)).toEqual(["braintrust:2"]);
    } finally {
      await close();
    }
  });

  it("filters by a case-insensitive search over title+company", async () => {
    recordScan([
      {
        sourceId: "braintrust",
        gigs: [
          makeGig({ sourceId: "braintrust", externalId: "1", title: "Staff Backend Engineer", company: "Acme" }),
          makeGig({ sourceId: "braintrust", externalId: "2", title: "Marketing Lead", company: "Other" }),
        ],
      },
    ]);

    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({ name: "list_gigs", arguments: { search: "acme" } });
      const gigs = parseJsonResult(result) as { key: string }[];
      expect(gigs.map((g) => g.key)).toEqual(["braintrust:1"]);
    } finally {
      await close();
    }
  });
});

describe("get_gig", () => {
  it("given a key exactly matching one returned by a prior list_gigs call, resolves to that same gig", async () => {
    recordScan([
      {
        sourceId: "braintrust",
        gigs: [makeGig({ sourceId: "braintrust", externalId: "42", title: "Fractional CTO", company: "Acme" })],
      },
    ]);

    const { client, close } = await connectedClient();
    try {
      const listResult = await client.callTool({ name: "list_gigs", arguments: {} });
      const gigs = parseJsonResult(listResult) as { key: string }[];
      expect(gigs).toHaveLength(1);
      const key = gigs[0]?.key as string;

      const getResult = await client.callTool({ name: "get_gig", arguments: { key } });
      const gig = parseJsonResult(getResult) as { key: string; title: string };
      expect(gig.key).toBe(key);
      expect(gig.title).toBe("Fractional CTO");
    } finally {
      await close();
    }
  });

  it("an unknown key is a clean tool error, not a thrown exception", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({ name: "get_gig", arguments: { key: "does-not-exist:1" } });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("update_gig_status", () => {
  it("a status value NOT in the real GigStatus enum is rejected at the tool's own input-schema validation, before setStatus() is ever called", async () => {
    recordScan([
      { sourceId: "braintrust", gigs: [makeGig({ sourceId: "braintrust", externalId: "1", title: "A" })] },
    ]);

    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "update_gig_status",
        arguments: { key: "braintrust:1", status: "not-a-real-status" },
      });
      expect(result.isError).toBe(true);

      // The real proof it never reached setStatus(): the gig's status in
      // the store is untouched (still the store's own "new" default).
      expect(getGig("braintrust:1")?.status).toBe("new");
    } finally {
      await close();
    }
  });

  it("a valid status updates the gig via setStatus() and the change is visible via getGig()", async () => {
    recordScan([
      { sourceId: "braintrust", gigs: [makeGig({ sourceId: "braintrust", externalId: "1", title: "A" })] },
    ]);

    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "update_gig_status",
        arguments: { key: "braintrust:1", status: "applied" },
      });
      expect(result.isError).toBeUndefined();
      expect(getGig("braintrust:1")?.status).toBe("applied");
    } finally {
      await close();
    }
  });

  it("an unknown key is a clean tool error (setStatus() throws, caught by the error boundary)", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "update_gig_status",
        arguments: { key: "does-not-exist:1", status: "applied" },
      });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("get_status_summary: secret-leak regression", () => {
  const SECRET_ENV_VAR = "GIGRADAR_TEST_MCP_SECRET";

  it("never includes a resolved env:-referenced secret value anywhere in its output", async () => {
    process.env[SECRET_ENV_VAR] = "sk-super-secret-do-not-leak-12345";
    envVarsTouchedByTests.add(SECRET_ENV_VAR);

    const saveResult = saveConfig(
      validConfigDoc({
        sources: [{ id: "braintrust", enabled: true, settings: { apiKey: `env:${SECRET_ENV_VAR}` } }],
      }),
    );
    expect(saveResult.ok).toBe(true);

    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({ name: "get_status_summary", arguments: {} });
      expect(result.isError).toBeUndefined();
      const raw = JSON.stringify(result);
      expect(raw).not.toContain("sk-super-secret-do-not-leak-12345");

      const summary = parseJsonResult(result) as { sourcesLabel: string; profileLabel: string; lastScanLabel: string };
      // Presence/shape/count information only — this IS expected to appear.
      expect(summary.sourcesLabel).toBe("1 source configured");
      expect(summary.profileLabel).toBe("Profile: complete");
    } finally {
      await close();
    }
  });

  it("renders the first-run state (no config.json yet) without throwing", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({ name: "get_status_summary", arguments: {} });
      expect(result.isError).toBeUndefined();
      const summary = parseJsonResult(result) as { sourcesLabel: string };
      expect(summary.sourcesLabel).toBe("0 sources configured");
    } finally {
      await close();
    }
  });
});

describe("run_scan", () => {
  it("against a config with only auth:\"none\" sources, the real source adapters were registered and actually ran (not 'no such registered source'), verified without a live network dependency", async () => {
    const saveResult = saveConfig(
      validConfigDoc({
        sources: [
          { id: "braintrust", enabled: true },
          { id: "builtin", enabled: true },
        ],
      }),
    );
    expect(saveResult.ok).toBe(true);

    // Network-free test doubles for fetch, dispatched by URL — these are
    // the REAL registered braintrust/builtin adapters (imported for their
    // registerSource() side effect at the top of src/mcp/server.ts), just
    // never actually hitting the network. Matches the fixture-based
    // mocking convention this repo's own adapter tests use (see
    // src/lib/sources/__tests__/braintrust.test.ts / builtin.test.ts).
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://app.usebraintrust.com/")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ count: 0, next: null, previous: null, results: [] }),
        } as unknown as Response;
      }
      if (u.startsWith("https://builtin.com/")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => '<div id="jobs-list"></div>',
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch in run_scan test: ${u}`);
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const { client, close } = await connectedClient();
      try {
        const result = await client.callTool({ name: "run_scan", arguments: {} });
        expect(result.isError).toBeUndefined();
        const summary = parseJsonResult(result) as {
          passedCount: number;
          errors: { sourceId: string; message: string }[];
        };
        expect(summary.errors).toEqual([]);
        expect(summary.errors.some((e) => e.message === "no such registered source")).toBe(false);
        expect(fetchMock).toHaveBeenCalled();
      } finally {
        await close();
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("loadConfig() throwing (no config.json present) surfaces as a clean tool-error response, and the server stays alive for a subsequent call", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({ name: "run_scan", arguments: {} });
      expect(result.isError).toBe(true);

      // Server process (and this same client/server connection) still works.
      const followUp = await client.callTool({ name: "get_status_summary", arguments: {} });
      expect(followUp.isError).toBeUndefined();
    } finally {
      await close();
    }
  });
});
