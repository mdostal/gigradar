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

import { getSessionScreenshotAction } from "../actions";

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
