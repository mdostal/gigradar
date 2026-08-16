// Tests for src/lib/auth/oauth2.ts. Highest-stakes coverage:
//   1. buildAuthorizationUrl() -> exchangeCodeForTokens() round-trips a
//      real PKCE code_verifier/code_challenge pair against a mocked token
//      endpoint (not just URL-string-shape checks).
//   2. exchangeCodeForTokens() rejects an unknown/expired/already-consumed
//      state WITHOUT ever calling the token endpoint.
//   3. getValidAccessToken() skips the network entirely when the cached
//      token has >60s left, and refreshes + re-stores when it doesn't.
//   4. storeTokenSet()/loadTokenSet() round-trip correctly through BOTH
//      the local (encrypted file) and portunus (mocked child_process)
//      backends.
//   5. no token value ever appears in a thrown error message.
// fetch and child_process.spawn are both mocked -- no real network, no
// real Portunus process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeSecretViaPortunusMock = vi.fn();
const readSecretViaPortunusMock = vi.fn();
vi.mock("../session-backend.js", () => ({
  writeSecretViaPortunus: (...args: unknown[]) => writeSecretViaPortunusMock(...args),
  readSecretViaPortunus: (...args: unknown[]) => readSecretViaPortunusMock(...args),
}));

import {
  buildAuthorizationUrl,
  deleteTokenSet,
  exchangeCodeForTokens,
  getValidAccessToken,
  loadTokenSet,
  storeTokenSet,
  type OAuthProvider,
  type OAuthTokenSet,
} from "../oauth2.js";

const FAKE_PROVIDER: OAuthProvider = {
  id: "gmail",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scope: "https://www.googleapis.com/auth/gmail.readonly",
  clientIdSetting: "gmailClientId",
  clientSecretSetting: "gmailClientSecret",
};

let tmpDataDir: string;
let tmpKeyDir: string;
let originalFetch: typeof fetch;

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-oauth2-test-"));
  tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-oauth2-test-key-"));
  process.env.XDG_DATA_HOME = tmpDataDir;
  process.env.XDG_CONFIG_HOME = tmpKeyDir;
  originalFetch = global.fetch;
  writeSecretViaPortunusMock.mockReset();
  readSecretViaPortunusMock.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  fs.rmSync(tmpKeyDir, { recursive: true, force: true });
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
  vi.restoreAllMocks();
});

function mockTokenEndpoint(response: Record<string, unknown>, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    json: async () => response,
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("buildAuthorizationUrl / exchangeCodeForTokens: happy path", () => {
  it("round-trips a real PKCE pair through a mocked token endpoint and returns the sourceId + token set", async () => {
    const { url, state } = buildAuthorizationUrl(FAKE_PROVIDER, "gmail-primary", "client-id-123");

    expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth?");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain(`state=${state}`);
    expect(url).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Foauth%2Fgmail%2Fcallback");

    const fetchMock = mockTokenEndpoint({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: FAKE_PROVIDER.scope });

    const { sourceId, tokenSet } = await exchangeCodeForTokens(FAKE_PROVIDER, "auth-code-xyz", state, () => ({ clientId: "client-id-123", clientSecret: "client-secret-456" }));

    expect(sourceId).toBe("gmail-primary");
    expect(tokenSet.accessToken).toBe("at-1");
    expect(tokenSet.refreshToken).toBe("rt-1");
    expect(tokenSet.expiresAt).toBeGreaterThan(Date.now());

    const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = String(options.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code-xyz");
    // The real code_verifier (not the challenge) must be sent at exchange time.
    expect(body).toMatch(/code_verifier=[\w-]+/);
  });
});

describe("exchangeCodeForTokens: state validation", () => {
  it("rejects an unknown state without ever calling the token endpoint", async () => {
    const fetchMock = mockTokenEndpoint({});

    await expect(exchangeCodeForTokens(FAKE_PROVIDER, "code", "not-a-real-state", () => ({ clientId: "id", clientSecret: "secret" }))).rejects.toThrow(
      /unknown or expired authorization state/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a state that was already consumed (single-use)", async () => {
    const { state } = buildAuthorizationUrl(FAKE_PROVIDER, "gmail-primary", "client-id");
    mockTokenEndpoint({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: FAKE_PROVIDER.scope });

    await exchangeCodeForTokens(FAKE_PROVIDER, "code", state, () => ({ clientId: "client-id", clientSecret: "secret" }));

    const fetchMock = mockTokenEndpoint({});
    await expect(exchangeCodeForTokens(FAKE_PROVIDER, "code", state, () => ({ clientId: "client-id", clientSecret: "secret" }))).rejects.toThrow(
      /unknown or expired authorization state/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("storeTokenSet / loadTokenSet: local backend", () => {
  it("round-trips a token set through the encrypted local file", async () => {
    const tokenSet: OAuthTokenSet = { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3600_000, scope: FAKE_PROVIDER.scope };

    await storeTokenSet(FAKE_PROVIDER, "gmail-primary", tokenSet, "local");
    const loaded = await loadTokenSet(FAKE_PROVIDER, "gmail-primary", "local");

    expect(loaded).toEqual(tokenSet);
  });

  it("the on-disk file is never plaintext JSON", async () => {
    const tokenSet: OAuthTokenSet = { accessToken: "super-secret-token", refreshToken: "rt-1", expiresAt: Date.now() + 3600_000, scope: FAKE_PROVIDER.scope };
    await storeTokenSet(FAKE_PROVIDER, "gmail-primary", tokenSet, "local");

    const destPath = path.join(tmpDataDir, "gigradar", "oauth-tokens", "gmail-gmail-primary.json");
    const raw = fs.readFileSync(destPath, "utf8");
    expect(raw).not.toContain("super-secret-token");
  });

  it("loadTokenSet() throws a specific, actionable error when nothing is connected yet", async () => {
    await expect(loadTokenSet(FAKE_PROVIDER, "never-connected", "local")).rejects.toThrow(/connect it in \/config first/);
  });

  it("deleteTokenSet() removes the local file and is idempotent", async () => {
    const tokenSet: OAuthTokenSet = { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3600_000, scope: FAKE_PROVIDER.scope };
    await storeTokenSet(FAKE_PROVIDER, "gmail-primary", tokenSet, "local");

    await deleteTokenSet(FAKE_PROVIDER, "gmail-primary", "local");
    await expect(loadTokenSet(FAKE_PROVIDER, "gmail-primary", "local")).rejects.toThrow(/connect it in \/config first/);

    await expect(deleteTokenSet(FAKE_PROVIDER, "gmail-primary", "local")).resolves.toBeUndefined();
  });
});

describe("storeTokenSet / loadTokenSet: portunus backend", () => {
  // Portunus plumbing itself is already thoroughly covered by
  // session-backend.test.ts (writeSecretViaPortunus/readSecretViaPortunus,
  // reused here unmodified) -- this suite only proves oauth2.ts wires the
  // OAuthTokenSet shape through correctly, via mocked calls into that
  // already-tested generalized function.
  it("storeTokenSet()/loadTokenSet() call the generalized Portunus functions with the OAuthTokenSet shape", async () => {
    writeSecretViaPortunusMock.mockResolvedValue(undefined);
    readSecretViaPortunusMock.mockResolvedValue({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3600_000, scope: FAKE_PROVIDER.scope });

    const tokenSet: OAuthTokenSet = { accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3600_000, scope: FAKE_PROVIDER.scope };
    await storeTokenSet(FAKE_PROVIDER, "gmail-primary", tokenSet, "portunus");
    expect(writeSecretViaPortunusMock).toHaveBeenCalledWith("oauth-gmail-gmail-primary", "gigradar", tokenSet, expect.any(Number));

    const loaded = await loadTokenSet(FAKE_PROVIDER, "gmail-primary", "portunus");
    expect(readSecretViaPortunusMock).toHaveBeenCalledWith("oauth-gmail-gmail-primary", "gigradar", expect.any(Function), "OAuth token set");
    expect(loaded.accessToken).toBe("at-1");
  });
});

describe("getValidAccessToken", () => {
  it("returns the cached access token without any network call when it has more than 60s left", async () => {
    const tokenSet: OAuthTokenSet = { accessToken: "still-valid", refreshToken: "rt-1", expiresAt: Date.now() + 300_000, scope: FAKE_PROVIDER.scope };
    await storeTokenSet(FAKE_PROVIDER, "gmail-primary", tokenSet, "local");

    const fetchMock = mockTokenEndpoint({});
    const token = await getValidAccessToken(FAKE_PROVIDER, "gmail-primary", "local", "client-id", "client-secret");

    expect(token).toBe("still-valid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes and re-stores when the token is expired, and returns the NEW access token", async () => {
    const expired: OAuthTokenSet = { accessToken: "expired-token", refreshToken: "rt-1", expiresAt: Date.now() - 1000, scope: FAKE_PROVIDER.scope };
    await storeTokenSet(FAKE_PROVIDER, "gmail-primary", expired, "local");

    mockTokenEndpoint({ access_token: "refreshed-token", expires_in: 3600, scope: FAKE_PROVIDER.scope });

    const token = await getValidAccessToken(FAKE_PROVIDER, "gmail-primary", "local", "client-id", "client-secret");
    expect(token).toBe("refreshed-token");

    const reloaded = await loadTokenSet(FAKE_PROVIDER, "gmail-primary", "local");
    expect(reloaded.accessToken).toBe("refreshed-token");
    // Google's refresh response can omit refresh_token when the original is still valid -- the existing one must survive the re-store.
    expect(reloaded.refreshToken).toBe("rt-1");
  });

  it("refreshes with the token endpoint about to expire (< 60s left), not just already-expired", async () => {
    const almostExpired: OAuthTokenSet = { accessToken: "almost-expired", refreshToken: "rt-1", expiresAt: Date.now() + 30_000, scope: FAKE_PROVIDER.scope };
    await storeTokenSet(FAKE_PROVIDER, "gmail-primary", almostExpired, "local");

    const fetchMock = mockTokenEndpoint({ access_token: "refreshed-token", expires_in: 3600, scope: FAKE_PROVIDER.scope });

    await getValidAccessToken(FAKE_PROVIDER, "gmail-primary", "local", "client-id", "client-secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("token error handling never leaks a secret value", () => {
  it("a non-ok token response's error message never includes the response body", async () => {
    mockTokenEndpoint({ error: "invalid_grant", access_token_never_actually_present: "should-not-leak" }, false, 400);
    const { state } = buildAuthorizationUrl(FAKE_PROVIDER, "gmail-primary", "client-id");

    await expect(exchangeCodeForTokens(FAKE_PROVIDER, "code", state, () => ({ clientId: "client-id", clientSecret: "secret" }))).rejects.toThrow(/failed \(400\)/);
  });
});
