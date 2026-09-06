// true-embedded-browser epic, embedded-capture-login-flow story. Tests for
// src/lib/auth/embedded-capture.ts's normalizeEmbeddedStorageState() (the
// real sameSite adapter this story's own grill-time correction added --
// see that module's header comment for why "no adapter layer needed" was
// wrong) and finishEmbeddedCapture()'s thin delegation to
// session-capture.ts's persistCapturedSession() (mocked here -- its own
// behavior is already covered by session-capture.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

const persistCapturedSessionMock = vi.fn();

vi.mock("../session-capture.js", () => ({
  persistCapturedSession: persistCapturedSessionMock,
}));

const { normalizeEmbeddedStorageState, finishEmbeddedCapture } = await import("../embedded-capture.js");

function rawCookie(overrides: Partial<{ name: string; sameSite: string }> = {}) {
  return {
    name: "session",
    value: "real-secret-value",
    domain: "example.com",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    ...overrides,
  };
}

describe("normalizeEmbeddedStorageState", () => {
  it("passes through valid Strict/Lax/None sameSite values unchanged", () => {
    const raw = {
      cookies: [rawCookie({ sameSite: "Strict" }), rawCookie({ name: "b", sameSite: "Lax" }), rawCookie({ name: "c", sameSite: "None" })],
      origins: [],
    };
    const result = normalizeEmbeddedStorageState(raw);
    expect(result.cookies.map((c) => c.sameSite)).toEqual(["Strict", "Lax", "None"]);
  });

  it("throws a specific, actionable error naming the cookie and the offending value -- never guesses a default", () => {
    const raw = { cookies: [rawCookie({ name: "weird_cookie", sameSite: "Unspecified" })], origins: [] };
    expect(() => normalizeEmbeddedStorageState(raw)).toThrow(/weird_cookie.*Unspecified/s);
  });

  it("preserves origins/localStorage untouched", () => {
    const raw = { cookies: [], origins: [{ origin: "https://example.com", localStorage: [{ name: "k", value: "v" }] }] };
    const result = normalizeEmbeddedStorageState(raw);
    expect(result.origins).toEqual(raw.origins);
  });

  it("empty cookies list normalizes to an empty array, never throws", () => {
    const result = normalizeEmbeddedStorageState({ cookies: [], origins: [] });
    expect(result.cookies).toEqual([]);
  });
});

describe("finishEmbeddedCapture", () => {
  beforeEach(() => {
    persistCapturedSessionMock.mockReset();
  });

  it("normalizes the raw session THEN delegates to persistCapturedSession() with the real sourceId/backend/allowedOrigins", async () => {
    persistCapturedSessionMock.mockResolvedValueOnce({ backend: "local", path: "/fake/path-session.json" });
    const raw = { cookies: [rawCookie()], origins: [] };

    const result = await finishEmbeddedCapture("gofractional", raw, "local", ["https://gofractional.com"]);

    expect(persistCapturedSessionMock).toHaveBeenCalledTimes(1);
    const [sourceId, normalized, backend, allowedOrigins] = persistCapturedSessionMock.mock.calls[0]!;
    expect(sourceId).toBe("gofractional");
    expect(normalized.cookies[0].sameSite).toBe("Lax");
    expect(backend).toBe("local");
    expect(allowedOrigins).toEqual(["https://gofractional.com"]);
    expect(result).toEqual({ backend: "local", path: "/fake/path-session.json" });
  });

  it("propagates normalization failures BEFORE ever calling persistCapturedSession() -- a malformed sameSite never reaches disk/Portunus", async () => {
    const raw = { cookies: [rawCookie({ sameSite: "bogus" })], origins: [] };
    await expect(finishEmbeddedCapture("gofractional", raw, "local")).rejects.toThrow(/bogus/);
    expect(persistCapturedSessionMock).not.toHaveBeenCalled();
  });
});
