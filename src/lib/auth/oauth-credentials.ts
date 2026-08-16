// email-digest-ingestion epic. Resolves an OAuthProvider's client
// id/secret for a specific sourceId in the INTERACTIVE execution context
// (Server Actions, the /api/oauth/[provider]/callback route handler) --
// via readEnvVar() (never process.env, never module-scope), same
// discipline as every other Server-Action-reached secret in this repo
// (see env-store.ts's own doc comment on why Server Actions never trigger
// .env-into-process.env loading). The scheduler/CLI path does NOT use
// this module -- loadConfig()'s existing resolveSourceEnvReferences()
// already resolves a SourceConfig's top-level settings "env:" references
// generically before gmail-digest-source.ts's fetch() ever sees them, the
// same way gofractional.ts/ateam.ts already just read
// cfg.settings.sessionStatePath as an already-resolved value.
import { readEnvVar } from "../config/env-store.js";
import { readRawConfig } from "../config/save.js";
import type { OAuthProvider } from "./oauth2.js";

const ENV_REF_PREFIX = "env:";

/** Same "env: is a no-op passthrough for a literal value" behavior as load.ts's own resolveEnvString(), just Server-Action-safe (readEnvVar(), never process.env). */
function resolveSettingValue(raw: string, context: string): string {
  if (!raw.startsWith(ENV_REF_PREFIX)) return raw;

  const varName = raw.slice(ENV_REF_PREFIX.length);
  const value = readEnvVar(varName);
  if (value === undefined) {
    throw new Error(`gigradar oauth: ${context} references env var "${varName}", but it is not set. Set it in /config's Anthropic key section's sibling .env, or your shell environment.`);
  }
  return value;
}

/**
 * Reads `sourceId`'s RAW SourceConfig from config.json (via
 * readRawConfig(), never loadConfig()) and resolves `provider`'s
 * clientIdSetting/clientSecretSetting keys. Throws a specific,
 * actionable error naming the exact missing setting (pointing at
 * docs/gmail-oauth-setup.md) when either is absent or not a string --
 * this is the "you haven't set this OAuth app up yet" error surfaced to
 * the user, not a generic crash.
 */
export function resolveOAuthClientCredentials(sourceId: string, provider: OAuthProvider): { clientId: string; clientSecret: string } {
  const raw = readRawConfig();
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  const entry = sources.find(
    (s): s is Record<string, unknown> => typeof s === "object" && s !== null && (s as Record<string, unknown>).id === sourceId,
  );
  const settings = entry && typeof entry.settings === "object" && entry.settings !== null ? (entry.settings as Record<string, unknown>) : undefined;

  const clientIdRaw = settings?.[provider.clientIdSetting];
  const clientSecretRaw = settings?.[provider.clientSecretSetting];
  if (typeof clientIdRaw !== "string" || typeof clientSecretRaw !== "string") {
    throw new Error(
      `gigradar oauth: source "${sourceId}" has no ${provider.id} OAuth client id/secret configured yet -- see docs/gmail-oauth-setup.md.`,
    );
  }

  return {
    clientId: resolveSettingValue(clientIdRaw, `source "${sourceId}" settings.${provider.clientIdSetting}`),
    clientSecret: resolveSettingValue(clientSecretRaw, `source "${sourceId}" settings.${provider.clientSecretSetting}`),
  };
}
