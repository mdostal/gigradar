// POST /api/pantheon/runs — trigger a radar run (the same runRadar() pipeline
// `npm run radar` drives). Returns 202 with the new `running` run, or 409
// with the run already in flight. GET returns the latest run's status.
// See src/lib/pantheon/adapter.ts and docs/pantheon-adapter.md.
import { getRunStatus, startRun } from "@/lib/pantheon/adapter";
import { handlePantheonRequest } from "@/lib/pantheon/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handlePantheonRequest(request, () => {
    const { run, started } = startRun();
    return started ? { body: { run }, status: 202 } : { body: { error: "a run is already in progress", run }, status: 409 };
  });
}

export async function GET(request: Request): Promise<Response> {
  return handlePantheonRequest(request, () => ({ body: { run: getRunStatus() } }));
}
