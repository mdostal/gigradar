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
vi.mock("@/lib/auth/oauth2", () => ({
  buildAuthorizationUrl: (...args: unknown[]) => buildAuthorizationUrlMock(...args),
  deleteTokenSet: (...args: unknown[]) => deleteTokenSetMock(...args),
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
import { disconnectGmailAction, startGmailOAuthAction } from "../actions";

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
