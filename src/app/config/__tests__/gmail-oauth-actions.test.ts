// Tests for the two Gmail OAuth Server Actions added by the
// gmail-connect-ui story (`startGmailOAuthAction`/`disconnectGmailAction`,
// both in `../actions.ts`). oauth2.ts/oauth-credentials.ts/session-backend.ts
// are all mocked -- this suite exercises ONLY these actions' own logic
// (credential resolution, backend selection, the {ok,error} +
// revalidatePath convention), never real Playwright/OAuth network calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const buildAuthorizationUrlMock = vi.fn();
const deleteTokenSetMock = vi.fn();
const loadTokenSetMock = vi.fn();
const storeTokenSetMock = vi.fn();
vi.mock("@/lib/auth/oauth2", () => ({
  buildAuthorizationUrl: (...args: unknown[]) => buildAuthorizationUrlMock(...args),
  deleteTokenSet: (...args: unknown[]) => deleteTokenSetMock(...args),
  loadTokenSet: (...args: unknown[]) => loadTokenSetMock(...args),
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

import { revalidatePath } from "next/cache";
import { getConfigPath } from "@/lib/config/load";
import { assignGmailConnectionAction, disconnectGmailAction, listConnectedGmailSourcesAction, startGmailOAuthAction } from "../actions";

let tmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-gmail-oauth-action-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-gmail-oauth-action-test-key-"));
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = tmpDir;
  process.env.XDG_CONFIG_HOME = keyTmpDir;
  vi.mocked(revalidatePath).mockClear();
  buildAuthorizationUrlMock.mockReset();
  deleteTokenSetMock.mockReset();
  loadTokenSetMock.mockReset();
  storeTokenSetMock.mockReset();
  resolveOAuthClientCredentialsMock.mockReset();
  sessionBackendFromMock.mockReset().mockReturnValue("local");
});

afterEach(() => {
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(keyTmpDir, { recursive: true, force: true });
});

function writeConfig(doc: unknown): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(doc, null, 2));
}

describe("startGmailOAuthAction", () => {
  it("resolves the client id and returns a real authorization URL", async () => {
    resolveOAuthClientCredentialsMock.mockReturnValue({ clientId: "client-id-123", clientSecret: "client-secret-456" });
    buildAuthorizationUrlMock.mockReturnValue({ url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-id-123", state: "s1" });

    const result = await startGmailOAuthAction("gmail-primary");

    expect(result).toEqual({ ok: true, data: { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-id-123" } });
    expect(resolveOAuthClientCredentialsMock).toHaveBeenCalledWith("gmail-primary", expect.objectContaining({ id: "gmail" }));
    expect(buildAuthorizationUrlMock).toHaveBeenCalledWith(expect.objectContaining({ id: "gmail" }), "gmail-primary", "client-id-123");
  });

  it("propagates resolveOAuthClientCredentials()'s own \"not configured yet\" error verbatim", async () => {
    resolveOAuthClientCredentialsMock.mockImplementation(() => {
      throw new Error('gigradar oauth: source "gmail-primary" has no gmail OAuth client id/secret configured yet -- see docs/gmail-oauth-setup.md.');
    });

    const result = await startGmailOAuthAction("gmail-primary");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/docs\/gmail-oauth-setup\.md/);
    expect(buildAuthorizationUrlMock).not.toHaveBeenCalled();
  });
});

describe("disconnectGmailAction", () => {
  it("deletes the token set via the source's configured backend and revalidates /config", async () => {
    writeConfig({
      profile: {},
      needs: {},
      sources: [{ id: "gmail-primary", enabled: true, kind: "gmail-digest", settings: { sessionBackend: "portunus" } }],
    });
    sessionBackendFromMock.mockReturnValue("portunus");
    deleteTokenSetMock.mockResolvedValue(undefined);

    const result = await disconnectGmailAction("gmail-primary");

    expect(result).toEqual({ ok: true, data: null });
    expect(deleteTokenSetMock).toHaveBeenCalledWith(expect.objectContaining({ id: "gmail" }), "gmail-primary", "portunus");
    expect(revalidatePath).toHaveBeenCalledWith("/config");
  });

  it("defaults to the local backend when the source isn't found in raw config", async () => {
    writeConfig({ profile: {}, needs: {}, sources: [] });
    deleteTokenSetMock.mockResolvedValue(undefined);

    const result = await disconnectGmailAction("never-configured");

    expect(result).toEqual({ ok: true, data: null });
    expect(deleteTokenSetMock).toHaveBeenCalledWith(expect.objectContaining({ id: "gmail" }), "never-configured", "local");
  });

  it("returns {ok:false} without revalidating when deleteTokenSet() itself throws", async () => {
    writeConfig({ profile: {}, needs: {}, sources: [{ id: "gmail-primary", enabled: true, kind: "gmail-digest", settings: {} }] });
    deleteTokenSetMock.mockRejectedValue(new Error("portunus unavailable"));

    const result = await disconnectGmailAction("gmail-primary");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/portunus unavailable/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// product-review-followups epic, gmail-oauth-reuse-via-portunus story.
describe("listConnectedGmailSourcesAction", () => {
  it("lists only gmail-digest sources whose loadTokenSet() actually succeeds, excluding the caller's own source id", async () => {
    writeConfig({
      profile: {},
      needs: {},
      sources: [
        { id: "gmail-primary", enabled: true, kind: "gmail-digest", settings: {} },
        { id: "gmail-secondary", enabled: true, kind: "gmail-digest", settings: {} },
        { id: "gmail-broken", enabled: true, kind: "gmail-digest", settings: {} },
        { id: "braintrust", enabled: true, settings: {} },
      ],
    });
    loadTokenSetMock.mockImplementation(async (_provider: unknown, sourceId: string) => {
      if (sourceId === "gmail-broken") throw new Error("not connected");
      return { accessToken: "a", refreshToken: "r", expiresAt: 0, scope: "s" };
    });

    const result = await listConnectedGmailSourcesAction("gmail-secondary");

    expect(result).toEqual({ ok: true, data: [{ sourceId: "gmail-primary" }] });
  });

  it("returns an empty list (not an error) when no other gmail-digest source is connected", async () => {
    writeConfig({ profile: {}, needs: {}, sources: [{ id: "gmail-primary", enabled: true, kind: "gmail-digest", settings: {} }] });
    loadTokenSetMock.mockRejectedValue(new Error("not connected"));

    const result = await listConnectedGmailSourcesAction("gmail-primary");

    expect(result).toEqual({ ok: true, data: [] });
  });
});

describe("assignGmailConnectionAction", () => {
  it("copies the FROM source's token set onto the TO source's own configured backend", async () => {
    writeConfig({
      profile: {},
      needs: {},
      sources: [
        { id: "gmail-primary", enabled: true, kind: "gmail-digest", settings: { sessionBackend: "portunus" } },
        { id: "gmail-secondary", enabled: true, kind: "gmail-digest", settings: {} },
      ],
    });
    const tokenSet = { accessToken: "a", refreshToken: "r", expiresAt: 123, scope: "s" };
    loadTokenSetMock.mockResolvedValue(tokenSet);
    sessionBackendFromMock.mockImplementation((sc: { settings?: { sessionBackend?: string } }) => sc.settings?.sessionBackend ?? "local");

    const result = await assignGmailConnectionAction("gmail-primary", "gmail-secondary");

    expect(result).toEqual({ ok: true, data: null });
    expect(loadTokenSetMock).toHaveBeenCalledWith(expect.objectContaining({ id: "gmail" }), "gmail-primary", "portunus");
    expect(storeTokenSetMock).toHaveBeenCalledWith(expect.objectContaining({ id: "gmail" }), "gmail-secondary", tokenSet, "local");
    expect(revalidatePath).toHaveBeenCalledWith("/config");
  });

  it("returns {ok:false} without writing anything when the FROM source has no valid token to copy", async () => {
    writeConfig({
      profile: {},
      needs: {},
      sources: [
        { id: "gmail-primary", enabled: true, kind: "gmail-digest", settings: {} },
        { id: "gmail-secondary", enabled: true, kind: "gmail-digest", settings: {} },
      ],
    });
    loadTokenSetMock.mockRejectedValue(new Error("gigradar oauth2: no gmail connection found for source \"gmail-primary\""));

    const result = await assignGmailConnectionAction("gmail-primary", "gmail-secondary");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/no gmail connection found/);
    expect(storeTokenSetMock).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
