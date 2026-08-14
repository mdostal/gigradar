import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted by vitest).
const { sendDesktopNotification } = await import("../desktop.js");

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function mockExecFileSucceeds(): void {
  execFileMock.mockImplementation((..._args: unknown[]) => {
    const cb = _args[_args.length - 1] as (err: Error | null) => void;
    cb(null);
  });
}

function mockExecFileFails(message: string): void {
  execFileMock.mockImplementation((..._args: unknown[]) => {
    const cb = _args[_args.length - 1] as (err: Error | null) => void;
    cb(new Error(message));
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setPlatform(originalPlatform);
  vi.restoreAllMocks();
});

describe("sendDesktopNotification: macOS (osascript)", () => {
  beforeEach(() => setPlatform("darwin"));

  it("calls osascript with a display notification AppleScript command via execFile (never a shell string)", async () => {
    mockExecFileSucceeds();

    await sendDesktopNotification({ title: "gigradar", body: "2 new green matches" });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("osascript");
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain('display notification "2 new green matches" with title "gigradar"');
  });

  it("escapes embedded double-quotes and backslashes in untrusted (scraped) content", async () => {
    mockExecFileSucceeds();

    await sendDesktopNotification({ title: 'Say "hi"', body: 'Path: C:\\Users\\x' });

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args[1]).toContain('Say \\"hi\\"');
    expect(args[1]).toContain("Path: C:\\\\Users\\\\x");
  });

  it("never throws when execFile reports a failure — logs a warning and resolves", async () => {
    mockExecFileFails("osascript: command not found");

    await expect(sendDesktopNotification({ title: "t", body: "b" })).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("osascript notification failed"));
  });
});

describe("sendDesktopNotification: Linux (notify-send)", () => {
  beforeEach(() => setPlatform("linux"));

  it("calls notify-send with title/body as separate argv entries, not an interpolated string", async () => {
    mockExecFileSucceeds();

    await sendDesktopNotification({ title: "gigradar", body: "1 new green match" });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("notify-send");
    expect(args).toEqual(["gigradar", "1 new green match"]);
  });

  it("never throws when notify-send is missing — logs a warning and resolves", async () => {
    mockExecFileFails("spawn notify-send ENOENT");

    await expect(sendDesktopNotification({ title: "t", body: "b" })).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("notify-send notification failed"));
  });
});

describe("sendDesktopNotification: unsupported platform", () => {
  it("logs a warning and resolves without ever calling execFile", async () => {
    setPlatform("win32");

    await expect(sendDesktopNotification({ title: "t", body: "b" })).resolves.toBeUndefined();

    expect(execFileMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('platform "win32"'));
  });
});

describe("sendDesktopNotification: field sanitization", () => {
  beforeEach(() => setPlatform("darwin"));

  it("collapses embedded newlines/whitespace to single spaces", async () => {
    mockExecFileSucceeds();

    await sendDesktopNotification({ title: "gigradar", body: "line one\nline two\n\nline three" });

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args[1]).toContain("line one line two line three");
  });

  it("truncates a very long field rather than sending it unbounded to a native notification API", async () => {
    mockExecFileSucceeds();
    const longBody = "x".repeat(500);

    await sendDesktopNotification({ title: "gigradar", body: longBody });

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    const script = args[1];
    expect(script).not.toContain("x".repeat(500));
    expect(script).toContain("…");
  });
});
