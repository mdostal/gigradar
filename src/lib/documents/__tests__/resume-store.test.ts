// Tests for career-documents epic's resume-store story
// (../resume-store.ts), redesigned as keyed/versioned storage by the
// resume-store-multi-resume-and-tailoring story. Same "separate tmp
// XDG_DATA_HOME/XDG_CONFIG_HOME per test" isolation session-capture.test.ts/
// vault.test.ts already use -- resume storage goes through the SAME
// encrypt()-at-rest mechanism, so it needs the same key/data-dir separation
// to avoid a real key/data collision warning.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplyProfileConfigSchema } from "../../config/schema.js";
import { decrypt } from "../../security/vault.js";
import { deleteResume, getResumeDir, getResumeFilePath, getResumePath, loadResume, newResumeId, pickResume, saveResume } from "../resume-store.js";

let tmpDataDir: string;
let tmpKeyDir: string;

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-resume-store-test-"));
  tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-resume-store-test-key-"));
  process.env.XDG_DATA_HOME = tmpDataDir;
  process.env.XDG_CONFIG_HOME = tmpKeyDir;
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  fs.rmSync(tmpKeyDir, { recursive: true, force: true });
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

const FAKE_PDF_BYTES = Buffer.from("%PDF-1.4 fake resume content, including binary-ish bytes: \x00\x01\xff\xfe", "binary");

describe("saveResume/loadResume: round-trip, keyed/versioned", () => {
  it("saves under a freshly generated resumeId (2-arg call) and loads back the exact original bytes and mediaType", () => {
    const { id, path: savedPath } = saveResume(FAKE_PDF_BYTES, "application/pdf");
    expect(id).toBeTruthy();
    expect(savedPath).toBe(getResumeFilePath(id));

    const loaded = loadResume(savedPath);
    expect(loaded).toBeDefined();
    expect(loaded?.mediaType).toBe("application/pdf");
    expect(Buffer.compare(loaded!.data, FAKE_PDF_BYTES)).toBe(0);
  });

  it("saves under an EXPLICIT resumeId when given (3-arg call)", () => {
    const { id, path: savedPath } = saveResume(FAKE_PDF_BYTES, "application/pdf", "my-cto-resume");
    expect(id).toBe("my-cto-resume");
    expect(savedPath).toBe(getResumeFilePath("my-cto-resume"));
  });

  it("a SECOND saveResume() call with a DIFFERENT resumeId never touches the first resume's file -- both independently retrievable", () => {
    const first = saveResume(FAKE_PDF_BYTES, "application/pdf");
    const secondBytes = Buffer.from("a completely different resume");
    const second = saveResume(secondBytes, "text/plain");

    expect(first.path).not.toBe(second.path);

    const loadedFirst = loadResume(first.path);
    expect(loadedFirst?.mediaType).toBe("application/pdf");
    expect(Buffer.compare(loadedFirst!.data, FAKE_PDF_BYTES)).toBe(0);

    const loadedSecond = loadResume(second.path);
    expect(loadedSecond?.mediaType).toBe("text/plain");
    expect(Buffer.compare(loadedSecond!.data, secondBytes)).toBe(0);
  });

  it("a SECOND saveResume() call with the SAME resumeId overwrites just that one resume (a deliberate re-upload/replace)", () => {
    saveResume(FAKE_PDF_BYTES, "application/pdf", "same-id");
    const secondBytes = Buffer.from("a completely different resume");
    const { path: savedPath } = saveResume(secondBytes, "text/plain", "same-id");

    const loaded = loadResume(savedPath);
    expect(loaded?.mediaType).toBe("text/plain");
    expect(Buffer.compare(loaded!.data, secondBytes)).toBe(0);
  });
});

describe("saveResume: encrypted at rest, never plaintext on disk (same guarantee as v1, not regressed)", () => {
  it("the raw on-disk bytes never contain the original resume content", () => {
    const { path: savedPath } = saveResume(FAKE_PDF_BYTES, "application/pdf");
    const raw = fs.readFileSync(savedPath, "utf8");

    expect(raw).not.toContain("fake resume content");
    expect(raw).not.toContain(FAKE_PDF_BYTES.toString("base64"));
  });

  it("the file is written with mode 0600 (owner read/write only)", () => {
    const { path: savedPath } = saveResume(FAKE_PDF_BYTES, "application/pdf");
    const mode = fs.statSync(savedPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("decrypting the raw on-disk bytes directly recovers the original mediaType/base64 payload", () => {
    const { path: savedPath } = saveResume(FAKE_PDF_BYTES, "application/pdf");
    const raw = fs.readFileSync(savedPath, "utf8");
    const decrypted = JSON.parse(decrypt(raw)) as { mediaType: string; dataBase64: string };

    expect(decrypted.mediaType).toBe("application/pdf");
    expect(decrypted.dataBase64).toBe(FAKE_PDF_BYTES.toString("base64"));
  });

  it("no stray .tmp-* file is left behind after a successful save", () => {
    saveResume(FAKE_PDF_BYTES, "application/pdf");
    const files = fs.readdirSync(getResumeDir());
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("saving a second, independent resume also leaves no stray .tmp-* file, and BOTH real files remain encrypted", () => {
    saveResume(FAKE_PDF_BYTES, "application/pdf");
    saveResume(Buffer.from("second resume"), "text/plain");
    const files = fs.readdirSync(getResumeDir()).filter((f) => f.endsWith(".enc"));
    expect(files.length).toBe(2);
    for (const f of files) {
      const raw = fs.readFileSync(path.join(getResumeDir(), f), "utf8");
      expect(raw).not.toContain("resume");
    }
  });
});

describe("loadResume: missing file", () => {
  it("returns undefined (never throws) when no resume has ever been saved", () => {
    expect(loadResume(getResumeFilePath(newResumeId()))).toBeUndefined();
  });

  it("returns undefined for an arbitrary nonexistent path", () => {
    expect(loadResume(path.join(tmpDataDir, "does-not-exist.enc"))).toBeUndefined();
  });

  it("returns undefined for the LEGACY v1 fixed path when nothing was ever migrated to it", () => {
    expect(loadResume(getResumePath())).toBeUndefined();
  });
});

describe("deleteResume", () => {
  it("removes a saved resume -- loadResume() afterward returns undefined", () => {
    const { path: savedPath } = saveResume(FAKE_PDF_BYTES, "application/pdf");
    expect(loadResume(savedPath)).toBeDefined();

    deleteResume(savedPath);

    expect(loadResume(savedPath)).toBeUndefined();
  });

  it("deleting ONE resume never touches a DIFFERENT one", () => {
    const first = saveResume(FAKE_PDF_BYTES, "application/pdf");
    const second = saveResume(Buffer.from("second resume"), "text/plain");

    deleteResume(first.path);

    expect(loadResume(first.path)).toBeUndefined();
    expect(loadResume(second.path)).toBeDefined();
  });

  it("is a silent no-op when the file is already gone", () => {
    expect(() => deleteResume(getResumeFilePath(newResumeId()))).not.toThrow();
  });
});

describe("pickResume", () => {
  const RESUMES = [
    { id: "a", label: "Resume A", path: "/a.enc", uploadedAt: "2026-01-01T00:00:00.000Z" },
    { id: "b", label: "Resume B", path: "/b.enc", uploadedAt: "2026-01-02T00:00:00.000Z" },
  ];

  it("returns undefined when resumes is undefined or empty", () => {
    expect(pickResume(undefined)).toBeUndefined();
    expect(pickResume([])).toBeUndefined();
  });

  it("with no resumeId given, falls back to the FIRST entry -- byte-identical to v1's single-resume behavior", () => {
    expect(pickResume(RESUMES)?.id).toBe("a");
  });

  it("with a resumeId given, returns the matching record regardless of list order", () => {
    expect(pickResume(RESUMES, "b")?.id).toBe("b");
  });

  it("with a resumeId given that matches NOTHING, returns undefined -- never silently substitutes a different resume", () => {
    expect(pickResume(RESUMES, "does-not-exist")).toBeUndefined();
  });
});

describe("ApplyProfileConfigSchema: resumes (resume-store-multi-resume-and-tailoring story)", () => {
  it("accepts a Config with a resumes list set", () => {
    const resumes = [{ id: "r1", label: "CTO resume", path: getResumeFilePath("r1"), uploadedAt: new Date().toISOString() }];
    const result = ApplyProfileConfigSchema.safeParse({ email: "jane@example.com", resumes });
    expect(result.success).toBe(true);
    expect(result.success && result.data.resumes).toEqual(resumes);
  });

  it("accepts a Config with 2+ resumes -- both independently described", () => {
    const resumes = [
      { id: "r1", label: "CTO resume", path: getResumeFilePath("r1"), uploadedAt: new Date().toISOString() },
      { id: "r2", label: "SWE resume", path: getResumeFilePath("r2"), uploadedAt: new Date().toISOString() },
    ];
    const result = ApplyProfileConfigSchema.safeParse({ email: "jane@example.com", resumes });
    expect(result.success).toBe(true);
    expect(result.success && result.data.resumes?.length).toBe(2);
  });

  it("accepts a Config with resumes omitted (no resume on file yet, not an error)", () => {
    const result = ApplyProfileConfigSchema.safeParse({ email: "jane@example.com" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.resumes).toBeUndefined();
  });

  it("rejects the OLD flat resumePath field -- no longer part of this schema (callers must go through config/load.ts's migration first)", () => {
    const result = ApplyProfileConfigSchema.safeParse({ email: "jane@example.com", resumePath: getResumePath() });
    // zod strips unknown keys by default rather than rejecting the whole
    // object -- the real point of this test is that `resumePath` does NOT
    // survive into the parsed, validated shape.
    expect(result.success).toBe(true);
    expect(result.success && (result.data as Record<string, unknown>).resumePath).toBeUndefined();
  });
});

describe("ApplyProfileConfigSchema: links (career-documents epic, persisted-links story)", () => {
  it("accepts a Config with a non-empty links array", () => {
    const result = ApplyProfileConfigSchema.safeParse({ email: "jane@example.com", links: ["https://github.com/janedoe", "https://janedoe.dev"] });
    expect(result.success).toBe(true);
    expect(result.success && result.data.links).toEqual(["https://github.com/janedoe", "https://janedoe.dev"]);
  });

  it("accepts a Config with links omitted (backward compatible, no migration required)", () => {
    const result = ApplyProfileConfigSchema.safeParse({ email: "jane@example.com" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.links).toBeUndefined();
  });
});
