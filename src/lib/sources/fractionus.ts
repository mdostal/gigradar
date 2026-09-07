import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";
import { listGigs } from "../store/index.js";
import type { StoredGig } from "../store/index.js";

/**
 * Fractionus (fractionus.com) — a public, no-login fractional-executive
 * jobs board. Live-verified during this epic's planning
 * (`.pHive/epics/adapter-batch-public-boards/docs/research-brief.md` §2):
 * a plain `curl` with no special headers/User-Agent returns 53 real
 * `/jobs/<slug>` links baked directly into the server-rendered HTML at
 * `https://fractionus.com/jobs` — no client-side rendering step needed.
 * `robots.txt` has no relevant `Disallow` (only a `Sitemap:` line) — same
 * ethical-scraping check builtin.ts's own header comment establishes as
 * this project's convention.
 *
 * `auth: "none"`: a bare `fetch()` with only `{accept: "text/html"}` —
 * deliberately NO User-Agent spoofing (live re-verified while building this
 * adapter: identical results with zero special headers, matching
 * builtin.ts's own proven, honest pattern — see this story's
 * design_decisions).
 *
 * Interesting wrinkle confirmed live: the page ALSO ships an inline
 * `<script>` that builds a JSON-LD `ItemList` by querying
 * `document.querySelectorAll(".jobs-list-item")` client-side — but that
 * class does not actually exist anywhere in the real server-rendered
 * markup (confirmed by direct grep of the raw HTML this adapter fetches);
 * the real card wrapper class is `.job-list-item` (singular "list"). That
 * script is dead/stale boilerplate from a template, not a signal this
 * adapter should follow — this adapter parses the REAL markup, not the
 * script's aspirational selector.
 *
 * Parsed with targeted regexes over the raw HTML (Webflow CMS markup),
 * same approach and accepted brittleness as builtin.ts (no HTML-parsing
 * dependency exists in this repo) — a markup rewrite on Fractionus' end
 * would break this adapter; guarded the same way, by throwing on an
 * unrecognized shape rather than silently returning [].
 *
 * fractionus-fractionaljobs-detail-enrichment-and-closed-detection story
 * (crawler-fidelity-and-app-usability epic) — REAL FINDING that overturned
 * this adapter's own prior comment ("the list card exposes neither a rate
 * range nor a weekly-hours figure anywhere"): live-refetching the real
 * `/jobs` page during this story (2026-09-07, 140 real cards observed)
 * found that claim is no longer true — each card's own markup now ALSO
 * carries the exact same `data-status-badge`/price/days-range/employment-
 * type blocks the owner's screenshot showed on a per-listing DETAIL page
 * (byte-identical values, spot-checked against several listings' own
 * detail pages too — e.g. `fractional-cfo-at-baker-tilly-us` has neither
 * block on EITHER its list card or its detail page, confirming both
 * templates read the exact same underlying CMS fields, never one having
 * MORE than the other). Concretely, of the 140 real cards sampled: 140/140
 * (100%) carried a real status badge — and 97 "Closed" + 3 "Filled" vs
 * only 40 "Active", i.e. the large majority of what this board's own list
 * page currently returns is ALREADY closed but never detected before this
 * story; 83/140 (59%) carried a real price range; 98/140 (70%) carried a
 * real weekly-hours range.
 *
 * Given that, `fetch()` below extracts status/rate/hours/employment-type
 * directly from EACH list card (`parseStatusAndRate()`, shared with the
 * detail-page path below) — genuinely free: this is the SAME single
 * `/jobs` fetch this adapter always made, just reading more of it. A
 * closed/filled card is OMITTED from this function's returned `Gig[]`; no
 * new archival mechanism is added — the EXISTING `recordScan()` delisting
 * sweep (`store/gigs.ts`) already treats "returned by the source but
 * missing from this scan's results" as a real closure signal and stamps
 * `unavailable_since`/`status: 'archived'`/a real `outcomeReason` exactly
 * as this story requires; this adapter just feeds it the correct input —
 * this is the fix for the real bug report gig,
 * `fractional-cto-at-emanate-technology`.
 *
 * A genuinely bounded, lazy per-listing DETAIL-page fetch (`fetchDetail()`
 * below) is kept as a defensive FALLBACK, in case Fractionus' two
 * templates ever diverge for some listing this story's sample didn't
 * happen to cover — see `selectDetailFetchCandidates()`'s own doc comment
 * for the real bound. It is not the primary mechanism (the list card
 * already is), so it fires rarely in practice.
 */

const SITE = "https://fractionus.com";
const JOBS_URL = `${SITE}/jobs`;

interface FractionusItem {
  /** The `/jobs/<slug>` path's slug, also this Gig's stable externalId. */
  externalId: string;
  url: string; // absolute per-listing url
  title: string;
  company?: string;
  /** e.g. "Remote" | "On-site" | "Hybrid" — the card's own work-arrangement badge, distinct from its separate location text. */
  arrangement?: string;
  /** Already ISO "YYYY-MM-DD" text baked into the card's own data-date attribute's visible content — no relative-date math needed. */
  isoDate?: string;
  /** Card's own short description blurb, when present. */
  description?: string;
  /** This card's OWN status/rate/hours/employment-type, parsed straight off the list page — see file-level comment. */
  statusAndRate: StatusAndRate;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Minimal HTML-entity decoder — same shape/duplication convention as fractionaljobs.ts's and builtin.ts's own copies. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => NAMED_ENTITIES[name] ?? "");
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Fractionus already renders an ISO "YYYY-MM-DD" string as the visible node text — validated, not reformatted. An unrecognized shape leaves postedAt unset (unknown), never guessed. */
function toPostedAt(isoDate: string | undefined): string | undefined {
  if (!isoDate) return undefined;
  return ISO_DATE_RE.test(isoDate) ? isoDate : undefined;
}

/** "Remote" -> true, "On-site" -> false. "Hybrid" (genuinely mixed) or missing is left unknown rather than guessed — same convention as builtin.ts's toRemote(). */
function toRemote(arrangement: string | undefined): boolean | undefined {
  if (arrangement === "Remote") return true;
  if (arrangement === "On-site") return false;
  return undefined;
}

/**
 * Splits the jobs-list HTML into one raw HTML chunk per job card, using each
 * card's own `role="listitem" class="job-list-item w-dyn-item"` marker as
 * the boundary — same slice-to-next-marker-or-end approach as builtin.ts's
 * splitJobCards().
 */
function splitJobCards(html: string): string[] {
  const starts: number[] = [];
  const re = /<div role="listitem" class="job-list-item w-dyn-item">/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) starts.push(m.index);
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

const HREF_RE = /href="(\/jobs\/[^"]+)" class="margin-bottom margin-xxlarge-copy w-inline-block">/;
const COMPANY_RE = /heading-style-h4-2-copy-copy margin-top margin-xxsmall">([^<]*)<\/p>/;
const TITLE_RE = /heading-style-h5-2-copy">([^<]*)<\/h3>/;
const ISO_DATE_TEXT_RE = /data-date="[^"]*"\s+class="heading-style-h4-days[^"]*">([^<]*)<\/h2>/;
const DESCRIPTION_RE = /heading-style-h4-2-copy-copy margin-top margin-xxsmall jd">([^<]*)<\/h2>/;
// The card's two "category-link w-container" tags are always [location,
// work-arrangement] IN THAT ORDER (confirmed against all 53 real cards
// live-fetched while building this adapter) — distinct from the separate
// "category-link-copy-c" tags (status/industry badges, one of which is now
// read by parseStatusAndRate() below).
const CATEGORY_LINK_RE = /blog-post4-header_category-link w-container">\s*<div class="text-block-32 text-size-tiny">([^<]*)<\/div>/g;

// ---------------------------------------------------------------------------
// Status/rate/hours/employment-type — shared between the LIST card and the
// per-listing DETAIL page (see file-level comment: both templates render the
// exact same block shapes, just the weekly-hours block's own class differs
// ever so slightly — "days" on the list card, "days-listing" on the detail
// page, both handled by one regex below).
// ---------------------------------------------------------------------------

interface StatusAndRate {
  /**
   * "open" only for a literal "Active" badge (the site's OWN inline detail-
   * page script treats anything else as terminal:
   * `if (CONFIG.status...!=="active") return;`, live-confirmed). "closed"
   * covers every other REAL value seen live ("Closed", "Filled") and,
   * deliberately, anything else the badge might ever say — this board's own
   * three-entry `colors` map (active/filled/closed) has no other state.
   * `undefined` means the badge itself couldn't be found at all (page-shape
   * drift) — never guessed, the caller leaves that gig untouched rather
   * than risk a false archive.
   */
  status: "open" | "closed" | undefined;
  rateMin?: number;
  rateMax?: number;
  weeklyHours?: number;
  employmentType?: "fractional";
}

// The status badge's wrapping element differs (a plain `<div>` on the list
// card, an `<a>` on the detail page) and the inner text node's own class
// picks up an extra "text-size-tiny" modifier on the list card only — this
// regex only anchors on the one thing both share: the `data-status-badge`
// attribute followed by a "text-block-32"-prefixed div.
const STATUS_BADGE_RE = /data-status-badge="true"[^>]*>\s*<div class="text-block-32[^"]*">([^<]*)<\/div>/;
// Scoped, non-greedy captures of each block's own inner content — safe to
// stop at the first "</div>" since neither block ever nests a child <div>
// (only <p> tags), confirmed live on both the list card and the detail page.
const PRICE_BLOCK_RE = /<div class="div-block-14 price">([\s\S]*?)<\/div>/;
// "days" (list card) or "days-listing" (detail page) — same block otherwise.
const DAYS_BLOCK_RE = /<div class="div-block-14 days(?:-listing)?">([\s\S]*?)<\/div>/;
const FRACTIONAL_BLOCK_RE = /<div class="div-block-14 fracitonal">([\s\S]*?)<\/div>/;
// Only matches a <p> whose own text is purely numeric — real cards also
// carry non-numeric "$"/dash/"*" <p> tags with the SAME "paragraph" class,
// which this deliberately does not match.
const PARA_MIN_RE = /<p class="paragraph">([0-9]+(?:\.[0-9]+)?)<\/p>/;
const PARA_MAX_RE = /<p class="paragraph-2">([0-9]+(?:\.[0-9]+)?)<\/p>/;
const FRACTIONAL_TEXT_RE = /<p class="paragraph fracitonal">([^<]*)<\/p>/;

/**
 * A scoped block's own min/max numeric pair. A single-value listing (only
 * the "paragraph" class bound, no "paragraph-2") reports that one number as
 * BOTH min and max — never guessed higher. Absent block -> both unset.
 */
function extractNumericRange(block: string | undefined): { min?: number; max?: number } {
  if (block === undefined) return {};
  const minRaw = PARA_MIN_RE.exec(block)?.[1];
  const maxRaw = PARA_MAX_RE.exec(block)?.[1];
  const min = minRaw !== undefined ? Number(minRaw) : undefined;
  const max = maxRaw !== undefined ? Number(maxRaw) : min;
  return { min, max };
}

/**
 * Pure parse, usable against EITHER a single card's own HTML fragment (the
 * list page) or a whole detail-page HTML document — see this section's own
 * header comment for why both share one parser. Always USD, always hourly —
 * every real rate observed across this story's live research sat in the
 * $50-$650 range (consistent with the site's own "$X-$Y/hr" meta-
 * description text), never annual/salaried; the detail page's own CONFIG
 * "Pay per Year or Per Hour" field was empty on every real listing fetched,
 * so it is never read as a signal here.
 */
function parseStatusAndRate(html: string): StatusAndRate {
  const statusText = STATUS_BADGE_RE.exec(html)?.[1]?.trim().toLowerCase();
  const status: StatusAndRate["status"] = statusText === undefined ? undefined : statusText === "active" ? "open" : "closed";

  const price = extractNumericRange(PRICE_BLOCK_RE.exec(html)?.[1]);
  const days = extractNumericRange(DAYS_BLOCK_RE.exec(html)?.[1]);

  const fractionalBlock = FRACTIONAL_BLOCK_RE.exec(html)?.[1];
  const fractionalText = fractionalBlock !== undefined ? FRACTIONAL_TEXT_RE.exec(fractionalBlock)?.[1]?.trim() : undefined;

  return {
    status,
    rateMin: price.min,
    rateMax: price.max,
    weeklyHours: days.max,
    employmentType: fractionalText === "Fractional Contract" ? "fractional" : undefined,
  };
}

function parseCard(card: string): FractionusItem | null {
  const href = HREF_RE.exec(card)?.[1];
  const title = TITLE_RE.exec(card)?.[1];
  if (href === undefined || title === undefined || title.trim().length === 0) return null; // can't build a valid Gig without a url and a title

  const externalId = /^\/jobs\/([^/?#]+)/.exec(href)?.[1];
  if (!externalId) return null;

  const companyRaw = COMPANY_RE.exec(card)?.[1];
  const company = companyRaw ? decodeEntities(companyRaw).trim() : "";

  const categoryTags = [...card.matchAll(CATEGORY_LINK_RE)].map((m) => decodeEntities(m[1] ?? "").trim());
  const arrangement = categoryTags.length === 2 ? categoryTags[1] : undefined;

  const isoDate = ISO_DATE_TEXT_RE.exec(card)?.[1]?.trim();
  const descriptionRaw = DESCRIPTION_RE.exec(card)?.[1];

  return {
    externalId,
    url: `${SITE}${decodeEntities(href)}`,
    title: decodeEntities(title).trim(),
    company: company.length > 0 ? company : undefined,
    arrangement,
    isoDate,
    description: descriptionRaw ? decodeEntities(descriptionRaw).trim() : undefined,
    statusAndRate: parseStatusAndRate(card),
  };
}

/** Best-effort single detail-page fetch — a network error, non-ok response, or any other failure degrades to `undefined` (never throws, never blocks the list-page scan this rides along with). */
async function fetchDetail(url: string): Promise<StatusAndRate | undefined> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "text/html" } });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  return parseStatusAndRate(await res.text());
}

/**
 * A genuinely bounded, lazy DEFENSIVE-FALLBACK detail-page fetch — see
 * file-level comment for why the list card is the PRIMARY, free source and
 * this rarely needs to fire at all. A listing is a candidate only when:
 *   1. its own list card didn't yield a rate (no price block bound there);
 *   2. it already has a stored `tier` of "green" or "yellow" from a PRIOR
 *      scan — bounds cost to gigs the owner would plausibly ever see. A
 *      brand-new, not-yet-tiered gig is simply left for its NEXT cycle,
 *      once this cycle's own gate()/tier() pass has stamped it;
 *   3. is not already `archived`/`ignored` — nothing left to learn for a
 *      gig the owner has already moved past.
 * Even then, at most `MAX_DETAIL_FETCHES_PER_SCAN` candidates are actually
 * fetched THIS cycle (concurrency-bounded by `DETAIL_FETCH_CONCURRENCY`) —
 * with 346 real fractionus listings, an unconditional per-cycle fetch of
 * every one of them (let alone every one of the combined 469 across both
 * this story's sources) would be a real load/latency problem, both
 * adapters' own "ethical scraping" convention.
 */
const MAX_DETAIL_FETCHES_PER_SCAN = 15;
const DETAIL_FETCH_CONCURRENCY = 3;

function selectDetailFetchCandidates(items: FractionusItem[], stored: ReadonlyMap<string, StoredGig>): FractionusItem[] {
  const eligible = items.filter((item) => {
    if (item.statusAndRate.rateMin !== undefined) return false; // list card already has it — nothing to gain
    const g = stored.get(item.externalId);
    if (!g) return false;
    if (g.status === "archived" || g.status === "ignored") return false;
    return g.tier === "green" || g.tier === "yellow";
  });
  return eligible.slice(0, MAX_DETAIL_FETCHES_PER_SCAN);
}

/** Fixed-size concurrency window, same shape as builtin.ts's own fetchDetailDescriptions(). */
async function fetchDetailsBounded(items: FractionusItem[]): Promise<Map<string, StatusAndRate | undefined>> {
  const results = new Map<string, StatusAndRate | undefined>();
  for (let i = 0; i < items.length; i += DETAIL_FETCH_CONCURRENCY) {
    const batch = items.slice(i, i + DETAIL_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(batch.map((item) => fetchDetail(item.url)));
    batch.forEach((item, idx) => results.set(item.externalId, batchResults[idx]));
  }
  return results;
}

/**
 * "Cache permanently once fetched": `upsertOne()` (store/gigs.ts) always
 * overwrites every column from the `Gig` it's given — there is no partial-
 * column update. Precedence: this cycle's own list-card parse (freshest,
 * free) first, then this cycle's own defensive detail-page fetch (only for
 * today's bounded candidates), then whatever was already stored from a
 * prior cycle — so a scan that finds nothing new for a given gig still
 * carries its previously-learned rate/hours/employmentType forward instead
 * of silently blanking them back to NULL.
 */
function mergeEnrichment(
  card: StatusAndRate,
  detail: StatusAndRate | undefined,
  stored: StoredGig | undefined,
): Pick<Gig, "rate" | "weeklyHours" | "employmentType"> {
  const rateMin = card.rateMin ?? detail?.rateMin;
  const rateMax = card.rateMin !== undefined ? card.rateMax : detail?.rateMax;
  const rate = rateMin !== undefined ? { min: rateMin, max: rateMax, unit: "hour" as const } : stored?.rate;
  return {
    rate,
    weeklyHours: card.weeklyHours ?? detail?.weeklyHours ?? stored?.weeklyHours,
    employmentType: card.employmentType ?? detail?.employmentType ?? stored?.employmentType,
  };
}

function toGig(item: FractionusItem, enrichment: Pick<Gig, "rate" | "weeklyHours" | "employmentType">): Gig {
  return {
    sourceId: "fractionus",
    externalId: item.externalId,
    title: item.title,
    company: item.company,
    // The real per-listing page (this card's own /jobs/<slug> permalink),
    // never the /jobs search/listing page itself.
    url: item.url,
    rate: enrichment.rate,
    weeklyHours: enrichment.weeklyHours,
    employmentType: enrichment.employmentType,
    remote: toRemote(item.arrangement),
    postedAt: toPostedAt(item.isoDate),
    description: item.description,
    raw: item,
  };
}

async function fetchJobsHtml(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(JOBS_URL, { headers: { accept: "text/html" } });
  } catch (e) {
    throw new Error(`fractionus: network error fetching ${JOBS_URL}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`fractionus: fetch failed for ${JOBS_URL}: HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  // Sanity check this is really Fractionus' own jobs page and not, say, an
  // error/interstitial page — mirrors builtin.ts's #jobs-list shape check,
  // just against this page's own heading marker (there is no stable
  // container id on this site — confirmed by direct read of the raw HTML).
  if (!html.includes('class="heading-style-h2-6 jobs"')) {
    throw new Error(`fractionus: unexpected response shape from ${JOBS_URL} (jobs-page heading not found)`);
  }
  return html;
}

export const fractionusSource: Source = {
  id: "fractionus",
  label: "Fractionus",
  auth: "none",
  // application-format-coverage-per-source story — REAL research, live
  // `curl` against several real `/jobs/<slug>` detail pages: each carries
  // its own `apply-url` attribute pointing to a DIFFERENT external
  // destination depending on where THAT listing came from — a Greenhouse
  // ATS posting (`mongodb.com/careers/job/?gh_jid=...`) for one, a raw
  // LinkedIn job-view link for another. Fractionus is a pure aggregator: it
  // has no application mechanism of its own, so there is no single honest
  // per-source `applicationFormat` — it genuinely varies gig-by-gig with
  // the destination site. Deliberately left unset (falls through to the
  // documented "cover-letter" default) rather than guessed, per this
  // story's own "leave it if it can't be determined" allowance.
  async fetch(_cfg: SourceConfig): Promise<Gig[]> {
    const html = await fetchJobsHtml();
    const cards = splitJobCards(html);
    const items = cards.map(parseCard).filter((x): x is FractionusItem => x !== null);

    // The page had job-list-item markers but every single one failed to
    // yield a valid item — that's a real parsing break (markup drift), not
    // a legitimately empty board. Throw instead of silently returning [] —
    // matches builtin.ts's real two-tier throw/return-[] split exactly.
    if (cards.length > 0 && items.length === 0) {
      throw new Error(`fractionus: found ${cards.length} job card(s) but could not parse any of them`);
    }

    // Dedup by externalId within this single page (defensive, mirrors
    // builtin.ts/braintrust.ts).
    const byId = new Map<string, FractionusItem>();
    for (const item of items) byId.set(item.externalId, item);
    const dedupedItems = [...byId.values()];

    // A card whose OWN status badge already says Closed/Filled is excluded
    // right here — zero extra fetches, see file-level comment. This is the
    // real fix for fractional-cto-at-emanate-technology.
    const openCardItems = dedupedItems.filter((item) => item.statusAndRate.status !== "closed");

    // Bounded, lazy DEFENSIVE-FALLBACK detail-page fetch, only for listings
    // whose own list card didn't already carry a rate — see
    // selectDetailFetchCandidates()'s own doc comment for the real bound.
    const storedByExternalId = new Map(listGigs({ sourceId: "fractionus" }).map((g) => [g.externalId, g]));
    const candidates = selectDetailFetchCandidates(openCardItems, storedByExternalId);
    const details = candidates.length > 0 ? await fetchDetailsBounded(candidates) : new Map<string, StatusAndRate | undefined>();

    // cards.length === 0 (jobs-page heading present, genuinely zero
    // listings right now) falls through here too, correctly returning []
    // rather than throwing.
    return openCardItems.map((item) =>
      toGig(item, mergeEnrichment(item.statusAndRate, details.get(item.externalId), storedByExternalId.get(item.externalId))),
    );
  },
};

registerSource(fractionusSource);
