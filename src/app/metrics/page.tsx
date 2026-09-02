import { MetricsClient } from "./metrics-client";
import { loadMetricsData } from "../metrics-data";

// gigradar-command-center epic, metrics-page story. Same force-dynamic
// reasoning as every other data-reading route in this app (the standalone
// scheduler process writes gigs/drafts with no Next.js request context, so
// this route must never cache stale throughput numbers).
export const dynamic = "force-dynamic";

export default function MetricsPage() {
  const { gigs, drafts } = loadMetricsData();
  // Computed here (server-side, once) and passed down rather than
  // MetricsClient calling Date.now() itself during render -- a client
  // component calling Date.now() in its own render/useMemo produces a
  // DIFFERENT value on the server-rendered HTML vs. the client's
  // hydration pass, a real hydration-mismatch bug (React error #418,
  // caught live during this story's own verification). One shared value,
  // agreed on before the client ever runs, closes that class of bug for
  // this page.
  const now = Date.now();
  return <MetricsClient gigs={gigs} drafts={drafts} now={now} />;
}
