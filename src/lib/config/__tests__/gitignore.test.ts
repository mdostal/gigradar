// Real subprocess tests against `git check-ignore` — not a static read of
// .gitignore's contents — proving config.json/.env are excluded from git
// tracking both at the repo root AND (belt-and-suspenders) anywhere nested
// inside the tree, in case the resolved XDG directory ever ended up inside
// the repo by misconfiguration. See
// .pHive/epics/local-secrets-config-storage/stories/env-secrets-and-templates.yaml
// acceptance criteria.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultDataDir } from "../../store/path.js";

// src/lib/config/__tests__ -> config -> lib -> src -> repo root.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

function checkIgnore(relativePath: string): { ignored: boolean; stderr: string } {
  const result = spawnSync("git", ["check-ignore", "-q", relativePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  // git check-ignore exit codes: 0 = ignored, 1 = not ignored, 128 = fatal error.
  return { ignored: result.status === 0, stderr: result.stderr ?? "" };
}

describe("git check-ignore: repo-root config.json / .env", () => {
  it("confirms a stray repo-root config.json would be ignored", () => {
    const { ignored } = checkIgnore("config.json");
    expect(ignored).toBe(true);
  });

  it("confirms a stray repo-root .env would be ignored", () => {
    const { ignored } = checkIgnore(".env");
    expect(ignored).toBe(true);
  });

  it("does NOT ignore config.example.json (the committed template, a different filename)", () => {
    const { ignored } = checkIgnore("config.example.json");
    expect(ignored).toBe(false);
  });

  it("does NOT ignore .env.example (the committed template, a different filename)", () => {
    const { ignored } = checkIgnore(".env.example");
    expect(ignored).toBe(false);
  });
});

describe("git check-ignore: belt-and-suspenders — nested paths (as if the XDG dir landed inside the repo)", () => {
  it("confirms config.json is ignored at any nesting depth, not just the repo root", () => {
    const { ignored } = checkIgnore("some/deeply/nested/gigradar-data-dir/config.json");
    expect(ignored).toBe(true);
  });

  it("confirms .env is ignored at any nesting depth, not just the repo root", () => {
    const { ignored } = checkIgnore("some/deeply/nested/gigradar-data-dir/.env");
    expect(ignored).toBe(true);
  });
});

describe("git check-ignore: the REAL resolved XDG data directory", () => {
  it("is entirely outside the repo tree — git refuses to even evaluate it, the strongest possible confirmation it can never be tracked", () => {
    const dataDir = getDefaultDataDir();
    const configPath = path.join(dataDir, "config.json");

    const result = spawnSync("git", ["check-ignore", "-q", configPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    // git check-ignore fatally refuses (exit 128) to evaluate an absolute
    // path outside the repository's working tree — proof the default XDG
    // location isn't just gitignored, it's not part of the repo at all.
    // (The exact message varies with whether the directory happens to
    // exist on this machine — "outside repository" if it does, "No such
    // file or directory" / "Invalid path" if it doesn't — but the refusal,
    // exit 128, is consistent either way and is what we're proving here.
    // Deliberately does NOT create this directory to satisfy a message
    // check: that would touch a real user's actual XDG data dir, which
    // this story's tests must never do.)
    expect(result.status).toBe(128);
    expect(result.stderr).toMatch(/outside repository|no such file|invalid path/i);
  });
});
