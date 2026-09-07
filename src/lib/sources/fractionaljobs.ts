import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";
import { listGigs } from "../store/index.js";
import type { StoredGig } from "../store/index.js";

/**
 * FractionalJobs (fractionaljobs.io) — a public, no-login fractional-jobs
 * board. Live-verified during this epic's planning
 * (`.pHive/epics/adapter-batch-public-boards/docs/research-brief.md` §2):
 * a plain `curl` with no special headers/User-Agent returns 63 real
 * `/jobs/<slug>` links baked directly into the server-rendered HTML — no
 * client-side rendering step needed, same fork builtin.ts's own header
 * comment calls out (SPA-vs-API/plain-HTML), just landing on the
 * plain-HTML side again. The live jobs list is the site's ROOT url
 * (`https://www.fractionaljobs.io/`) — there is no separate `/jobs` index
 * page; the homepage itself IS the live board. `robots.txt` has no
 * relevant `Disallow` (only a `Sitemap:` line) — same ethical-scraping
 * check builtin.ts's own header comment establishes as this project's
 * convention.
 *
 * `auth: "none"`: a bare `fetch()` with only `{accept: "text/html"}` —
 * deliberately NO User-Agent spoofing (live re-verified while building this
 * adapter: identical results with zero special headers, matching
 * builtin.ts's own proven, honest pattern — see this story's
 * design_decisions).
 *
 * Parsed with targeted regexes over the raw HTML (Webflow CMS markup),
 * same approach and the same accepted brittleness as builtin.ts (no
 * HTML-parsing dependency exists in this repo) — a markup rewrite on
 * FractionalJobs' end would break this adapter; guarded the same way, by
 * throwing on an unrecognized shape rather than silently returning [].
 *
 * `rate`/`weeklyHours` were always `undefined` straight off the original
 * LIST-page card parse. See adapter-batch-public-boards's own
 * design_decisions for that original finding.
 *
 * fractionus-fractionaljobs-detail-enrichment-and-closed-detection story
 * (crawler-fidelity-and-app-usability epic) — REAL FINDING, live-verified
 * 2026-09-07: the card's own `job-item_more-info` block (already parsed
 * below for `location`) ALSO carries real weekly-hours and (when present)
 * rate text as two of its sibling `text-inline` fields — this adapter's own
 * PRIOR header comment ("hours and rate, when present, come first —
 * deliberately not parsed") had already spotted them but chose not to read
 * them; this story finally does, reusing the exact same
 * `parseWeeklyCommitment()`/`parseCompensationRange()` shape-strict parsers
 * the detail page's own labeled fields use below (both surfaces render the
 * identical text, e.g. "$200 - $250 / hr", "10 - 20 hrs"). This is free —
 * the SAME single homepage fetch this adapter always made, just reading
 * more of it.
 *
 * Closed-detection has NO equivalent free signal on this compact list
 * card, unlike fractionus.ts's own card (which grew a real status badge) —
 * FractionalJobs' "This Role is Closed" banner only exists on the bigger
 * per-listing DETAIL page template. `fetch()` below therefore keeps a
 * genuinely bounded, lazy per-listing DETAIL-page fetch (mirrors
 * fractionus.ts's own mechanism and design_decisions) whose real purpose is
 * now closed-detection specifically (rate/hours enrichment is a bonus when
 * it fires, but no longer this fetch's reason to exist) — see
 * `DETAIL_CLOSED_BANNER_RE`'s own doc comment for the real Webflow
 * conditional-visibility signal this reads (confirmed live: the literal
 * words "closed"/"filled" appear on EVERY FractionalJobs detail page
 * regardless of that listing's real status — a naive text search is a
 * false-positive trap this adapter does NOT fall into). A detected-closed
 * listing is simply OMITTED from this function's returned `Gig[]`, feeding
 * the EXISTING `recordScan()` delisting sweep (store/gigs.ts) exactly the
 * same way fractionus.ts's own mechanism does — no new archival mechanism.
 * "Compensation Range" (list card or detail page) is FREQUENTLY the
 * literal text "Unknown" (live-verified: roughly half of a real 40-listing
 * sample), confirming the legacy tool's own `_flagOnly: true` caution was
 * real — see `parseCompensationRange()`'s own doc comment for the real,
 * live-observed shapes this deliberately leaves unparsed rather than
 * guessed.
 */

const SITE = "https://www.fractionaljobs.io";
/** The site's own homepage IS the live jobs list — see file-level comment. */
const JOBS_URL = `${SITE}/`;

interface FractionalJobsItem {
  /** The `/jobs/<slug>` path's slug, also this Gig's stable externalId. */
  externalId: string;
  url: string; // absolute per-listing url
  title: string;
  company?: string;
  /** e.g. "Remote (USA only)", "Hybrid (NYC only)", "Onsite (Boston only)" — the card's own work-arrangement text. */
  location?: string;
  /** e.g. "August 10, 2026" — an ABSOLUTE date, unlike builtin.ts's relative "N days ago" text. */
  dateText?: string;
  /** This card's OWN weekly-hours figure, parsed straight off the list page — see file-level comment. */
  cardWeeklyHours?: number;
  /** This card's OWN rate range, parsed straight off the list page (only the unambiguous shapes — see `parseCompensationRange()`) — see file-level comment. */
  cardRate: { min?: number; max?: number; unit?: "hour" | "month" };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Minimal HTML-entity decoder — same shape as builtin.ts's decodeEntities(),
 * duplicated per this project's existing convention of each adapter keeping
 * its own small copy rather than sharing a utils module (see gofractional.ts
 * duplicating its own toPostedAt() rather than importing builtin.ts's).
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => NAMED_ENTITIES[name] ?? "");
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const ABSOLUTE_DATE_RE =
  /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})$/;

/**
 * FractionalJobs' card shows an ABSOLUTE date ("August 10, 2026"), unlike
 * builtin.ts's/gofractional.ts's relative "N days/hours ago" text — no
 * `now` reference needed here. An unparseable/missing string leaves
 * postedAt unset (unknown), never guessed.
 */
function toPostedAt(dateText: string | undefined): string | undefined {
  if (!dateText) return undefined;
  const m = ABSOLUTE_DATE_RE.exec(dateText.trim());
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]!) + 1;
  const day = Number(m[2]);
  const year = Number(m[3]);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "Remote..." -> true, "Onsite..." -> false. "Hybrid..." (genuinely mixed) or missing is left unknown rather than guessed — same convention as builtin.ts's toRemote(). */
function toRemote(location: string | undefined): boolean | undefined {
  if (!location) return undefined;
  if (location.startsWith("Remote")) return true;
  if (location.startsWith("Onsite")) return false;
  return undefined;
}

/**
 * Splits the jobs-list HTML into one raw HTML chunk per job card, using each
 * card's own `role="listitem" class="job-item w-dyn-item"` marker as the
 * boundary — same slice-to-next-marker-or-end approach as builtin.ts's
 * splitJobCards().
 */
function splitJobCards(html: string): string[] {
  const starts: number[] = [];
  const re = /<div role="listitem" class="job-item w-dyn-item">/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) starts.push(m.index);
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

const HREF_RE = /<a href="(\/jobs\/[^"]+)" target="_blank" class="job-item_link-to-job w-inline-block">/;
// Company and title live in the first and third of four sibling <h3> tags
// (the second is always a literal " - " separator, the fourth always blank)
// — observed identically across all 63 real cards live-fetched while
// building this adapter.
const COMPANY_TITLE_RE = /<h3[^>]*>([^<]*)<\/h3><h3[^>]*>[^<]*<\/h3><h3[^>]*>([^<]*)<\/h3>/;
const MORE_INFO_RE = /job-item_more-info">(.*?)<div class="hide">/;
const TEXT_INLINE_RE = /<div class="text-inline">([^<]*)<\/div>/g;
const DATE_RE = /<div class="date">([^<]*)<\/div>/;

function parseCard(card: string): FractionalJobsItem | null {
  const href = HREF_RE.exec(card)?.[1];
  const ctMatch = COMPANY_TITLE_RE.exec(card);
  const title = ctMatch?.[2];
  if (href === undefined || title === undefined || title.trim().length === 0) return null; // can't build a valid Gig without a url and a title

  const externalId = /^\/jobs\/([^/?#]+)/.exec(href)?.[1];
  if (!externalId) return null;

  const companyRaw = ctMatch?.[1];
  const company = companyRaw ? decodeEntities(companyRaw).trim() : "";

  // The more-info block's LAST "text-inline" field is always the
  // work-arrangement/location text. The FIRST is always weekly hours; a
  // MIDDLE field (only present when the field count is 5, not 3 — live-
  // verified against a real 40-card sample: every card was exactly one of
  // these two shapes) is the rate range, when this listing has one at all.
  let location: string | undefined;
  let cardWeeklyHours: number | undefined;
  let cardRate: FractionalJobsItem["cardRate"] = {};
  const moreInfo = MORE_INFO_RE.exec(card)?.[1];
  if (moreInfo) {
    const fields = [...moreInfo.matchAll(TEXT_INLINE_RE)].map((f) => decodeEntities(f[1] ?? "").trim());
    location = fields.length > 0 ? fields[fields.length - 1] : undefined;
    cardWeeklyHours = parseWeeklyCommitment(fields[0]);
    if (fields.length === 5) cardRate = parseCompensationRange(fields[2]);
  }

  const dateTextRaw = DATE_RE.exec(card)?.[1];

  return {
    externalId,
    url: `${SITE}${decodeEntities(href)}`,
    title: decodeEntities(title).trim(),
    company: company.length > 0 ? company : undefined,
    location,
    dateText: dateTextRaw ? decodeEntities(dateTextRaw).trim() : undefined,
    cardWeeklyHours,
    cardRate,
  };
}

/** What one listing's own detail page (`item.url`) tells us beyond the list card — see file-level comment. */
interface FractionalJobsDetail {
  /**
   * "open" when the real, live-confirmed Closed-banner signal (see
   * `DETAIL_CLOSED_BANNER_RE`) says this listing is NOT closed; "closed"
   * when it says it is. `undefined` means the banner marker itself
   * couldn't be found at all (page-shape drift, or a non-html/error
   * response) — never guessed, the caller leaves that gig untouched.
   */
  status: "open" | "closed" | undefined;
  rateMin?: number;
  rateMax?: number;
  rateUnit?: "hour" | "month";
  weeklyHours?: number;
}

/**
 * The real, live-confirmed open/closed signal (live-verified 2026-09-07
 * against >40 real detail-page fetches): Webflow's OWN native conditional-
 * visibility mechanism always renders BOTH branches of a CMS boolean field
 * into the static HTML, and bakes `w-condition-invisible` onto whichever
 * branch does NOT apply to this specific item at publish time — the
 * branch that DOES apply omits the class entirely. The "This Role is
 * Closed" banner is one such branch: present with `w-condition-invisible`
 * -> hidden -> NOT closed; present WITHOUT it -> shown -> genuinely closed.
 *
 * Deliberately NOT a plain text search for "closed"/"filled" anywhere on
 * the page — live-confirmed those exact words appear on EVERY single
 * FractionalJobs detail page regardless of real status (this same static
 * banner's own copy: "Fractional jobs get filled quickly..."), which would
 * make every single listing look permanently closed. This regex targets
 * ONLY this one wrapping div's own class attribute.
 */
const DETAIL_CLOSED_BANNER_RE = /<div class="home-jobs_hiring-block-jobs([^"]*)"><h2 class="heading-style-h4">This Role is Closed<\/h2>/;

const DETAIL_WEEKLY_COMMITMENT_RE = /<h2 class="text-size-medium">Weekly Commitment<\/h2><\/div><div>([^<]*)<\/div>/;
const DETAIL_COMPENSATION_RANGE_RE = /<h2 class="text-size-medium">Compensation Range<\/h2><\/div><div>([^<]*)<\/div>/;

/**
 * "N - M hrs" (or a single "N hrs") -> `Gig.weeklyHours`'s upper bound,
 * same convention as ateam.ts's/gofractional.ts's own toWeeklyHours(). Any
 * other text (there is no other real shape observed for this field) leaves
 * it unset.
 */
const WEEKLY_COMMITMENT_VALUE_RE = /^(\d+)(?:\s*-\s*(\d+))?\s*hrs$/;
function parseWeeklyCommitment(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = WEEKLY_COMMITMENT_VALUE_RE.exec(text.trim());
  if (!m) return undefined;
  const min = Number(m[1]);
  const max = m[2] !== undefined ? Number(m[2]) : min;
  return max;
}

/**
 * Parses ONLY the two unambiguous "Compensation Range" shapes real,
 * live-fetched listings actually showed (2026-09-07 sample of 40 real
 * detail pages): a plain hourly USD range ("$200 - $250 / hr") or a plain
 * monthly USD range where BOTH numbers carry the "K" suffix ("$8K - $10K /
 * mo"). Deliberately leaves everything else genuinely unparsed, matching
 * this adapter's own "never look more authoritative than the data
 * actually is" discipline — real, live-observed shapes NOT handled here:
 *   - The literal text "Unknown" (roughly half of the real sample).
 *   - A MISMATCHED range like "$5 - $8K / mo" (only the second number
 *     carries "K" — genuinely ambiguous whether the first means $5 or
 *     $5K; guessing either way risks a wildly wrong number).
 *   - A non-USD currency ("£81.25 - £112.5 / hr" — real, live-observed).
 *   - A trailing qualifier ("$175 - $200 / hr + commission", "$8K - $10K /
 *     mo OTE" — both real, live-observed).
 */
const HOURLY_RANGE_RE = /^\$([\d,]+(?:\.\d+)?)\s*-\s*\$([\d,]+(?:\.\d+)?)\s*\/\s*hr$/;
const MONTHLY_K_RANGE_RE = /^\$([\d,]+(?:\.\d+)?)K\s*-\s*\$([\d,]+(?:\.\d+)?)K\s*\/\s*mo$/;
function parseCompensationRange(text: string | undefined): { min?: number; max?: number; unit?: "hour" | "month" } {
  if (text === undefined) return {};
  const trimmed = text.trim();
  const hourly = HOURLY_RANGE_RE.exec(trimmed);
  if (hourly) return { min: Number(hourly[1]!.replace(/,/g, "")), max: Number(hourly[2]!.replace(/,/g, "")), unit: "hour" };
  const monthly = MONTHLY_K_RANGE_RE.exec(trimmed);
  if (monthly) return { min: Number(monthly[1]!.replace(/,/g, "")) * 1000, max: Number(monthly[2]!.replace(/,/g, "")) * 1000, unit: "month" };
  return {};
}

/** Pure parse of one listing's own detail-page HTML — see FractionalJobsDetail's own doc comment for the real, live-verified markup this reads. */
function parseFractionalJobsDetail(html: string): FractionalJobsDetail {
  const closedBannerClassSuffix = DETAIL_CLOSED_BANNER_RE.exec(html)?.[1];
  const status: FractionalJobsDetail["status"] =
    closedBannerClassSuffix === undefined ? undefined : closedBannerClassSuffix.includes("w-condition-invisible") ? "open" : "closed";

  const weeklyHours = parseWeeklyCommitment(DETAIL_WEEKLY_COMMITMENT_RE.exec(html)?.[1]);
  const compensation = parseCompensationRange(DETAIL_COMPENSATION_RANGE_RE.exec(html)?.[1]);

  return { status, rateMin: compensation.min, rateMax: compensation.max, rateUnit: compensation.unit, weeklyHours };
}

/** Best-effort single detail-page fetch — a network error, non-ok response, or any other failure degrades to `undefined` (never throws, never blocks the list-page scan this rides along with). */
async function fetchFractionalJobsDetail(url: string): Promise<FractionalJobsDetail | undefined> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "text/html" } });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  return parseFractionalJobsDetail(await res.text());
}

/**
 * Bounded/lazy DETAIL-page fetch — same mechanism as fractionus.ts's own
 * `selectDetailFetchCandidates()` (see its doc comment for the full
 * reasoning: 469 fractionus+fractionaljobs listings combined, lazy-after-
 * tiering, closed-detection needing recurring re-checks). Unlike
 * fractionus.ts, this is NOT gated on "the card lacks a rate" — this
 * fetch's real job is closed-detection (there's no free list-card signal
 * for that on this board, see file-level comment), so every green/yellow,
 * not-yet-archived/ignored listing is eligible every cycle, capped at
 * `MAX_DETAIL_FETCHES_PER_SCAN`.
 */
const MAX_DETAIL_FETCHES_PER_SCAN = 15;
const DETAIL_FETCH_CONCURRENCY = 3;

function selectDetailFetchCandidates(items: FractionalJobsItem[], stored: ReadonlyMap<string, StoredGig>): FractionalJobsItem[] {
  const eligible = items.filter((item) => {
    const g = stored.get(item.externalId);
    if (!g) return false;
    if (g.status === "archived" || g.status === "ignored") return false;
    return g.tier === "green" || g.tier === "yellow";
  });
  return eligible.slice(0, MAX_DETAIL_FETCHES_PER_SCAN);
}

/** Fixed-size concurrency window, same shape as builtin.ts's own fetchDetailDescriptions() / fractionus.ts's own fetchDetailsBounded(). */
async function fetchDetailsBounded(items: FractionalJobsItem[]): Promise<Map<string, FractionalJobsDetail | undefined>> {
  const results = new Map<string, FractionalJobsDetail | undefined>();
  for (let i = 0; i < items.length; i += DETAIL_FETCH_CONCURRENCY) {
    const batch = items.slice(i, i + DETAIL_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(batch.map((item) => fetchFractionalJobsDetail(item.url)));
    batch.forEach((item, idx) => results.set(item.externalId, batchResults[idx]));
  }
  return results;
}

/**
 * "Cache permanently once fetched" — same reasoning as fractionus.ts's own
 * `mergeEnrichment()`: `upsertOne()` (store/gigs.ts) always overwrites
 * every column, so a scan cycle that does NOT (re-)learn a given gig's
 * rate/hours must still carry forward its previously-learned value rather
 * than blanking it back to NULL. Precedence: this cycle's own list-card
 * parse (freshest, free) first, then this cycle's own bounded detail-page
 * fetch (only for today's candidates), then whatever was already stored.
 */
function mergeEnrichment(
  item: FractionalJobsItem,
  detail: FractionalJobsDetail | undefined,
  stored: StoredGig | undefined,
): Pick<Gig, "rate" | "weeklyHours"> {
  const rate =
    item.cardRate.min !== undefined
      ? { min: item.cardRate.min, max: item.cardRate.max, unit: item.cardRate.unit! }
      : detail?.rateMin !== undefined && detail.rateUnit !== undefined
        ? { min: detail.rateMin, max: detail.rateMax, unit: detail.rateUnit }
        : stored?.rate;
  return { rate, weeklyHours: item.cardWeeklyHours ?? detail?.weeklyHours ?? stored?.weeklyHours };
}

function toGig(item: FractionalJobsItem, enrichment: Pick<Gig, "rate" | "weeklyHours">): Gig {
  return {
    sourceId: "fractionaljobs",
    externalId: item.externalId,
    title: item.title,
    company: item.company,
    // The real per-listing page (this card's own /jobs/<slug> permalink),
    // never the root jobs-list url itself.
    url: item.url,
    rate: enrichment.rate,
    weeklyHours: enrichment.weeklyHours,
    remote: toRemote(item.location),
    postedAt: toPostedAt(item.dateText),
    raw: item,
  };
}

async function fetchJobsHtml(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(JOBS_URL, { headers: { accept: "text/html" } });
  } catch (e) {
    throw new Error(
      `fractionaljobs: network error fetching ${JOBS_URL}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`fractionaljobs: fetch failed for ${JOBS_URL}: HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  // Sanity check this is really FractionalJobs' live-jobs container and not,
  // say, an error/interstitial page — mirrors builtin.ts's #jobs-list shape
  // check, just for this site's own container id.
  if (!html.includes('id="live-jobs"')) {
    throw new Error(`fractionaljobs: unexpected response shape from ${JOBS_URL} (no #live-jobs container)`);
  }
  return html;
}

export const fractionalJobsSource: Source = {
  id: "fractionaljobs",
  label: "FractionalJobs",
  auth: "none",
  async fetch(_cfg: SourceConfig): Promise<Gig[]> {
    const html = await fetchJobsHtml();
    const cards = splitJobCards(html);
    const items = cards.map(parseCard).filter((x): x is FractionalJobsItem => x !== null);

    // The page had job-item markers but every single one failed to yield a
    // valid item — that's a real parsing break (markup drift), not a
    // legitimately empty board. Throw instead of silently returning [] —
    // matches builtin.ts's real two-tier throw/return-[] split exactly (a
    // page that loads fine with #live-jobs present but zero cards at all is
    // NOT this branch — see below).
    if (cards.length > 0 && items.length === 0) {
      throw new Error(`fractionaljobs: found ${cards.length} job card(s) but could not parse any of them`);
    }

    // Dedup by externalId within this single page (defensive, mirrors
    // builtin.ts/braintrust.ts even though FractionalJobs is not observed to
    // repeat a listing on its one page).
    const byId = new Map<string, FractionalJobsItem>();
    for (const item of items) byId.set(item.externalId, item);
    const dedupedItems = [...byId.values()];

    // Bounded/lazy detail-page enrichment + closed-detection — see
    // selectDetailFetchCandidates()'s own doc comment for the real bound.
    const storedByExternalId = new Map(listGigs({ sourceId: "fractionaljobs" }).map((g) => [g.externalId, g]));
    const candidates = selectDetailFetchCandidates(dedupedItems, storedByExternalId);
    const details = candidates.length > 0 ? await fetchDetailsBounded(candidates) : new Map<string, FractionalJobsDetail | undefined>();

    // A listing whose detail page confirms Closed is simply omitted here —
    // the EXISTING recordScan() delisting sweep (store/gigs.ts) treats
    // "returned by the source but missing from this scan's own results" as
    // a real closure signal and does the actual archival; see file-level
    // comment.
    const openItems = dedupedItems.filter((item) => details.get(item.externalId)?.status !== "closed");

    // cards.length === 0 (container present, genuinely zero listings right
    // now) falls through here too, correctly returning [] rather than
    // throwing.
    return openItems.map((item) =>
      toGig(item, mergeEnrichment(item, details.get(item.externalId), storedByExternalId.get(item.externalId))),
    );
  },
};

registerSource(fractionalJobsSource);
