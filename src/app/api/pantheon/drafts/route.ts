// POST /api/pantheon/drafts {key, runId?, resumeId?} — STAGE an application
// draft for one shortlisted gig. The draft lands as `draft` and stops there:
// approving and submitting stay human actions in /drafts, and this adapter
// has no route that does either (see src/lib/pantheon/__tests__/no-submit-path.test.ts).
import { AdapterError, stageDraft } from "@/lib/pantheon/adapter";
import { handlePantheonRequest, readJsonObject } from "@/lib/pantheon/http";

export const dynamic = "force-dynamic";

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) throw new AdapterError(`pantheon adapter: \`${field}\` must be a non-empty string`, 400);
  return value;
}

export async function POST(request: Request): Promise<Response> {
  return handlePantheonRequest(request, async () => {
    const body = await readJsonObject(request);
    const key = optionalString(body, "key");
    if (!key) throw new AdapterError("pantheon adapter: `key` is required", 400);
    const draft = await stageDraft({ key, runId: optionalString(body, "runId"), resumeId: optionalString(body, "resumeId") });
    return { body: { draft }, status: 201 };
  });
}
