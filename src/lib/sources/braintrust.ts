import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";

/**
 * Braintrust (app.usebraintrust.com) — a public, no-login talent marketplace.
 * Its job board is a client-rendered SPA (no SSR job data, no __NEXT_DATA__),
 * but the SPA itself is backed by a plain, unauthenticated JSON REST API at
 * `/api/jobs/` that a Node `fetch()` hits directly with no cookies, API key,
 * or special headers — confirmed live against the real site while building
 * this adapter (see the "manual live verification" note in the PR/commit
 * description for the exact run). That's why `auth: "none"` here is accurate
 * rather than aspirational.
 *
 * Deliberately scoped to the LIST endpoint only (no per-job `/api/jobs/{id}/`
 * detail fetch): the list already carries every field this adapter maps —
 * title, employer, budget, hours, role, created — and the only thing the
 * detail endpoint adds is a long HTML `description`. Skipping it keeps one
 * scan at O(pages) requests instead of O(jobs), which matters once more role
 * ids are configured. `Gig.description` is optional; leaving it unset here
 * is "unknown", not fabricated.
 */

const API_BASE = "https://app.usebraintrust.com/api/jobs/";
const JOB_URL_BASE = "https://app.usebraintrust.com/jobs/";

/**
 * Braintrust's own role taxonomy (from its public `/api/roles/` endpoint)
 * puts "Engineering" at id 5. That's the closest single category to
 * "tech/engineering-type roles"; callers can widen this via
 * `SourceConfig.settings.roleIds` (e.g. add 12 for "Data").
 */
const DEFAULT_ROLE_IDS = [5];

/**
 * Hard ceiling on pages followed per role id. Purely a runaway-loop guard
 * (a `next` cursor that never terminates would otherwise hang a scan
 * forever) — not expected to ever bind against Braintrust's real page counts.
 */
const MAX_PAGES_PER_ROLE = 25;

interface BraintrustEmployer {
  name: string;
}

interface BraintrustRole {
  id: number;
  name: string;
}

interface BraintrustJobListItem {
  id: number;
  title: string;
  employer: BraintrustEmployer | null;
  budget_minimum_usd: string | null;
  budget_maximum_usd: string | null;
  payment_type: string; // "hourly" | "annual" | "per_task" observed live
  created: string; // ISO datetime
  expected_hours_per_week: number | null;
  role: BraintrustRole;
  job_type: string; // "freelance" | "direct_hire" observed live
  contract_type: string;
}

interface BraintrustJobsPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: BraintrustJobListItem[];
}

function isBraintrustJobsPage(body: unknown): body is BraintrustJobsPage {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { results?: unknown }).results)
  );
}

function parseUsd(raw: string | null): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Braintrust's `payment_type` is "hourly" | "annual" | "per_task" (observed
 * live). Only the first two map cleanly onto Gig.rate's "hour" | "year" —
 * "per_task" has no honest per-hour/month/year equivalent, so rate is left
 * unknown rather than guessed (ARCHITECTURE.md rule 5: no fabricated data).
 */
function toRate(job: BraintrustJobListItem): Gig["rate"] {
  const min = parseUsd(job.budget_minimum_usd);
  const max = parseUsd(job.budget_maximum_usd);
  if (min === undefined && max === undefined) return undefined;
  if (job.payment_type === "hourly") return { min, max, unit: "hour" };
  if (job.payment_type === "annual") return { min, max, unit: "year" };
  return undefined;
}

function toGig(job: BraintrustJobListItem): Gig {
  return {
    sourceId: "braintrust",
    externalId: String(job.id),
    title: job.title,
    company: job.employer?.name,
    // The real per-listing page — confirmed live to 200 and to render the
    // matching job client-side, never a search/listing URL.
    url: `${JOB_URL_BASE}${job.id}/`,
    rate: toRate(job),
    weeklyHours: job.expected_hours_per_week ?? undefined,
    // Braintrust's public API exposes neither a remote flag nor a real
    // contract-to-hire concept: `job_type` is only "freelance" | "direct_hire",
    // and at least one live "direct_hire" listing observed while building this
    // adapter was explicitly hybrid/on-site — so job_type is not a safe proxy
    // for either field. Left unset (unknown) rather than guessed.
    postedAt: job.created.slice(0, 10),
    raw: job,
  };
}

async function fetchJobsPage(url: string): Promise<BraintrustJobsPage> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error(
      `braintrust: network error fetching ${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`braintrust: fetch failed for ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const body: unknown = await res.json();
  if (!isBraintrustJobsPage(body)) {
    throw new Error(`braintrust: unexpected response shape from ${url} (no results[] array)`);
  }
  return body;
}

async function fetchRole(roleId: number): Promise<BraintrustJobListItem[]> {
  const items: BraintrustJobListItem[] = [];
  let url: string | null = `${API_BASE}?role=${roleId}`;
  let pages = 0;
  while (url) {
    pages += 1;
    if (pages > MAX_PAGES_PER_ROLE) {
      throw new Error(
        `braintrust: role ${roleId} exceeded ${MAX_PAGES_PER_ROLE} pages without a null "next" — aborting instead of looping forever`,
      );
    }
    const page: BraintrustJobsPage = await fetchJobsPage(url);
    items.push(...page.results);
    // The API's own `next` link comes back as http:// even though the site
    // is https-only end to end; upgrade it so every hop stays encrypted.
    url = page.next ? page.next.replace(/^http:\/\//, "https://") : null;
  }
  return items;
}

function roleIdsFrom(cfg: SourceConfig): number[] {
  const configured = cfg.settings?.roleIds;
  if (Array.isArray(configured) && configured.length > 0 && configured.every((n) => typeof n === "number")) {
    return configured;
  }
  return DEFAULT_ROLE_IDS;
}

export const braintrustSource: Source = {
  id: "braintrust",
  label: "Braintrust",
  auth: "none",
  async fetch(cfg: SourceConfig): Promise<Gig[]> {
    const roleIds = roleIdsFrom(cfg);
    // Dedup across role ids (a job can plausibly show up under more than one
    // role) by Braintrust's own numeric id, keeping the last-fetched copy.
    const byId = new Map<number, BraintrustJobListItem>();
    for (const roleId of roleIds) {
      const items = await fetchRole(roleId);
      for (const item of items) byId.set(item.id, item);
    }
    return [...byId.values()].map(toGig);
  },
};

registerSource(braintrustSource);
