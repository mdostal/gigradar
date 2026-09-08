import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";

/**
 * Axial Search (axialsearch.com) — a public, no-login executive-search
 * jobs board specializing in AI-transformation leadership hires (both
 * traditional full-time roles and fractional/part-time engagements).
 * Owner's own direction (2026-09-08): "add axial search to the job
 * board, this seems another solid fractional finder."
 *
 * Live-verified: a plain `curl` with no special headers/User-Agent
 * returns the exact same server-rendered HTML as a browser session — no
 * client-side rendering step needed. `/jobs` (this adapter's target) is
 * NOT in `robots.txt`'s `Disallow` list (only `/profile`, `/applications`,
 * `/onboarding`, `/auth/`, and `/api/` are — this is a Next.js app with
 * genuinely authenticated candidate-portal routes behind those paths, and
 * `/jobs` is explicitly public). `auth: "none"`: a bare `fetch()` with
 * only `{accept: "text/html"}`, matching this project's other `auth:
 * "none"` boards (fractionus.ts/fractionaljobs.ts/fractionalfinders.ts) —
 * no User-Agent spoofing.
 *
 * REAL, live-confirmed pagination: `/jobs?page=N` returns 10 real,
 * distinct listings per page (confirmed: page 1 and page 2 have zero
 * externalId overlap), and the first page with zero listings reliably
 * marks the end (confirmed live: a real 56-listing board across pages
 * 1-6, page 6 returning exactly the remaining 6, page 7 returning 0) — no
 * hardcoded page-count assumption, this adapter simply pages until an
 * empty page, capped defensively at `MAX_PAGES` in case pagination ever
 * breaks and starts looping.
 *
 * Parsed with targeted regexes over the raw HTML (no HTML-parsing
 * dependency exists in this repo), same accepted brittleness/throw-on-
 * unrecognized-shape convention as every other hand-written adapter here.
 *
 * The list card exposes NO company name at all (live-confirmed against
 * every real card fetched) — Axial is a specialist search firm posting on
 * behalf of confidential/anonymous end clients, so `company` is left
 * genuinely unset rather than guessed or backfilled with "Axial Search"
 * itself (which is the recruiting firm, not the real employer — confirmed
 * by reading a real detail page's own JobPosting JSON-LD, whose
 * `hiringOrganization.name` is likewise just "Axial Search" for every
 * listing). Similarly, the list card carries no remote/on-site indicator
 * (only a country-level location, e.g. "United States", "Canada") — left
 * unset rather than guessed.
 *
 * The card's own salary text distinguishes fractional from full-time
 * roles unambiguously and for free: "$140 – $590 per hour" (fractional,
 * hourly) vs "$210k – $380k" (full-time, annual, thousands) — no
 * detail-page fetch needed for `employmentType`/`rate`. This adapter
 * deliberately does NOT do a bounded lazy detail-page fetch (unlike
 * fractionus.ts/fractionaljobs.ts) — there is no closed/filled signal on
 * this board's list card OR detail page to justify one yet; if that need
 * ever surfaces (e.g. a real stale-listing bug report), a detail-page
 * enrichment pass can be added the same way those two adapters' own
 * follow-up stories did, reusing the real `application/ld+json`
 * `JobPosting` block already confirmed present on the detail page (far
 * more reliable than a second round of markup regexes).
 */

const SITE = "https://axialsearch.com";
const JOBS_PATH = "/jobs";

/** Defensive cap on how many pages this adapter will ever walk in one fetch() call — see file-level comment. Real board size at build time was 56 listings across 6 pages; this leaves ample headroom for real growth while still bounding a broken-pagination loop. */
const MAX_PAGES = 30;

interface AxialSearchItem {
  /** The `/jobs/<slug>` path's slug, also this Gig's stable externalId. */
  externalId: string;
  url: string; // absolute per-listing url
  title: string;
  /** Country-level location text, e.g. "United States", "Canada". */
  location?: string;
  /** e.g. "$210k – $380k" (full-time, annual) or "$140 – $590 per hour" (fractional). */
  salaryText?: string;
  /** e.g. "Today" | "7 days ago" | "30+ days ago". */
  postedText?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Minimal HTML-entity decoder — same shape/duplication convention as this project's other adapters (see fractionus.ts's own doc comment on why each keeps its own small copy). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => NAMED_ENTITIES[name] ?? "");
}

/**
 * Splits one page's jobs-list HTML into one raw HTML chunk per job card,
 * using each card's own `<a class="jr" href="/jobs/...">` opening tag as
 * the boundary — same slice-to-next-marker-or-end approach as this
 * project's other adapters' `splitJobCards()`.
 */
function splitJobCards(html: string): string[] {
  const starts: number[] = [];
  const re = /<a class="jr" href="\/jobs\/[^"]+">/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) starts.push(m.index);
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

const HREF_RE = /^<a class="jr" href="(\/jobs\/[^"]+)">/;
const TITLE_RE = /<h3 class="jr-title">([^<]*)<\/h3>/;
const LOCATION_RE = /<p class="jr-loc-wide">([^<]*)<\/p>/;
const SALARY_RE = /<div class="jr-salary">([^<]*)<\/div>/;
const POSTED_RE = /<div class="jr-posted">([^<]*)<\/div>/;

function parseCard(card: string): AxialSearchItem | null {
  const href = HREF_RE.exec(card)?.[1];
  const title = TITLE_RE.exec(card)?.[1];
  if (href === undefined || title === undefined || title.trim().length === 0) return null; // can't build a valid Gig without a url and a title

  const externalId = /^\/jobs\/([^/?#]+)/.exec(href)?.[1];
  if (!externalId) return null;

  const locationRaw = LOCATION_RE.exec(card)?.[1];
  const salaryRaw = SALARY_RE.exec(card)?.[1];
  const postedRaw = POSTED_RE.exec(card)?.[1];

  return {
    externalId,
    url: `${SITE}${decodeEntities(href)}`,
    title: decodeEntities(title).trim(),
    location: locationRaw ? decodeEntities(locationRaw).trim() : undefined,
    salaryText: salaryRaw ? decodeEntities(salaryRaw).trim() : undefined,
    postedText: postedRaw ? decodeEntities(postedRaw).trim() : undefined,
  };
}

// "$210k – $380k" (annual, thousands) or "$140 – $590 per hour" (hourly) —
// the only two real shapes observed across a live 56-listing sample. Uses
// an en dash ("–", U+2013), not a hyphen, matching the site's own real
// markup exactly.
const SALARY_RE_PARSE = /^\$([\d,]+)(k)?\s*–\s*\$([\d,]+)(k)?(?:\s*(per hour))?$/i;

/** Unrecognized text (a shape this adapter hasn't seen live) leaves rate unset rather than guessed. */
function toRate(salaryText: string | undefined): Gig["rate"] {
  if (!salaryText) return undefined;
  const m = SALARY_RE_PARSE.exec(salaryText);
  if (!m) return undefined;
  const scale = (k: string | undefined) => (k ? 1000 : 1);
  const min = Number(m[1]!.replace(/,/g, "")) * scale(m[2]);
  const max = Number(m[3]!.replace(/,/g, "")) * scale(m[4]);
  const unit = m[5] ? "hour" : "year";
  return { min, max, unit };
}

/** The same "per hour" suffix toRate() reads doubles as this board's own free, honest fractional-vs-full-time signal — see file-level comment. Unrecognized/missing salary text leaves this unset rather than guessed. */
function toEmploymentType(salaryText: string | undefined): Gig["employmentType"] {
  if (!salaryText) return undefined;
  const m = SALARY_RE_PARSE.exec(salaryText);
  if (!m) return undefined;
  return m[5] ? "fractional" : "full-time";
}

const RELATIVE_POSTED_RE = /^(?:(Today)|(\d+)\+?\s+Days?\s+Ago)$/i;

/**
 * Axial's list card never shows an absolute posted date, only a relative
 * string computed against whenever the page was rendered — "Today", "N
 * Days Ago", or "30+ Days Ago" (the trailing "+" is optional in the regex
 * so that last shape matches too, treated as exactly 30 days — a safe
 * lower bound, never guessed higher). Converts to an ISO date relative to
 * `now` (the real fetch time), same convention as builtin.ts's own
 * toPostedAt(). An unparseable string leaves postedAt unset (unknown).
 */
function toPostedAt(postedText: string | undefined, now: Date): string | undefined {
  if (!postedText) return undefined;
  const m = RELATIVE_POSTED_RE.exec(postedText.trim());
  if (!m) return undefined;

  const d = new Date(now.getTime());
  if (!m[1]) {
    d.setUTCDate(d.getUTCDate() - Number(m[2]));
  }
  return d.toISOString().slice(0, 10);
}

async function fetchJobsPage(page: number): Promise<string> {
  const url = page === 1 ? `${SITE}${JOBS_PATH}` : `${SITE}${JOBS_PATH}?page=${page}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "text/html" } });
  } catch (e) {
    throw new Error(`axialsearch: network error fetching ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`axialsearch: fetch failed for ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  // Sanity check this is really Axial's own jobs page and not, say, an
  // error/interstitial page — mirrors this project's other adapters' own
  // shape checks, against this site's own real page <title>.
  if (!html.includes("<title>AI Transformation Jobs | Axial Search</title>")) {
    throw new Error(`axialsearch: unexpected response shape from ${url} (jobs-page title not found)`);
  }
  return html;
}

function toGig(item: AxialSearchItem, now: Date): Gig {
  return {
    sourceId: "axialsearch",
    externalId: item.externalId,
    title: item.title,
    // No company field anywhere on this board — see file-level comment.
    url: item.url,
    rate: toRate(item.salaryText),
    employmentType: toEmploymentType(item.salaryText),
    postedAt: toPostedAt(item.postedText, now),
    // item.location (country-level only, e.g. "United States") has no
    // dedicated Gig field to map to — carried here for debugging/future
    // use, same convention as every other adapter's own raw passthrough.
    raw: item,
  };
}

export const axialSearchSource: Source = {
  id: "axialsearch",
  label: "Axial Search",
  auth: "none",
  // No known application-format signal researched yet for this board (a
  // real per-listing detail-page apply flow would need to be checked
  // live) — left unset, falls through to the documented "cover-letter"
  // default rather than guessed.
  async fetch(_cfg: SourceConfig): Promise<Gig[]> {
    const now = new Date();
    const allItems: AxialSearchItem[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const html = await fetchJobsPage(page);
      const cards = splitJobCards(html);
      if (cards.length === 0) break; // real end-of-results signal — see file-level comment

      const items = cards.map(parseCard).filter((x): x is AxialSearchItem => x !== null);
      // This page had card markers but every single one failed to parse —
      // that's a real parsing break (markup drift), not a legitimately
      // empty page (an empty page has zero card markers, handled above).
      if (items.length === 0) {
        throw new Error(`axialsearch: found ${cards.length} job card(s) on page ${page} but could not parse any of them`);
      }
      allItems.push(...items);
    }

    // Dedup by externalId across pages (defensive, mirrors this project's
    // other adapters even though live pagination showed zero overlap).
    const byId = new Map<string, AxialSearchItem>();
    for (const item of allItems) byId.set(item.externalId, item);

    return [...byId.values()].map((item) => toGig(item, now));
  },
};

registerSource(axialSearchSource);
