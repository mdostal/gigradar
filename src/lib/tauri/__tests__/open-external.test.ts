// tauri-shell-open-external-links story. Covers openExternalUrl()'s mode
// branch: inside the packaged Tauri app it must go through
// @tauri-apps/plugin-shell's open() (the only path that actually shells
// out from a Tauri webview -- a bare `<a target="_blank">` does not), and
// in browser/Electron mode (isTauri() false) it must fall back to
// window.open(), which already works there.
//
// This suite runs under vitest's default node environment (no jsdom in
// this repo's devDependencies -- see vitest.config.ts), so `window` is
// stubbed via vi.stubGlobal() rather than assumed to already exist.
import { beforeEach, describe, expect, it, vi } from "vitest";

const isTauriMock = vi.fn();
vi.mock("@/lib/is-tauri", () => ({ isTauri: () => isTauriMock() }));

const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-shell", () => ({ open: openMock }));

const { openExternalUrl } = await import("../open-external.js");

describe("openExternalUrl", () => {
  const windowOpenMock = vi.fn();

  beforeEach(() => {
    isTauriMock.mockReset();
    openMock.mockReset();
    windowOpenMock.mockReset();
    vi.stubGlobal("window", { open: windowOpenMock });
  });

  it("inside the packaged Tauri app: calls @tauri-apps/plugin-shell's open() with the url, never window.open()", async () => {
    isTauriMock.mockReturnValue(true);
    await openExternalUrl("https://example.com/job/123");
    expect(openMock).toHaveBeenCalledWith("https://example.com/job/123");
    expect(windowOpenMock).not.toHaveBeenCalled();
  });

  it("in browser/Electron mode: falls back to window.open(), never the Tauri plugin", async () => {
    isTauriMock.mockReturnValue(false);
    await openExternalUrl("https://example.com/job/123");
    expect(windowOpenMock).toHaveBeenCalledWith("https://example.com/job/123", "_blank", "noopener,noreferrer");
    expect(openMock).not.toHaveBeenCalled();
  });
});
