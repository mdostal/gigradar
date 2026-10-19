// GET /api/pantheon/shortlist[?runId=...] — the shortlist a run produced:
// every passed gig AND every rejected one, each with the gate's reasons
// verbatim. Defaults to the latest succeeded run. See src/lib/pantheon/adapter.ts.
import { getShortlist } from "@/lib/pantheon/adapter";
import { handlePantheonRequest } from "@/lib/pantheon/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const runId = new URL(request.url).searchParams.get("runId") ?? undefined;
  return handlePantheonRequest(request, () => ({ body: getShortlist(runId) }));
}
