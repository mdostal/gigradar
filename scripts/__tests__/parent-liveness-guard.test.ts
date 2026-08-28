import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// runner-registry-and-sidecar-lifecycle epic, sidecar-orphan-self-detection
// story: real (not mocked) child-process behavior, same "spawn a real
// process, observe what it actually does" verification strategy
// electron/__tests__/server-ready.test.ts already uses for this app's
// other process-lifecycle code. Slower than a pure unit test (the guard's
// own poll interval is 10s) -- accepted, same tradeoff this repo already
// makes for src/lib/profile-ingestion/__tests__/extract.test.ts's real
// ~10s timeout tests.
const GUARD_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "parent-liveness-guard.cjs");

describe("parent-liveness-guard.cjs", () => {
  it("self-exits once its recorded GIGRADAR_PARENT_PID stops existing", async () => {
    // A real process standing in for "the Tauri/Electron parent" -- only
    // its PID matters, not what it does.
    const fakeParent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
    await new Promise((resolve) => fakeParent.once("spawn", resolve));

    const child = spawn(process.execPath, ["--require", GUARD_PATH, "-e", "setInterval(() => {}, 1_000)"], {
      env: { ...process.env, GIGRADAR_PARENT_PID: String(fakeParent.pid) },
    });

    fakeParent.kill();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not self-exit within 15s")), 15_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
  }, 20_000);

  it("is a complete no-op when GIGRADAR_PARENT_PID is unset -- the child stays alive", async () => {
    const { GIGRADAR_PARENT_PID: _omit, ...envWithoutParentPid } = process.env;
    const child = spawn(process.execPath, ["--require", GUARD_PATH, "-e", "setInterval(() => {}, 1_000)"], {
      env: envWithoutParentPid,
    });

    let exited = false;
    child.once("exit", () => {
      exited = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(exited).toBe(false);

    child.kill();
  }, 10_000);
});
