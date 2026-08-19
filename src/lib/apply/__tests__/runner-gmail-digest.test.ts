// Tests for runRadar()'s gmail-digest routing fallback (email-digest-
// ingestion epic, gmail-digest-source story): `getSource(sc.id) ??
// (sc.kind === "custom-llm" ? customLlmSource : sc.kind === "gmail-digest"
// ? gmailDigestSource : undefined)`. Deliberately SEPARATE from
// runner-custom-source.test.ts and gmail-digest-source.test.ts (which
// tests extraction logic in isolation, never through runRadar()) -- this
// file's only job is proving the actual end-to-end wiring: a source id
// with NO hand-written adapter and NO registerSource() call still
// produces real gigs when runRadar() is called, purely via config
// (`kind: "gmail-digest"`). The LLM (via the Vercel AI SDK,
// llm-provider-harness's custom-llm-source-credential-migration story) and
// Gmail's REST API (global.fetch) are both mocked -- no live network, no
// real OAuth token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "../../store/index.js";
import type { Config } from "../../types.js";

const { mockGenerateText, mockCreateAnthropic, mockAnthropicModel } = vi.hoisted(() => {
  const mockAnthropicModel = vi.fn((modelId: string) => ({ modelId, provider: "anthropic" }));
  return {
    mockGenerateText: vi.fn(),
    mockCreateAnthropic: vi.fn(() => mockAnthropicModel),
    mockAnthropicModel,
  };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: mockGenerateText };
});

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: mockCreateAnthropic }));

const getValidAccessTokenMock = vi.fn();
vi.mock("../../auth/oauth2.js", () => ({
  getValidAccessToken: (...args: unknown[]) => getValidAccessTokenMock(...args),
}));

import { runRadar } from "../runner.js";

const FAKE_CREDENTIAL = { kind: "api-key" as const, provider: "anthropic" as const, value: "fake-api-key" };

function base64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function setUpFakeGmailAndAnthropic(listings: Array<{ title: string; url: string }>) {
  getValidAccessTokenMock.mockResolvedValue("access-token-1");

  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/messages?")) {
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: "msg-1", threadId: "msg-1" }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "msg-1", payload: { mimeType: "text/html", body: { data: base64url("<html>digest</html>") } } }),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  mockGenerateText.mockResolvedValue({ output: { listings } });
}

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;
let originalFetch: typeof fetch;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-runner-gmail-digest-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
  mockGenerateText.mockReset();
  mockCreateAnthropic.mockClear();
  mockAnthropicModel.mockClear();
  getValidAccessTokenMock.mockReset();
  originalFetch = global.fetch;
});

afterEach(() => {
  closeDb();
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    needs: { engagementProfiles: [], freshStageOnly: false, remoteOnly: false },
    sources: [
      {
        id: "gmail-digest",
        enabled: true,
        kind: "gmail-digest",
        settings: { gmailClientId: "client-id", gmailClientSecret: "client-secret" },
      },
    ],
  };
}

describe('runRadar(): kind:"gmail-digest" routing fallback', () => {
  it("fetches real gigs for an id with NO registerSource() call at all, purely via config", async () => {
    setUpFakeGmailAndAnthropic([{ title: "Fractional CTO", url: "https://linkedin.com/jobs/1" }]);

    const result = await runRadar(makeConfig(), { db }, { credential: FAKE_CREDENTIAL });

    expect(result.errors).toEqual([]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.gig.title).toBe("Fractional CTO");
    expect(result.results[0]?.gig.sourceId).toBe("gmail-digest");
  });

  it("reports a per-source error (never a thrown exception out of runRadar itself) when the token is invalid/missing", async () => {
    getValidAccessTokenMock.mockRejectedValue(new Error("gigradar oauth2: no gmail connection found for source \"gmail-digest\""));

    const result = await runRadar(makeConfig(), { db }, { credential: FAKE_CREDENTIAL });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.sourceId).toBe("gmail-digest");
    expect(result.errors[0]?.message).toContain("no gmail connection found");
  });

  it("a plain (non-gmail-digest) source id with no registerSource() entry and no kind still reports 'no such registered source'", async () => {
    const config: Config = {
      ...makeConfig(),
      sources: [{ id: "totally-unregistered", enabled: true, settings: {} }],
    };

    const result = await runRadar(config, { db }, {});

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("no such registered source");
  });
});
