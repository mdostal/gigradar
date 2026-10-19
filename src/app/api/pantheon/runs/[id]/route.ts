// GET /api/pantheon/runs/:id — one run's status. See src/lib/pantheon/adapter.ts.
import { getRunStatus } from "@/lib/pantheon/adapter";
import { handlePantheonRequest } from "@/lib/pantheon/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return handlePantheonRequest(request, () => ({ body: { run: getRunStatus(id) } }));
}
