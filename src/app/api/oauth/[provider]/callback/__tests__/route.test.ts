// Tests for gigradar's first app/api/ route: /api/oauth/[provider]/callback.
// oauth2.ts/session-backend.ts/config/save.ts are all mocked -- this suite
// exercises ONLY the route handler's own logic (provider lookup, param
// validation, the redirect-with-short-error-code convention, and that no
// raw error detail ever reaches the redirect URL).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exchangeCodeForTokensMock = vi.fn();
const storeTokenSetMock = vi.fn();
vi.mock("@/lib/auth/oauth2", () => ({
  exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokensMock(...args),
  storeTokenSet: (...args: unknown[]) => storeTokenSetMock(...args),
}));

const resolveOAuthClientCredentialsMock = vi.fn();
vi.mock("@/lib/auth/oauth-credentials", () => ({
  resolveOAuthClientCredentials: (...args: unknown[]) => resolveOAuthClientCredentialsMock(...args),
}));

const sessionBackendFromMock = vi.fn();
vi.mock("@/lib/auth/session-backend", () => ({
  sessionBackendFrom: (...args: unknown[]) => sessionBackendFromMock(...args),
}));

const readRawConfigMock = vi.fn();
vi.mock("@/lib/config/save", () => ({
  readRawConfig: (...args: unknown[]) => readRawConfigMock(...args),
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exchangeCodeForTokensMock.mockReset();
  storeTokenSetMock.mockReset();
  resolveOAuthClientCredentialsMock.mockReset();
  sessionBackendFromMock.mockReset().mockReturnValue("local");
  readRawConfigMock.mockReset().mockReturnValue({ sources: [{ id: "gmail-primary", enabled: true, kind: "gmail-digest", settings: {} }] });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

function makeRequest(pathAndQuery: string): NextRequest {
  return new NextRequest(new URL(pathAndQuery, "http://127.0.0.1:3000"));
}

describe("GET /api/oauth/[provider]/callback", () => {
  it("returns 404 for an unregistered provider, without calling exchangeCodeForTokens", async () => {
    const res = await GET(makeRequest("/api/oauth/notaprovider/callback?code=x&state=y"), {
      params: Promise.resolve({ provider: "notaprovider" }),
    });

    expect(res.status).toBe(404);
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
  });

  it("redirects to /config with a short error code when code/state are missing", async () => {
    const res = await GET(makeRequest("/api/oauth/gmail/callback"), { params: Promise.resolve({ provider: "gmail" }) });

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/config");
    expect(location).toContain("gmailError=missing-params");
    expect(exchangeCodeForTokensMock).not.toHaveBeenCalled();
  });

  it("on success: exchanges the code, stores the token set via the source's configured backend, and redirects with a connected flag", async () => {
    exchangeCodeForTokensMock.mockResolvedValue({
      sourceId: "gmail-primary",
      tokenSet: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3600_000, scope: "s" },
    });
    sessionBackendFromMock.mockReturnValue("portunus");

    const res = await GET(makeRequest("/api/oauth/gmail/callback?code=abc&state=xyz"), { params: Promise.resolve({ provider: "gmail" }) });

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("gmailConnected=1");
    expect(storeTokenSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gmail" }),
      "gmail-primary",
      expect.objectContaining({ accessToken: "at-1" }),
      "portunus",
    );
  });

  it("on an exchange failure: redirects with a short error code, never leaking the raw error message into the URL", async () => {
    exchangeCodeForTokensMock.mockRejectedValue(new Error("gigradar oauth2: unknown or expired authorization state for provider \"gmail\"."));

    const res = await GET(makeRequest("/api/oauth/gmail/callback?code=abc&state=xyz"), { params: Promise.resolve({ provider: "gmail" }) });

    const location = res.headers.get("location")!;
    expect(location).toContain("gmailError=exchange-failed");
    expect(location).not.toContain("unknown or expired");
    expect(storeTokenSetMock).not.toHaveBeenCalled();
  });

  it("falls back to the local backend when the sourceId isn't found in raw config", async () => {
    readRawConfigMock.mockReturnValue({ sources: [] });
    exchangeCodeForTokensMock.mockResolvedValue({
      sourceId: "gmail-primary",
      tokenSet: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3600_000, scope: "s" },
    });

    await GET(makeRequest("/api/oauth/gmail/callback?code=abc&state=xyz"), { params: Promise.resolve({ provider: "gmail" }) });

    expect(storeTokenSetMock).toHaveBeenCalledWith(expect.anything(), "gmail-primary", expect.anything(), "local");
    expect(sessionBackendFromMock).not.toHaveBeenCalled();
  });
});
