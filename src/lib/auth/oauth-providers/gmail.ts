// email-digest-ingestion epic, gmail-oauth-provider-callback story. The
// first concrete OAuthProvider registered against oauth2.ts's generic
// mechanism — not the only one this repo is built to support, see
// oauth2.ts's own header comment.
import type { OAuthProvider } from "../oauth2.js";

/**
 * Read-only, least-privilege scope — gigradar can never send, delete, or
 * modify anything in a connected Gmail inbox. Stated explicitly here (not
 * just in docs) so it's impossible to widen by accident without touching
 * the one place that matters.
 */
export const GMAIL_PROVIDER: OAuthProvider = {
  id: "gmail",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scope: "https://www.googleapis.com/auth/gmail.readonly",
  clientIdSetting: "gmailClientId",
  clientSecretSetting: "gmailClientSecret",
};

/** Every registered OAuthProvider, keyed by id — the [provider] route param looks itself up here; an unknown id is a 404, not a crash. */
export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  gmail: GMAIL_PROVIDER,
};
