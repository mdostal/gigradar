// Tests for career-documents epic's resume-store story
// (../resume-store.ts). Same "separate tmp XDG_DATA_HOME/XDG_CONFIG_HOME
// per test" isolation session-capture.test.ts/vault.test.ts already use --
// resume storage goes through the SAME encrypt()-at-rest mechanism, so it
// needs the same key/data-dir separation to avoid a real key/data
// collision warning.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplyProfileConfigSchema } from "../../config/schema.js";
import { decrypt } from "../../security/vault.js";
import { deleteResume, getResumePath, loadResume, saveResume } from "../resume-store.js";

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

describe("saveResume/loadResume: round-trip", () => {
  it("saves and loads back the exact original bytes and mediaType", () => {
    const { path: savedPath } = saveResume(FAKE_PDF_BYTES, "application/pdf");
    expect(savedPath).toBe(getResumePath());

    const loaded = loadResume(savedPath);
    expect(loaded).toBeDefined();
    expect(loaded?.mediaType).toBe("application/pdf");
    expect(Buffer.compare(loaded!.data, FAKE_PDF_BYTES)).toBe(0);
  });

  it("a second saveResume() call overwrites the first (no versioning in v1)", () => {
    saveResume(FAKE_PDF_BYTES, "application/pdf");
    const secondBytes = Buffer.from("a completely different resume");
    const { path: savedPath } = saveResume(secondBytes, "text/plain");

    const loaded = loadResume(savedPath);
    expect(loaded?.mediaType).toBe("text/plain");
    expect(Buffer.compare(loaded!.data, secondBytes)).toBe(0);
  });
});

describe("saveResume: encrypted at rest, never plaintext on disk", () => {
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
    const files = fs.readdirSync(path.dirname(getResumePath()));
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe("loadResume: missing file", () => {
  it("returns undefined (never throws) when no resume has ever been saved", () => {
    expect(loadResume(getResumePath())).toBeUndefined();
  });

  it("returns undefined for an arbitrary nonexistent path", () => {
    expect(loadResume(path.join(tmpDataDir, "does-not-exist.enc"))).toBeUndefined();
  });
});

describe("deleteResume", () => {
  it("removes a saved resume -- loadResume() afterward returns undefined", () => {
    const { path: savedPath } = saveResume(FAKE_PDF_BYTES, "application/pdf");
    expect(loadResume(savedPath)).toBeDefined();

    deleteResume(savedPath);

    expect(loadResume(savedPath)).toBeUndefined();
  });

  it("is a silent no-op when the file is already gone", () => {
    expect(() => deleteResume(getResumePath())).not.toThrow();
  });
});

describe("ApplyProfileConfigSchema: resumePath", () => {
  it("accepts a Config with resumePath set", () => {
    const result = ApplyProfileConfigSchema.safeParse({ email: "jane@example.com", resumePath: getResumePath() });
    expect(result.success).toBe(true);
    expect(result.success && result.data.resumePath).toBe(getResumePath());
  });

  it("accepts a Config with resumePath omitted (no resume on file yet, not an error)", () => {
    const result = ApplyProfileConfigSchema.safeParse({ email: "jane@example.com" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.resumePath).toBeUndefined();
  });
});
