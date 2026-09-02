import { notFound } from "next/navigation";
import { InterviewWorkspaceClient } from "./interview-workspace-client";
import { loadInterviewWorkspaceData } from "./interview-data";

// gigradar-command-center epic, interview-workspace-page story. Same
// force-dynamic reasoning as every other data-reading route in this app
// (src/app/page.tsx's own header comment) -- the standalone scheduler
// process writes gigs/drafts/prep with no Next.js request context, so this
// route must never cache a stale prep packet or draft status.
export const dynamic = "force-dynamic";

export default async function InterviewWorkspacePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  // gig.key is "sourceId:externalId" -- Next.js's dynamic-segment params
  // are NOT auto-decoded here (live-verified: params.key arrives as the
  // literal "braintrust%3Aexternal-id" string, not "braintrust:external-id"),
  // so the encodeURIComponent() callers use to build this route's href
  // (dashboard-client.tsx/today-client.tsx) needs an explicit decode on
  // this end to round-trip back to the real gig key.
  const data = loadInterviewWorkspaceData(decodeURIComponent(key));
  if (!data) notFound();

  return <InterviewWorkspaceClient {...data} />;
}
