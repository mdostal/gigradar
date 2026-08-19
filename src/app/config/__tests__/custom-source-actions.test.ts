// Tests for testCustomSourceExtractionAction() (llm-custom-sources epic,
// custom-source-pagination-and-ui story). `customLlmSource.fetch()` is
// mocked -- this file's job is the action's own logic (API-key resolution,
// input validation, the SourceConfig it builds, the preview-only "writes
// nothing" contract), not re-testing extraction itself (already covered by
// custom-llm-source.test.ts/custom-source-recipe.test.ts). `readEnvVar()`/
// `setEnvVar()` run for REAL against isolated temp XDG dirs -- same pattern
// resume-link-actions.test.ts already established for this exact
// "resolved fresh per-request" contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Gig, Profile, SourceConfig } from "@/lib/types";

const fetchMock = vi.fn();
vi.mock("@/lib/sources/custom-llm-source", () => ({
  customLlmSource: { id: "custom-llm", label: "Custom (LLM)", auth: "none", fetch: (...args: unknown[]) => fetchMock(...args) },
}));

import { getConfigPath } from "@/lib/config/load";
import { setEnvVar } from "@/lib/config/env-store";
import { testCustomSourceExtractionAction } from "../actions";

let tmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-custom-source-action-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-custom-source-action-test-key-"));
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = tmpDir;
  process.env.XDG_CONFIG_HOME = keyTmpDir;
  fetchMock.mockReset();
});

afterEach(() => {
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(keyTmpDir, { recursive: true, force: true });
});

const FAKE_GIGS: Gig[] = [
  { sourceId: "monster", externalId: "https://example.com/1", title: "Fractional CFO", url: "https://example.com/1" },
  { sourceId: "monster", externalId: "https://example.com/2", title: "Fractional CTO", url: "https://example.com/2" },
];

describe("testCustomSourceExtractionAction: success", () => {
  it("returns {ok:true, data:{count, titles}} from customLlmSource.fetch(), writing nothing to config.json", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");
    fetchMock.mockResolvedValue(FAKE_GIGS);

    const result = await testCustomSourceExtractionAction("monster", "https://example.com/jobs", undefined, "none", undefined);

    expect(result).toEqual({ ok: true, data: { count: 2, titles: ["Fractional CFO", "Fractional CTO"] } });
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });

  it("caps the returned titles preview at 5 even when more listings were found", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");
    const manyGigs: Gig[] = Array.from({ length: 8 }, (_, i) => ({ sourceId: "monster", externalId: `https://example.com/${i}`, title: `Listing ${i}`, url: `https://example.com/${i}` }));
    fetchMock.mockResolvedValue(manyGigs);

    const result = await testCustomSourceExtractionAction("monster", "https://example.com/jobs", undefined, "none", undefined);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.data.count).toBe(8);
    expect(result.data.titles).toHaveLength(5);
  });

  it("builds a SourceConfig with kind:\"custom-llm\" and the entered url/hint, passed straight to customLlmSource.fetch()", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");
    fetchMock.mockResolvedValue([]);

    await testCustomSourceExtractionAction("monster", "https://example.com/truck-jobs", "trucking jobs board", "none", undefined);

    const [cfg, , credential] = fetchMock.mock.calls[0] as [SourceConfig, Profile, { kind: string; value: string }];
    expect(cfg).toEqual({ id: "monster", enabled: true, kind: "custom-llm", settings: { url: "https://example.com/truck-jobs", hint: "trucking jobs board" } });
    expect(credential).toEqual({ kind: "api-key", provider: "anthropic", value: "sk-ant-fake-test-key" });
  });

  it("includes customAuth/sessionStatePath in settings only when customAuth is browser-session", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");
    fetchMock.mockResolvedValue([]);

    await testCustomSourceExtractionAction("monster", "https://example.com/jobs", undefined, "browser-session", "/fake/monster-session.json");

    const [cfg] = fetchMock.mock.calls[0] as [SourceConfig];
    expect(cfg.settings).toEqual({ url: "https://example.com/jobs", customAuth: "browser-session", sessionStatePath: "/fake/monster-session.json" });
  });

  it("omits sessionStatePath from settings when customAuth is browser-session but no path is given yet", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");
    fetchMock.mockResolvedValue([]);

    await testCustomSourceExtractionAction("monster", "https://example.com/jobs", undefined, "browser-session", undefined);

    const [cfg] = fetchMock.mock.calls[0] as [SourceConfig];
    expect(cfg.settings).toEqual({ url: "https://example.com/jobs", customAuth: "browser-session" });
  });
});

describe("testCustomSourceExtractionAction: validation and failure", () => {
  it("returns a specific error and never calls customLlmSource.fetch() when no LLM credential is set", async () => {
    const result = await testCustomSourceExtractionAction("monster", "https://example.com/jobs", undefined, "none", undefined);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("no Anthropic credential is set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a specific error and never calls customLlmSource.fetch() when sourceId is blank", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");

    const result = await testCustomSourceExtractionAction("", "https://example.com/jobs", undefined, "none", undefined);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("give this custom source a name");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a specific error and never calls customLlmSource.fetch() when url is blank", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");

    const result = await testCustomSourceExtractionAction("monster", "", undefined, "none", undefined);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("enter a URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces customLlmSource.fetch()'s SPECIFIC error verbatim, never a generic message", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "sk-ant-fake-test-key");
    fetchMock.mockRejectedValue(new Error("gigradar custom-llm-source: the Anthropic API response did not include the expected structured recipe result."));

    const result = await testCustomSourceExtractionAction("monster", "https://example.com/jobs", undefined, "none", undefined);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("did not include the expected structured recipe result");
  });
});
