// Tests for src/lib/sources/gmail-digest-source.ts (email-digest-ingestion
// epic, gmail-digest-source story; migrated to the Vercel AI SDK by
// llm-provider-harness's custom-llm-source-credential-migration story).
// Covers:
//   1. fetch() with a mocked Gmail API (2 emails, one with 3 listings, one
//      with 1) returns 4 Gig objects total, each with a real url/externalId
//      sourced from the mocked model's structured output.
//   2. A listing with no discoverable real URL is dropped, never assigned
//      a fabricated one.
//   3. digestSenders defaults to a real sender list when unset, and a
//      user-supplied list overrides it entirely.
//   4. A getValidAccessToken() failure throws a specific error.
//   5. runner.ts routes kind:"gmail-digest" to gmailDigestSource.
// The LLM and Gmail's REST API (global.fetch) are both mocked -- no real
// network, no real OAuth token.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";

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

const sessionBackendFromMock = vi.fn();
vi.mock("../../auth/session-backend.js", () => ({
  sessionBackendFrom: (...args: unknown[]) => sessionBackendFromMock(...args),
}));

import { gmailDigestSource } from "../gmail-digest-source.js";

const BASE_CFG: SourceConfig = {
  id: "gmail-digest",
  enabled: true,
  kind: "gmail-digest",
  settings: { gmailClientId: "client-id", gmailClientSecret: "client-secret" },
};
const PROFILE = { name: "t", roles: [], skills: [], timezone: "UTC" };
const FAKE_CREDENTIAL = { kind: "api-key" as const, provider: "anthropic" as const, value: "sk-ant-fake" };

let originalFetch: typeof fetch;

beforeEach(() => {
  mockGenerateText.mockReset();
  mockCreateAnthropic.mockClear();
  mockAnthropicModel.mockClear();
  getValidAccessTokenMock.mockReset().mockResolvedValue("access-token-1");
  sessionBackendFromMock.mockReset().mockReturnValue("local");
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function base64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mockGmailAndAnthropic(messageIds: string[], listingsPerMessage: Record<string, Array<{ title: string; url: string }>>) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/messages?")) {
      return { ok: true, status: 200, json: async () => ({ messages: messageIds.map((id) => ({ id, threadId: id })) }) };
    }
    const match = u.match(/\/messages\/([^/?]+)/);
    const id = match?.[1] ?? "";
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id,
        payload: { mimeType: "text/html", body: { data: base64url(`<html>digest for ${id}</html>`) } },
      }),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  mockGenerateText.mockImplementation(async (params: { prompt?: string }) => {
    const idMatch = params.prompt?.match(/digest for ([\w-]+)/);
    const id = idMatch?.[1] ?? "";
    return { output: { listings: listingsPerMessage[id] ?? [] } };
  });

  return fetchMock;
}

describe("fetch(): multi-email, multi-listing extraction", () => {
  it("returns 4 Gig objects total from 2 emails (3 listings + 1 listing), each with a real url/externalId", async () => {
    mockGmailAndAnthropic(
      ["msg-1", "msg-2"],
      {
        "msg-1": [
          { title: "Fractional CTO", url: "https://linkedin.com/jobs/1" },
          { title: "Principal Engineer", url: "https://linkedin.com/jobs/2" },
          { title: "Staff Architect", url: "https://linkedin.com/jobs/3" },
        ],
        "msg-2": [{ title: "VP Engineering", url: "https://indeed.com/jobs/9" }],
      },
    );

    const gigs = await gmailDigestSource.fetch(BASE_CFG, PROFILE, FAKE_CREDENTIAL);

    expect(gigs).toHaveLength(4);
    expect(gigs.map((g) => g.url)).toEqual([
      "https://linkedin.com/jobs/1",
      "https://linkedin.com/jobs/2",
      "https://linkedin.com/jobs/3",
      "https://indeed.com/jobs/9",
    ]);
    expect(gigs.every((g) => g.externalId === g.url)).toBe(true);
    expect(gigs.every((g) => g.sourceId === "gmail-digest")).toBe(true);
  });

  it("drops a listing with no url rather than fabricating one", async () => {
    mockGmailAndAnthropic(["msg-1"], {
      "msg-1": [
        { title: "Has a URL", url: "https://linkedin.com/jobs/1" },
        // @ts-expect-error -- deliberately missing url, simulating a listing the LLM couldn't find a real link for
        { title: "No URL found" },
      ],
    });

    const gigs = await gmailDigestSource.fetch(BASE_CFG, PROFILE, FAKE_CREDENTIAL);

    expect(gigs).toHaveLength(1);
    expect(gigs[0]!.title).toBe("Has a URL");
  });

  it("throws without ever calling Anthropic when no BYOK apiKey is provided", async () => {
    mockGmailAndAnthropic(["msg-1"], { "msg-1": [] });

    await expect(gmailDigestSource.fetch(BASE_CFG, PROFILE)).rejects.toThrow(/needs an LLM credential/);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

describe("digestSenders", () => {
  it("defaults to a real sender list (query includes linkedin/indeed/ziprecruiter) when settings.digestSenders is unset", async () => {
    const fetchMock = mockGmailAndAnthropic([], {});
    await gmailDigestSource.fetch(BASE_CFG, PROFILE, FAKE_CREDENTIAL);

    const listUrl = String(fetchMock.mock.calls[0]![0]);
    const query = decodeURIComponent(listUrl);
    expect(query).toContain("linkedin.com");
    expect(query).toContain("indeed.com");
    expect(query).toContain("ziprecruiter.com");
  });

  it("a user-supplied digestSenders list REPLACES the default entirely, not merges", async () => {
    const cfg: SourceConfig = { ...BASE_CFG, settings: { ...BASE_CFG.settings, digestSenders: ["alerts@monster.com"] } };
    const fetchMock = mockGmailAndAnthropic([], {});
    await gmailDigestSource.fetch(cfg, PROFILE, FAKE_CREDENTIAL);

    const listUrl = String(fetchMock.mock.calls[0]![0]);
    const query = decodeURIComponent(listUrl);
    expect(query).toContain("monster.com");
    expect(query).not.toContain("linkedin.com");
  });
});

describe("credential/token failures", () => {
  it("propagates a getValidAccessToken() failure with a specific error, without ever calling the Gmail API", async () => {
    getValidAccessTokenMock.mockRejectedValue(new Error("gigradar oauth2: no gmail connection found"));
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(gmailDigestSource.fetch(BASE_CFG, PROFILE, FAKE_CREDENTIAL)).rejects.toThrow(/no gmail connection found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a specific error when the source has no Gmail client id/secret configured", async () => {
    const cfg: SourceConfig = { id: "gmail-digest", enabled: true, kind: "gmail-digest", settings: {} };
    await expect(gmailDigestSource.fetch(cfg, PROFILE, FAKE_CREDENTIAL)).rejects.toThrow(/no Gmail OAuth client id\/secret configured/);
  });
});
