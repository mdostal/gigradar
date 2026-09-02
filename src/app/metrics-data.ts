// gigradar-command-center epic, metrics-page story. Server-side data
// loader for /metrics -- mirrors dashboard-data.ts's own loadDashboardData()
// shape exactly (same listGigs()/listDrafts() store calls, no new query
// surface needed -- every rollup in metrics-calc.ts is a pure function
// over these two arrays).
import { listDrafts, listGigs } from "@/lib/store";
import type { StoredDraft, StoredGig } from "@/lib/store";

export interface MetricsData {
  gigs: StoredGig[];
  drafts: StoredDraft[];
}

export function loadMetricsData(): MetricsData {
  return { gigs: listGigs(), drafts: listDrafts() };
}
