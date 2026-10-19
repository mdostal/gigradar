// Pantheon secrets facade client (pantheon-adapter story, PANT-1207).
//
// When gigradar runs inside Pantheon, its credentials come from Pantheon's
// generic secrets facade — `POST /api/secrets/inject` on core-api with a tag
// selector and `target: "file"` — the same way every other Pantheon service
// resolves a secret, never from a committed file, a baked env, or an agent's
// `custom_env`. The facade asks Portunus to write the value to a fresh file on
// the shared `pantheon-secrets` volume; we read it, then delete it. The value
// never crosses an HTTP response, and nothing here ever logs it or puts it in
// an error message — only tag selectors, file paths, and HTTP statuses.
//
// core-api is the ONLY service this module talks to. It knows nothing about
// Portunus, Multica, or any other Pantheon component beyond that one route.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Pantheon's own selector for its operator token (core/api/middleware/operator-token.ts in pantheon-v2). */
export const OPERATOR_TOKEN_TAGS = "provider=pantheon,kind=operator-token";

const DEFAULT_CORE_API_URL = "http://core-api:3012";
const DEFAULT_SHARED_SECRETS_DIR = "/pantheon-secrets";
/** core-api retries a Portunus inject once at 4s per attempt; this leaves room for both. */
const INJECT_TIMEOUT_MS = 10_000;

export interface PantheonSecretsDeps {
  /** Defaults to `PANTHEON_CORE_API_URL`, then the compose-network hostname `http://core-api:3012`. */
  coreApiUrl?: string;
  /** Defaults to `PANTHEON_SECRETS_SHARED_DIR`, then `/pantheon-secrets`. */
  sharedSecretsDir?: string;
  fetchImpl?: typeof fetch;
  readFile?: (filePath: string) => Promise<string>;
  deleteFile?: (filePath: string) => Promise<void>;
  generateId?: () => string;
  env?: NodeJS.ProcessEnv;
}

/** A secret the facade could not hand over. The message names the selector and what failed, never a value. */
export class PantheonSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PantheonSecretError";
  }
}

function coreApiUrl(deps: PantheonSecretsDeps): string {
  const env = deps.env ?? process.env;
  return (deps.coreApiUrl ?? env.PANTHEON_CORE_API_URL ?? DEFAULT_CORE_API_URL).replace(/\/+$/, "");
}

/** Reads `KEY=value` out of a `format: "env"` inject, tolerating `export`, quotes, and a trailing newline. */
export function parseEnvLine(contents: string, key: string): string | undefined {
  for (const line of contents.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== key) continue;
    return match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}

/**
 * Resolves one secret through the facade: inject it as `KEY=value` into a
 * fresh file on the shared volume, read it, delete it. Throws
 * {@link PantheonSecretError} on any failure — never returns an empty value
 * that could pass for "no credential".
 */
export async function injectSecret(tags: string, key: string, deps: PantheonSecretsDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, "utf8"));
  const deleteFile = deps.deleteFile ?? ((p: string) => fs.unlink(p));
  const dir = deps.sharedSecretsDir ?? env.PANTHEON_SECRETS_SHARED_DIR ?? DEFAULT_SHARED_SECRETS_DIR;
  const filePath = path.join(dir, `gigradar-${(deps.generateId ?? randomUUID)()}.env`);

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${coreApiUrl(deps)}/api/secrets/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags, target: "file", path: filePath, format: "env", key }),
        signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
      });
    } catch (e) {
      throw new PantheonSecretError(
        `pantheon secrets: inject for tags "${tags}" could not reach core-api: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!response.ok) {
      throw new PantheonSecretError(`pantheon secrets: inject for tags "${tags}" failed (HTTP ${response.status})`);
    }
    let contents: string;
    try {
      contents = await readFile(filePath);
    } catch (e) {
      throw new PantheonSecretError(
        `pantheon secrets: inject for tags "${tags}" reported success but ${filePath} is not readable (${(e as NodeJS.ErrnoException).code ?? "error"})`,
      );
    }
    const value = parseEnvLine(contents, key);
    if (!value) throw new PantheonSecretError(`pantheon secrets: inject for tags "${tags}" wrote no ${key}`);
    return value;
  } finally {
    await deleteFile(filePath).catch(() => {});
  }
}

export interface SecretMapping {
  /** The env-var name gigradar's config refers to (`"env:VAR"`), e.g. `ANTHROPIC_API_KEY`. */
  varName: string;
  /** The Portunus tag selector that resolves it, e.g. `provider=anthropic,kind=api-key`. */
  tags: string;
}

/**
 * Parses `GIGRADAR_PANTHEON_SECRETS`: `;`-separated `VAR=selector` entries,
 * split on the FIRST `=` (a selector itself contains `=` and `,`), e.g.
 * `ANTHROPIC_API_KEY=provider=anthropic,kind=api-key;BRAINTRUST_API_KEY=provider=braintrust`.
 * The mapping is configuration — names and selectors only, never a value.
 * Throws on a malformed entry rather than silently dropping it.
 */
export function parseSecretMappings(spec: string | undefined): SecretMapping[] {
  if (!spec?.trim()) return [];
  return spec
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      const varName = eq > 0 ? entry.slice(0, eq).trim() : "";
      const tags = eq > 0 ? entry.slice(eq + 1).trim() : "";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName) || !tags) {
        throw new PantheonSecretError(
          `pantheon secrets: GIGRADAR_PANTHEON_SECRETS entry "${entry}" is not VAR_NAME=tag-selector`,
        );
      }
      return { varName, tags };
    });
}

/**
 * Resolves every secret `GIGRADAR_PANTHEON_SECRETS` maps, fresh, for one run.
 * Not cached: a rotated secret is picked up by the very next run. Any single
 * failure fails the whole resolution — a run against a half-resolved
 * credential set would report a source's auth failure as "no matches".
 */
export async function resolveRunSecrets(deps: PantheonSecretsDeps = {}): Promise<Record<string, string>> {
  const mappings = parseSecretMappings((deps.env ?? process.env).GIGRADAR_PANTHEON_SECRETS);
  const resolved: Record<string, string> = {};
  for (const { varName, tags } of mappings) {
    resolved[varName] = await injectSecret(tags, varName, deps);
  }
  return resolved;
}

/**
 * Runs `fn` with `secrets` overlaid on `process.env`, then restores every
 * touched var to exactly what it was (including absent). This exists for
 * `loadConfig()`, which resolves `"env:VAR"` source settings from
 * `process.env` only; the overlay keeps an injected value from outliving the
 * one synchronous call that needs it. A facade value wins over one `.env`
 * already loaded — the facade is the source of truth inside Pantheon.
 */
export function withInjectedEnv<T>(secrets: Readonly<Record<string, string>>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(secrets)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
