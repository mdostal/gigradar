// Tests for getSessionScreenshotAction (embedded-profile-assist epic,
// embedded-view-readonly story), in ../actions.ts. Mocks
// @/lib/auth/assist-session so this exercises only the action's own
// try/catch/ActionResult wrapping -- never a real Playwright Page.
import { describe, expect, it, vi } from "vitest";

const getAssistSessionPageMock = vi.fn();
vi.mock("@/lib/auth/assist-session", () => ({
  endAssistSession: vi.fn(),
  getAssistSessionInfo: vi.fn(),
  getAssistSessionPage: (...args: unknown[]) => getAssistSessionPageMock(...args),
  startAssistSession: vi.fn(),
}));

import { clickSessionAtAction, getSessionScreenshotAction, typeIntoSessionAction } from "../actions";

describe("getSessionScreenshotAction", () => {
  it("returns a data: URL built from the page's JPEG screenshot", async () => {
    const screenshotMock = vi.fn().mockResolvedValue(Buffer.from("fake-jpeg-bytes"));
    getAssistSessionPageMock.mockReturnValue({ screenshot: screenshotMock });

    const result = await getSessionScreenshotAction("session-1");

    expect(getAssistSessionPageMock).toHaveBeenCalledWith("session-1");
    expect(screenshotMock).toHaveBeenCalledWith({ type: "jpeg", quality: 70 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from("fake-jpeg-bytes").toString("base64")}`);
    }
  });

  it("returns actionErr() (never throws) when there is no active session for the id", async () => {
    getAssistSessionPageMock.mockImplementation(() => {
      throw new Error('gigradar assist-session: session not found or expired (id "session-1").');
    });

    const result = await getSessionScreenshotAction("session-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/session not found or expired/);
    }
  });
});

// embedded-browser-and-guided-session epic, embedded-view-interactive story.
describe("clickSessionAtAction", () => {
  function fakePage(overrides: Record<string, unknown> = {}) {
    return {
      viewportSize: vi.fn().mockReturnValue({ width: 1200, height: 800 }),
      mouse: { click: vi.fn().mockResolvedValue(undefined) },
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-jpeg-bytes")),
      ...overrides,
    };
  }

  it("translates the ratio-based coordinates to real page pixels via viewportSize() before calling page.mouse.click(), then returns a fresh screenshot", async () => {
    const page = fakePage();
    getAssistSessionPageMock.mockReturnValue(page);

    const result = await clickSessionAtAction("session-1", 0.5, 0.25);

    expect(page.mouse.click).toHaveBeenCalledWith(600, 200); // 0.5 * 1200, 0.25 * 800
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from("fake-jpeg-bytes").toString("base64")}`);
    }
  });

  it("a non-1:1 display-vs-viewport ratio is still translated correctly (not just the trivial 1:1 case)", async () => {
    const page = fakePage({ viewportSize: vi.fn().mockReturnValue({ width: 1600, height: 900 }) });
    getAssistSessionPageMock.mockReturnValue(page);

    await clickSessionAtAction("session-1", 0.1, 0.9);

    expect(page.mouse.click).toHaveBeenCalledWith(160, 810); // 0.1 * 1600, 0.9 * 900
  });

  it("returns actionErr() when the page has no viewport size to translate against", async () => {
    const page = fakePage({ viewportSize: vi.fn().mockReturnValue(null) });
    getAssistSessionPageMock.mockReturnValue(page);

    const result = await clickSessionAtAction("session-1", 0.5, 0.5);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no viewport size/);
    }
    expect(page.mouse.click).not.toHaveBeenCalled();
  });

  it("returns actionErr() (never throws) when there is no active session for the id", async () => {
    getAssistSessionPageMock.mockImplementation(() => {
      throw new Error('gigradar assist-session: session not found or expired (id "session-1").');
    });

    const result = await clickSessionAtAction("session-1", 0.5, 0.5);

    expect(result.ok).toBe(false);
  });
});

describe("typeIntoSessionAction", () => {
  it("wraps page.keyboard.type(text) and returns a fresh screenshot", async () => {
    const page = {
      keyboard: { type: vi.fn().mockResolvedValue(undefined) },
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-jpeg-bytes")),
    };
    getAssistSessionPageMock.mockReturnValue(page);

    const result = await typeIntoSessionAction("session-1", "hello world");

    expect(page.keyboard.type).toHaveBeenCalledWith("hello world");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from("fake-jpeg-bytes").toString("base64")}`);
    }
  });

  it("returns actionErr() (never throws) when there is no active session for the id", async () => {
    getAssistSessionPageMock.mockImplementation(() => {
      throw new Error('gigradar assist-session: session not found or expired (id "session-1").');
    });

    const result = await typeIntoSessionAction("session-1", "hello");

    expect(result.ok).toBe(false);
  });
});
