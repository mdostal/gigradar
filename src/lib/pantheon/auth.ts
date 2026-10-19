// Inbound auth for the Pantheon adapter (pantheon-adapter story, PANT-1207).
//
// Every /api/pantheon/* request must carry Pantheon's operator token in
// `x-pantheon-operator-token` — the same header core-api itself checks on
// writes. The expected value is resolved through the secrets facade
// (secrets.ts), never configured as a literal. Fail closed: if the token
// can't be resolved at all, every request is refused (503) rather than let
// through unauthenticated — this surface can trigger scans and stage drafts.
import { createHash, timingSafeEqual } from "node:crypto";
import { OPERATOR_TOKEN_TAGS, injectSecret, type PantheonSecretsDeps } from "./secrets.js";

export const OPERATOR_TOKEN_HEADER = "x-pantheon-operator-token";
const TOKEN_KEY = "PANTHEON_OPERATOR_TOKEN";
/** Re-resolve at most once a minute, so a rotation lands without an inject per request. */
const REFRESH_INTERVAL_MS = 60_000;

interface TokenCache {
  token?: string;
  at: number;
}

// globalThis-pinned for the same reason as session-capture.ts's captures
// map: a Next dev HMR re-evaluation must not drop a token that works.
const g = globalThis as typeof globalThis & { __gigradarPantheonToken?: TokenCache };

export interface AuthDeps extends PantheonSecretsDeps {
  now?: () => number;
  logger?: { warn(message: string): void };
}

/** Test-only: forget the cached token. */
export function resetOperatorTokenCache(): void {
  delete g.__gigradarPantheonToken;
}

/**
 * The current operator token, or `undefined` if it has never resolved. A
 * refresh that fails keeps the last token that worked, so a brief core-api
 * outage does not lock out a caller that was already authenticated.
 */
export async function getOperatorToken(deps: AuthDeps = {}): Promise<string | undefined> {
  const now = (deps.now ?? Date.now)();
  const cached = g.__gigradarPantheonToken;
  if (cached && now - cached.at < REFRESH_INTERVAL_MS) return cached.token;
  let token: string | undefined;
  try {
    token = await injectSecret(OPERATOR_TOKEN_TAGS, TOKEN_KEY, deps);
  } catch (e) {
    (deps.logger ?? console).warn(`gigradar pantheon adapter: ${e instanceof Error ? e.message : String(e)}`);
  }
  g.__gigradarPantheonToken = { token: token ?? cached?.token, at: now };
  return g.__gigradarPantheonToken.token;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 503; error: string };

/** Checks one request's header value against the resolved token, in constant time. */
export async function authorize(presented: string | null | undefined, deps: AuthDeps = {}): Promise<AuthResult> {
  const expected = await getOperatorToken(deps);
  if (!expected) {
    return { ok: false, status: 503, error: "pantheon adapter: operator token unavailable from the secrets facade" };
  }
  if (!presented || !timingSafeEqual(digest(presented), digest(expected))) {
    return { ok: false, status: 401, error: `pantheon adapter: missing or invalid ${OPERATOR_TOKEN_HEADER}` };
  }
  return { ok: true };
}
