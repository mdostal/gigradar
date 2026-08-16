// email-digest-ingestion epic, gmail-oauth-provider-callback story.
// gigradar's FIRST app/api/ route — every other server-side entry point
// so far is a Server Action, but Google's OAuth consent screen redirects
// the user's browser via a real top-level GET navigation carrying
// ?code=...&state=..., which only a real HTTP route handler can receive
// (a Server Action cannot be the target of a browser redirect). This is a
// narrow, motivated exception, not a broader shift away from Server
// Actions -- see .pHive/epics/email-digest-ingestion/docs/
// design-discussion.md §2.
import { NextResponse, type NextRequest } from "next/server";
import { exchangeCodeForTokens, storeTokenSet } from "@/lib/auth/oauth2";
import { resolveOAuthClientCredentials } from "@/lib/auth/oauth-credentials";
import { sessionBackendFrom } from "@/lib/auth/session-backend";
import { OAUTH_PROVIDERS } from "@/lib/auth/oauth-providers/gmail";
import { readRawConfig } from "@/lib/config/save";
import type { SourceConfig } from "@/lib/types";

function rawSourceConfig(sourceId: string): SourceConfig | undefined {
  const raw = readRawConfig();
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  return sources.find(
    (s): s is SourceConfig => typeof s === "object" && s !== null && (s as Record<string, unknown>).id === sourceId,
  );
}

/**
 * GET /api/oauth/[provider]/callback?code=...&state=...
 *
 * An unknown `provider` route param is a 404 -- only ids present in
 * OAUTH_PROVIDERS are real. A missing/invalid state, or any failure
 * during the exchange, redirects back to /config with a short error code
 * in the query string -- the RAW error message never leaves the server
 * (logged only), matching this repo's "never leak error detail that
 * could echo a secret" discipline.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }): Promise<NextResponse> {
  const { provider: providerId } = await params;
  const provider = OAUTH_PROVIDERS[providerId];
  if (!provider) {
    return new NextResponse("Unknown OAuth provider", { status: 404 });
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const configUrl = new URL("/config", request.nextUrl.origin);

  if (!code || !state) {
    configUrl.searchParams.set(`${provider.id}Error`, "missing-params");
    return NextResponse.redirect(configUrl);
  }

  try {
    const { sourceId, tokenSet } = await exchangeCodeForTokens(provider, code, state, (recoveredSourceId) =>
      resolveOAuthClientCredentials(recoveredSourceId, provider),
    );

    const sc = rawSourceConfig(sourceId);
    const backend = sc ? sessionBackendFrom(sc) : "local";
    await storeTokenSet(provider, sourceId, tokenSet, backend);

    // The sourceId itself (not just "1") -- so the UI can flip connected
    // state on the exact row that requested it, not just show a generic
    // page-level banner.
    configUrl.searchParams.set(`${provider.id}Connected`, sourceId);
    return NextResponse.redirect(configUrl);
  } catch (e) {
    console.error(`gigradar oauth callback (${provider.id}):`, e instanceof Error ? e.message : e);
    configUrl.searchParams.set(`${provider.id}Error`, "exchange-failed");
    return NextResponse.redirect(configUrl);
  }
}
