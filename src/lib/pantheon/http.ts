// The HTTP edge shared by every src/app/api/pantheon/* route handler
// (pantheon-adapter story, PANT-1207): authenticate, run the handler, and map
// its outcome to a JSON response. Plain web `Request`/`Response`, so the
// handlers are testable without a running Next server.
import { AdapterError } from "./adapter.js";
import { OPERATOR_TOKEN_HEADER, authorize, type AuthDeps } from "./auth.js";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Runs `handler` only for a request carrying a valid operator token. An
 * AdapterError becomes its own status with its message; anything else is a
 * 500 whose body says only that the adapter failed — the detail goes to the
 * server log, never the response, matching this repo's "never leak error
 * detail that could echo a secret" rule.
 */
export async function handlePantheonRequest(
  request: Request,
  handler: () => Promise<{ body: unknown; status?: number }> | { body: unknown; status?: number },
  deps: AuthDeps = {},
): Promise<Response> {
  const auth = await authorize(request.headers.get(OPERATOR_TOKEN_HEADER), deps);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  try {
    const { body, status } = await handler();
    return json(body, status ?? 200);
  } catch (e) {
    if (e instanceof AdapterError) return json({ error: e.message }, e.status);
    console.error(`gigradar pantheon adapter: ${request.method} ${new URL(request.url).pathname} failed:`, e instanceof Error ? e.message : e);
    return json({ error: "pantheon adapter: internal error (see the gigradar server log)" }, 500);
  }
}

/** Parses an optional JSON object body; an absent/empty body is `{}`, anything else non-object is a 400. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AdapterError("pantheon adapter: request body is not valid JSON", 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AdapterError("pantheon adapter: request body must be a JSON object", 400);
  }
  return parsed as Record<string, unknown>;
}
