// email-digest-ingestion epic, oauth2-generic-mechanism story. A generic,
// PROVIDER-AGNOSTIC OAuth2 authorization-code-with-PKCE module — Gmail
// (oauth-providers/gmail.ts) is the first concrete OAuthProvider, not the
// only one this module is built to support. Per the owner's explicit
// direction ("we should be doing the oauth for a good deal of these
// logins"), this is the seam future OAuth-based sources plug into, not a
// Gmail-specific flow with generalization deferred.
//
// STORAGE: reuses session-backend.ts's generalized
// writeSecretViaPortunus()/readSecretViaPortunus() for the "portunus"
// backend (same owner-selectable dual-backend discipline as captured
// browser sessions), and a small local-file-encrypted-via-vault.ts path
// for "local" — mirroring (not importing — same small, per-module
// atomic-write-encrypted pattern env-store.ts/save.ts/session-capture.ts
// each already have their own copy of) the existing codebase convention.
//
// PENDING-AUTHORIZATION STATE: globalThis-pinned Map keyed by `state`,
// same HMR-survival idiom as every other session map this session
// established (session-capture.ts, assist-session.ts,
// verification-copilot-session.ts) — a Next.js dev HMR re-evaluation of
// this module must not orphan an in-flight authorization.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decrypt, encrypt, getOrCreateKey } from "../security/vault.js";
import { hasAnyEncryptedFile } from "../config/load.js";
import { getDefaultDataDir } from "../store/path.js";
import { readSecretViaPortunus, writeSecretViaPortunus, type SessionBackend } from "./session-backend.js";

const MODULE_PREFIX = "gigradar oauth2";

/** Fixed across all three runtime modes (browser dev, Electron, Tauri) — see electron/main.ts's SERVER_URL and src-tauri/src/lib.rs's SERVER_PORT, both 127.0.0.1:3000. */
const REDIRECT_BASE_URL = "http://127.0.0.1:3000";

/** How long a pending authorization (state -> code_verifier) is held before being treated as abandoned — generous, since it's bounded only by how long the user takes on Google's own consent screen. */
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export interface OAuthProvider {
  /** Stable id, e.g. "gmail" — also the `[provider]` route param and the Portunus/local storage key prefix. */
  id: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** Keys into a SourceConfig's settings — resolved via readRawConfig() + resolveEnvString(), same "env:VAR_NAME" convention as every other secret in this repo. */
  clientIdSetting: string;
  clientSecretSetting: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
}

export function isOAuthTokenSetShape(value: unknown): value is OAuthTokenSet {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.accessToken === "string" &&
    typeof v.refreshToken === "string" &&
    typeof v.expiresAt === "number" &&
    typeof v.scope === "string"
  );
}

interface PendingAuthorization {
  codeVerifier: string;
  sourceId: string;
  providerId: string;
  createdAt: number;
}

// globalThis-pinned — see this file's header comment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate untyped globalThis cast; see file header for why this exact idiom is required.
const pendingAuthorizations: Map<string, PendingAuthorization> = ((globalThis as any).__gigradarPendingOAuthAuthorizations ??=
  new Map<string, PendingAuthorization>());

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function redirectUriFor(provider: OAuthProvider): string {
  return `${REDIRECT_BASE_URL}/api/oauth/${provider.id}/callback`;
}

/**
 * Generates a PKCE code_verifier/code_challenge pair (S256), a CSRF `state`
 * token, holds `{codeVerifier, sourceId, providerId}` in the pending-
 * authorization map keyed by `state` (evicted after `PENDING_AUTH_TTL_MS`
 * or on first use — see `exchangeCodeForTokens()`), and builds the
 * provider's real authorization URL. `clientId` is resolved by the
 * CALLER (never module-scope) and passed in — same discipline every other
 * BYOK secret in this repo already follows.
 */
export function buildAuthorizationUrl(
  provider: OAuthProvider,
  sourceId: string,
  clientId: string,
): { url: string; state: string } {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(24));

  pendingAuthorizations.set(state, { codeVerifier, sourceId, providerId: provider.id, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUriFor(provider),
    response_type: "code",
    scope: provider.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });

  return { url: `${provider.authorizeUrl}?${params.toString()}`, state };
}

/**
 * Validates `state` against the pending-authorization map (throws a
 * specific error for an unknown/expired/already-consumed state, and NEVER
 * calls the token endpoint in that case), deletes the entry either way
 * (single-use — a `state` cannot be replayed), then exchanges `code` for a
 * real token set via a plain `fetch()` POST to `provider.tokenUrl`.
 *
 * `resolveCredentials(sourceId)` is called ONLY after `state` has been
 * validated and `sourceId` recovered from it — this is the one point in
 * the whole flow where the caller (the callback route) genuinely cannot
 * know `sourceId` up front (it only exists inside the pending-
 * authorization entry `state` unlocks), so credential resolution is
 * threaded through as a callback rather than a raw parameter. Still
 * resolved fresh per call, never module-scope — same discipline every
 * other BYOK secret in this repo follows.
 */
export async function exchangeCodeForTokens(
  provider: OAuthProvider,
  code: string,
  state: string,
  resolveCredentials: (sourceId: string) => { clientId: string; clientSecret: string },
): Promise<{ sourceId: string; tokenSet: OAuthTokenSet }> {
  const pending = pendingAuthorizations.get(state);
  pendingAuthorizations.delete(state);

  if (!pending || pending.providerId !== provider.id || Date.now() - pending.createdAt > PENDING_AUTH_TTL_MS) {
    throw new Error(`${MODULE_PREFIX}: unknown or expired authorization state for provider "${provider.id}".`);
  }

  const { clientId, clientSecret } = resolveCredentials(pending.sourceId);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUriFor(provider),
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: pending.codeVerifier,
  });

  const tokenSet = await postTokenRequest(provider, body);
  return { sourceId: pending.sourceId, tokenSet };
}

/**
 * Reads the stored token set for `provider`/`sourceId` (via whichever
 * `backend` is configured — same owner-selectable local/Portunus choice
 * as captured browser sessions) and returns a valid access token: as-is
 * if it has more than 60s left before `expiresAt`, otherwise refreshes via
 * a `grant_type=refresh_token` request and re-stores the refreshed set
 * before returning. Every Gmail (or future OAuth source) API call goes
 * through this — no caller reads a raw stored token directly.
 */
export async function getValidAccessToken(
  provider: OAuthProvider,
  sourceId: string,
  backend: SessionBackend,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const stored = await loadTokenSet(provider, sourceId, backend);

  if (stored.expiresAt - Date.now() > 60_000) {
    return stored.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const refreshed = await postTokenRequest(provider, body, stored.refreshToken);
  await storeTokenSet(provider, sourceId, refreshed, backend);
  return refreshed.accessToken;
}

/** Stores `tokenSet` for `provider`/`sourceId` via `backend` — local (encrypted file) or Portunus. */
export async function storeTokenSet(
  provider: OAuthProvider,
  sourceId: string,
  tokenSet: OAuthTokenSet,
  backend: SessionBackend,
): Promise<void> {
  if (backend === "portunus") {
    await writeSecretViaPortunus(portunusSite(provider, sourceId), PORTUNUS_OAUTH_ACCOUNT, tokenSet, PORTUNUS_OAUTH_TTL_SECONDS);
    return;
  }
  writeTokenLocally(provider, sourceId, tokenSet);
}

/** Reads the stored token set for `provider`/`sourceId` via `backend` — throws a specific "not connected" error if nothing is stored. */
export async function loadTokenSet(provider: OAuthProvider, sourceId: string, backend: SessionBackend): Promise<OAuthTokenSet> {
  if (backend === "portunus") {
    return readSecretViaPortunus(portunusSite(provider, sourceId), PORTUNUS_OAUTH_ACCOUNT, isOAuthTokenSetShape, "OAuth token set");
  }
  return readTokenLocally(provider, sourceId);
}

/** Deletes the stored token set for `provider`/`sourceId` via `backend` — idempotent, never throws for an already-disconnected source. */
export async function deleteTokenSet(provider: OAuthProvider, sourceId: string, backend: SessionBackend): Promise<void> {
  if (backend === "portunus") {
    // Portunus has no documented "delete" subcommand as of the version
    // this repo has live-verified (see session-backend.ts's header
    // comment) — overwriting with an already-expired token set is the
    // only reachable "disconnect" for this backend today. A real delete
    // path is a follow-up once Portunus exposes one.
    try {
      await writeSecretViaPortunus(
        portunusSite(provider, sourceId),
        PORTUNUS_OAUTH_ACCOUNT,
        { accessToken: "", refreshToken: "", expiresAt: 0, scope: "" } satisfies OAuthTokenSet,
        1,
      );
    } catch {
      // nothing stored, or portunus unavailable -- disconnect is a no-op either way.
    }
    return;
  }
  try {
    fs.unlinkSync(localTokenPath(provider, sourceId));
  } catch {
    // already gone -- nothing more to clean up.
  }
}

const PORTUNUS_OAUTH_ACCOUNT = "gigradar";
const PORTUNUS_OAUTH_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days, matches PORTUNUS_SESSION_TTL_SECONDS's own reasoning

function portunusSite(provider: OAuthProvider, sourceId: string): string {
  return `oauth-${provider.id}-${sourceId}`;
}

function localTokenPath(provider: OAuthProvider, sourceId: string): string {
  return path.join(getDefaultDataDir(), "oauth-tokens", `${provider.id}-${sourceId}.json`);
}

/** Same tmp-file + 0600 + rename-onto-dest + vault.ts encrypt() pattern env-store.ts's/save.ts's/session-capture.ts's own private atomic-write helpers already each have their own copy of — matching that established convention rather than introducing a new shared abstraction for a fourth caller. */
function writeTokenLocally(provider: OAuthProvider, sourceId: string, tokenSet: OAuthTokenSet): void {
  const destPath = localTokenPath(provider, sourceId);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  getOrCreateKey(hasAnyEncryptedFile);

  const tmpPath = path.join(path.dirname(destPath), `.${path.basename(destPath)}.tmp-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(tmpPath, encrypt(JSON.stringify(tokenSet)), { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, destPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmp file was never created -- nothing to clean up.
    }
    throw e;
  }
}

function readTokenLocally(provider: OAuthProvider, sourceId: string): OAuthTokenSet {
  const destPath = localTokenPath(provider, sourceId);
  let raw: string;
  try {
    raw = fs.readFileSync(destPath, "utf8");
  } catch {
    throw new Error(`${MODULE_PREFIX}: no ${provider.id} connection found for source "${sourceId}" — connect it in /config first.`);
  }

  const decrypted = decrypt(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch {
    throw new Error(`${MODULE_PREFIX}: stored ${provider.id} token set for source "${sourceId}" is not valid JSON.`);
  }

  if (!isOAuthTokenSetShape(parsed)) {
    throw new Error(`${MODULE_PREFIX}: stored ${provider.id} token set for source "${sourceId}" does not match the expected shape.`);
  }
  return parsed;
}

async function postTokenRequest(provider: OAuthProvider, body: URLSearchParams, refreshTokenIfUnchanged?: string): Promise<OAuthTokenSet> {
  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    // Deliberately never includes the response body -- it can echo back
    // request parameters (though never the client_secret/tokens
    // themselves, which are request-side only) and this repo's "never
    // include a secret in an error message" discipline treats token-
    // endpoint error bodies as untrusted-enough to keep out of thrown
    // errors entirely, not worth the parsing risk for a marginal debugging
    // benefit.
    throw new Error(`${MODULE_PREFIX}: token request to "${provider.tokenUrl}" failed (${res.status}).`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${MODULE_PREFIX}: token response from "${provider.tokenUrl}" was not valid JSON.`);
  }

  const obj = json as Record<string, unknown>;
  if (typeof obj.access_token !== "string" || typeof obj.expires_in !== "number") {
    throw new Error(`${MODULE_PREFIX}: token response from "${provider.tokenUrl}" is missing required fields.`);
  }

  return {
    accessToken: obj.access_token,
    // A refresh grant's response omits refresh_token when the original is
    // still valid (Google's documented behavior) -- carry the existing one
    // forward rather than losing it.
    refreshToken: typeof obj.refresh_token === "string" ? obj.refresh_token : (refreshTokenIfUnchanged ?? ""),
    expiresAt: Date.now() + obj.expires_in * 1000,
    scope: typeof obj.scope === "string" ? obj.scope : provider.scope,
  };
}
