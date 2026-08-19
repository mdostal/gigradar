// Tests for the two Server Actions the `resume-link-ui` story adds to
// `../actions.ts`: `setLlmApiKeyAction` and
// `extractProfileFromResumeAction`. `env-store.ts`'s `setEnvVar`/`readEnvVar`
// run FOR REAL against isolated temp XDG dirs (same pattern as
// `env-store.test.ts`/`actions.test.ts` — env-store.ts itself is already
// thoroughly unit-tested, so exercising the real thing here proves these
// actions are correctly wired to it, especially the "resolved fresh
// per-request" contract). `extractProfile()` (the real Anthropic-calling
// function) is mocked — this suite's job is these actions' own logic, not
// re-testing extract.ts's LLM-calling internals (already covered by
// extract.test.ts's own mocked-Anthropic-client suite).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExtractProfile = vi.fn();
vi.mock("@/lib/profile-ingestion/extract", () => ({
  extractProfile: (...args: unknown[]) => mockExtractProfile(...args),
}));

// career-documents epic: extractProfileFromResumeAction/removeResumeAction
// now call revalidatePath() on a successful resume-persistence write, same
// as every other config-mutating action in this file's sibling test files
// (actions.test.ts/capture-actions.test.ts/gmail-oauth-actions.test.ts)
// already mocks it for the same reason: revalidatePath() asserts it's
// running inside a real Next.js request context, which this Vitest suite
// isn't.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getConfigPath, getEnvPath } from "@/lib/config/load";
import { readEnvVar, setEnvVar } from "@/lib/config/env-store";
import { readRawConfig, saveConfig } from "@/lib/config/save";
import { loadResume } from "@/lib/documents/resume-store";
import { decrypt } from "@/lib/security/vault";
import { extractProfileFromResumeAction, removeResumeAction, setLlmApiKeyAction } from "../actions";

let tmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-resume-link-action-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-resume-link-action-test-key-"));
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = tmpDir;
  process.env.XDG_CONFIG_HOME = keyTmpDir;
  mockExtractProfile.mockReset();
});

afterEach(() => {
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(keyTmpDir, { recursive: true, force: true });
});

// -- setLlmApiKeyAction -------------------------------------------------

describe("setLlmApiKeyAction", () => {
  it("writes ANTHROPIC_API_KEY to .env (encrypted at rest) and readEnvVar() resolves it back (AC1)", async () => {
    const formData = new FormData();
    formData.set("provider", "anthropic");
    formData.set("apiKey", "sk-ant-real-looking-test-key-123");

    const result = await setLlmApiKeyAction(formData);

    expect(result.ok).toBe(true);
    expect(readEnvVar("ANTHROPIC_API_KEY")).toBe("sk-ant-real-looking-test-key-123");

    const raw = fs.readFileSync(getEnvPath(), "utf8");
    expect(raw).not.toContain("sk-ant-real-looking-test-key-123");
  });

  it("writes to the right env var per provider (llm-provider-harness epic)", async () => {
    const formData = new FormData();
    formData.set("provider", "openai");
    formData.set("apiKey", "sk-openai-test-key");

    const result = await setLlmApiKeyAction(formData);

    expect(result.ok).toBe(true);
    expect(readEnvVar("OPENAI_API_KEY")).toBe("sk-openai-test-key");
    expect(readEnvVar("ANTHROPIC_API_KEY")).toBeUndefined();
  });

  it("preserves other existing .env vars untouched (AC1)", async () => {
    setEnvVar("BRAINTRUST_API_KEY", "existing-unrelated-value");

    const formData = new FormData();
    formData.set("provider", "anthropic");
    formData.set("apiKey", "sk-ant-new-key");
    const result = await setLlmApiKeyAction(formData);

    expect(result.ok).toBe(true);
    expect(readEnvVar("BRAINTRUST_API_KEY")).toBe("existing-unrelated-value");
    expect(readEnvVar("ANTHROPIC_API_KEY")).toBe("sk-ant-new-key");
  });

  it("trims surrounding whitespace before writing", async () => {
    const formData = new FormData();
    formData.set("provider", "anthropic");
    formData.set("apiKey", "  sk-ant-with-whitespace  \n");

    await setLlmApiKeyAction(formData);

    expect(readEnvVar("ANTHROPIC_API_KEY")).toBe("sk-ant-with-whitespace");
  });

  it("rejects a blank/missing apiKey field without writing to .env", async () => {
    const formData = new FormData();
    formData.set("provider", "anthropic");
    formData.set("apiKey", "   ");

    const result = await setLlmApiKeyAction(formData);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.toLowerCase()).toContain("api key");
    expect(fs.existsSync(getEnvPath())).toBe(false);
  });

  it("rejects a completely missing apiKey field", async () => {
    const formData = new FormData();
    formData.set("provider", "anthropic");
    const result = await setLlmApiKeyAction(formData);

    expect(result.ok).toBe(false);
    expect(fs.existsSync(getEnvPath())).toBe(false);
  });

  it("rejects an unrecognized provider", async () => {
    const formData = new FormData();
    formData.set("provider", "not-a-real-provider");
    formData.set("apiKey", "sk-something");

    const result = await setLlmApiKeyAction(formData);

    expect(result.ok).toBe(false);
    expect(fs.existsSync(getEnvPath())).toBe(false);
  });
});

// -- extractProfileFromResumeAction -----------------------------------------

function fakeExtractResult(overrides: Partial<{ roles: string[]; skills: string[]; warnings: string[] }> = {}) {
  return { roles: [], skills: [], warnings: [], ...overrides };
}

describe("extractProfileFromResumeAction: missing credential (AC2)", () => {
  it("returns a specific error naming the 'Anthropic credential' field, not a generic auth failure, and never calls extractProfile()", async () => {
    expect(readEnvVar("ANTHROPIC_API_KEY")).toBeUndefined();

    const formData = new FormData();
    formData.set("links", "https://github.com/someone");

    const result = await extractProfileFromResumeAction(formData);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("Anthropic credential");
    expect(mockExtractProfile).not.toHaveBeenCalled();
  });
});

describe("extractProfileFromResumeAction: per-request credential resolution, not module scope (critical correctness fix)", () => {
  it("resolves a freshly-set key on the very next call, proving it isn't cached/resolved once", async () => {
    mockExtractProfile.mockResolvedValue(fakeExtractResult());

    setEnvVar("ANTHROPIC_API_KEY", "key-one");
    const first = await extractProfileFromResumeAction(new FormData());
    expect(first.ok).toBe(true);
    expect(mockExtractProfile).toHaveBeenNthCalledWith(1, expect.anything(), { kind: "api-key", provider: "anthropic", value: "key-one" });

    setEnvVar("ANTHROPIC_API_KEY", "key-two");
    const second = await extractProfileFromResumeAction(new FormData());
    expect(second.ok).toBe(true);
    expect(mockExtractProfile).toHaveBeenNthCalledWith(2, expect.anything(), { kind: "api-key", provider: "anthropic", value: "key-two" });
  });

  it("never resolves the key via process.env — a value set only in process.env (never written via setEnvVar/.env) is not used", async () => {
    mockExtractProfile.mockResolvedValue(fakeExtractResult());
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "process-env-value-should-be-ignored";
    try {
      const result = await extractProfileFromResumeAction(new FormData());
      expect(result.ok).toBe(false); // no .env-backed key was ever set
      expect(mockExtractProfile).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });
});

describe("extractProfileFromResumeAction: builds ExtractProfileInput from FormData", () => {
  beforeEach(() => {
    setEnvVar("ANTHROPIC_API_KEY", "test-key");
  });

  it("passes a PDF upload through as resumeFile with mediaType application/pdf", async () => {
    mockExtractProfile.mockResolvedValue(fakeExtractResult({ roles: ["Engineer"] }));
    const pdfBytes = Buffer.from("%PDF-1.4 fake pdf bytes");
    const file = new File([pdfBytes], "resume.pdf", { type: "application/pdf" });

    const formData = new FormData();
    formData.set("resumeFile", file);

    const result = await extractProfileFromResumeAction(formData);

    expect(result.ok).toBe(true);
    const [input] = mockExtractProfile.mock.calls[0] as [Record<string, unknown>];
    expect((input as { resumeFile?: { mediaType: string; data: Buffer } }).resumeFile?.mediaType).toBe(
      "application/pdf",
    );
    expect(
      ((input as { resumeFile?: { mediaType: string; data: Buffer } }).resumeFile?.data as Buffer).equals(pdfBytes),
    ).toBe(true);
    expect((input as { resumeText?: string }).resumeText).toBeUndefined();
  });

  it("passes a plain-text upload through as resumeText, not resumeFile", async () => {
    mockExtractProfile.mockResolvedValue(fakeExtractResult());
    const file = new File(["Jane Doe — backend engineer."], "resume.txt", { type: "text/plain" });

    const formData = new FormData();
    formData.set("resumeFile", file);

    await extractProfileFromResumeAction(formData);

    const [input] = mockExtractProfile.mock.calls[0] as [{ resumeText?: string; resumeFile?: unknown }];
    expect(input.resumeText).toContain("Jane Doe — backend engineer.");
    expect(input.resumeFile).toBeUndefined();
  });

  it("parses the links textarea into a trimmed, blank-line-dropped array", async () => {
    mockExtractProfile.mockResolvedValue(fakeExtractResult());
    const formData = new FormData();
    formData.set("links", "  https://github.com/jane  \n\n https://janedoe.dev\n   \n");

    await extractProfileFromResumeAction(formData);

    const [input] = mockExtractProfile.mock.calls[0] as [{ links?: string[] }];
    expect(input.links).toEqual(["https://github.com/jane", "https://janedoe.dev"]);
  });

  it("omits links entirely when the textarea is blank/absent", async () => {
    mockExtractProfile.mockResolvedValue(fakeExtractResult());

    await extractProfileFromResumeAction(new FormData());

    const [input] = mockExtractProfile.mock.calls[0] as [{ links?: string[] }];
    expect(input.links).toBeUndefined();
  });

  it("accepts a realistic-sized PDF (several MB) without rejecting it for size — exercising the raised body-size limit's request-handling path (AC3)", async () => {
    mockExtractProfile.mockResolvedValue(fakeExtractResult({ roles: ["Engineer"] }));
    const largePdfBytes = Buffer.alloc(5 * 1024 * 1024, 1); // 5MB, comfortably above the old 1MB default
    const file = new File([largePdfBytes], "big-resume.pdf", { type: "application/pdf" });
    const formData = new FormData();
    formData.set("resumeFile", file);

    const result = await extractProfileFromResumeAction(formData);

    expect(result.ok).toBe(true);
    const [input] = mockExtractProfile.mock.calls[0] as [{ resumeFile?: { data: Buffer } }];
    expect(input.resumeFile?.data.length).toBe(5 * 1024 * 1024);
  });
});

describe("extractProfileFromResumeAction: mixed-link partial-failure case (AC5)", () => {
  it("given extractProfile() resolves with 2-of-3 links' worth of data plus one warning, returns {ok:true} carrying both the results AND the warning — not a blank/failed state", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "test-key");
    mockExtractProfile.mockResolvedValue({
      roles: ["Fractional CTO"],
      skills: ["TypeScript", "Leadership"],
      warnings: ['Couldn\'t use "https://linkedin.com/in/someone" — it may require login.'],
    });

    const formData = new FormData();
    formData.set("links", "https://github.com/jane\nhttps://linkedin.com/in/someone\nhttps://janedoe.dev");

    const result = await extractProfileFromResumeAction(formData);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.roles).toEqual(["Fractional CTO"]);
    expect(result.data.skills).toEqual(["TypeScript", "Leadership"]);
    expect(result.data.warnings).toHaveLength(1);
    expect(result.data.warnings[0]).toContain("linkedin.com/in/someone");
  });
});

describe("extractProfileFromResumeAction: total failure surfaces extractProfile()'s specific error", () => {
  it("returns {ok:false,error} with extractProfile()'s own message when it throws (e.g. Anthropic API error)", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "test-key");
    mockExtractProfile.mockRejectedValue(new Error("gigradar profile ingestion: no usable input — some specific reason"));

    const result = await extractProfileFromResumeAction(new FormData());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("no usable input");
  });
});

describe("extractProfileFromResumeAction: never persists anything (regression guard)", () => {
  it("writes nothing to config.json, whether the call succeeds or fails", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "test-key");
    mockExtractProfile.mockResolvedValue(
      fakeExtractResult({ roles: ["Fractional CTO"], skills: ["TypeScript"], warnings: [] }),
    );

    const ok = await extractProfileFromResumeAction(new FormData());
    expect(ok.ok).toBe(true);
    expect(fs.existsSync(getConfigPath())).toBe(false);

    mockExtractProfile.mockRejectedValue(new Error("boom"));
    const failed = await extractProfileFromResumeAction(new FormData());
    expect(failed.ok).toBe(false);
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });
});

// -- career-documents epic, persist-resume-on-upload story ------------------

function seedBaseConfig(email = "jane@example.com") {
  return saveConfig({
    profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
    needs: {
      engagementProfiles: [
        { id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" },
      ],
      freshStageOnly: false,
      remoteOnly: false,
    },
    sources: [],
    applyProfile: { email },
  });
}

describe("extractProfileFromResumeAction: persists the uploaded resume (career-documents epic)", () => {
  beforeEach(() => {
    setEnvVar("ANTHROPIC_API_KEY", "test-key");
  });

  it("when applyProfile.email is already set, saves the resume and records resumePath in config.json", async () => {
    expect(seedBaseConfig().ok).toBe(true);
    mockExtractProfile.mockResolvedValue(fakeExtractResult({ roles: ["Engineer"] }));
    const pdfBytes = Buffer.from("%PDF-1.4 fake pdf bytes for persistence test");
    const file = new File([pdfBytes], "resume.pdf", { type: "application/pdf" });
    const formData = new FormData();
    formData.set("resumeFile", file);

    const result = await extractProfileFromResumeAction(formData);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.resumeSaved).toBe(true);
    expect(result.data.resumeSaveError).toBeUndefined();
    expect(result.data.resumePath).toBeDefined();

    const raw = readRawConfig() as { applyProfile?: { resumePath?: string; email?: string } };
    expect(raw.applyProfile?.resumePath).toBe(result.data.resumePath);
    expect(raw.applyProfile?.email).toBe("jane@example.com");

    const loaded = loadResume(result.data.resumePath!);
    expect(loaded).toBeDefined();
    expect(Buffer.compare(loaded!.data, pdfBytes)).toBe(0);
  });

  it("when no applyProfile.email is set yet, saves the resume FILE but reports a specific, actionable resumeSaveError instead of writing config.json", async () => {
    mockExtractProfile.mockResolvedValue(fakeExtractResult());
    const file = new File([Buffer.from("plain text resume")], "resume.txt", { type: "text/plain" });
    const formData = new FormData();
    formData.set("resumeFile", file);

    const result = await extractProfileFromResumeAction(formData);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.resumeSaved).toBe(false);
    expect(result.data.resumeSaveError).toContain("email");
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });

  it("extraction succeeds (roles/skills returned) even when resume persistence itself would fail -- the two are independent", async () => {
    mockExtractProfile.mockResolvedValue(fakeExtractResult({ roles: ["Fractional CTO"], skills: ["Leadership"] }));
    const file = new File([Buffer.from("resume text")], "resume.txt", { type: "text/plain" });
    const formData = new FormData();
    formData.set("resumeFile", file);

    const result = await extractProfileFromResumeAction(formData);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.roles).toEqual(["Fractional CTO"]);
    expect(result.data.skills).toEqual(["Leadership"]);
  });

  it("uploading only links (no resumeFile) never touches resume-store at all -- resumeSaved is false, no resumePath", async () => {
    expect(seedBaseConfig().ok).toBe(true);
    mockExtractProfile.mockResolvedValue(fakeExtractResult());
    const formData = new FormData();
    formData.set("links", "https://github.com/jane");

    const result = await extractProfileFromResumeAction(formData);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.resumeSaved).toBe(false);
    expect(result.data.resumePath).toBeUndefined();
  });
});

describe("removeResumeAction", () => {
  it("deletes the on-disk resume file and clears applyProfile.resumePath", async () => {
    expect(seedBaseConfig().ok).toBe(true);
    setEnvVar("ANTHROPIC_API_KEY", "test-key");
    mockExtractProfile.mockResolvedValue(fakeExtractResult());
    const file = new File([Buffer.from("a resume")], "resume.txt", { type: "text/plain" });
    const formData = new FormData();
    formData.set("resumeFile", file);
    const uploadResult = await extractProfileFromResumeAction(formData);
    if (!uploadResult.ok) throw new Error("expected ok");
    const resumePath = uploadResult.data.resumePath!;
    expect(loadResume(resumePath)).toBeDefined();

    const result = await removeResumeAction();

    expect(result.ok).toBe(true);
    expect(loadResume(resumePath)).toBeUndefined();
    const raw = readRawConfig() as { applyProfile?: { resumePath?: string; email?: string } };
    expect(raw.applyProfile?.resumePath).toBeUndefined();
    expect(raw.applyProfile?.email).toBe("jane@example.com");
  });

  it("is safe to call when no resume was ever saved -- no error, no config.json created", async () => {
    const result = await removeResumeAction();

    expect(result.ok).toBe(true);
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });
});

// Sanity check that decrypt() is reachable/used correctly by this suite's
// setup (mirrors env-store.test.ts's own convention of proving the on-disk
// bytes are genuinely encrypted, not just trusting setEnvVar()'s own tests).
describe("setLlmApiKeyAction: on-disk .env is genuinely encrypted, not plaintext", () => {
  it("the raw .env bytes decrypt to a KEY=VALUE line containing the saved key", async () => {
    const formData = new FormData();
    formData.set("provider", "anthropic");
    formData.set("apiKey", "sk-ant-decrypt-check");
    await setLlmApiKeyAction(formData);

    const raw = fs.readFileSync(getEnvPath(), "utf8");
    const decrypted = decrypt(raw);
    expect(decrypted).toContain("ANTHROPIC_API_KEY=sk-ant-decrypt-check");
  });
});
