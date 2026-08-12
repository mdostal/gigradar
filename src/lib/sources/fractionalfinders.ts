import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";

/**
 * FractionalFinders (fractionalfinders.com) — a public, no-login
 * fractional-executive jobs board. Live-verified during this epic's
 * planning (`.pHive/epics/adapter-batch-public-boards/docs/research-brief.md`
 * §2): a plain `curl` with no special headers/User-Agent returns 16 real
 * `/jobs/<slug>` links baked directly into the server-rendered HTML at
 * `https://www.fractionalfinders.com/jobs` — no client-side rendering step
 * needed. `robots.txt` is empty (no `Disallow` at all) — same
 * ethical-scraping check builtin.ts's own header comment establishes as
 * this project's convention.
 *
 * `auth: "none"`: a bare `fetch()` with only `{accept: "text/html"}` —
 * deliberately NO User-Agent spoofing (live re-verified while building this
 * adapter: identical results with zero special headers, matching
 * builtin.ts's own proven, honest pattern — see this story's
 * design_decisions).
 *
 * Parsed with targeted regexes over the raw HTML (Webflow CMS markup), same
 * approach and accepted brittleness as builtin.ts (no HTML-parsing
 * dependency exists in this repo) — a markup rewrite on FractionalFinders'
 * end would break this adapter; guarded the same way, by throwing on an
 * unrecognized shape rather than silently returning [].
 *
 * This is the SMALLEST of the three boards (16 live listings observed
 * during planning, vs. 63/53 on the other two) — the story's own design
 * decision explicitly calls this out: a genuinely quiet page here (few or
 * zero current listings) is a normal, valid state for this specific board's
 * size, not a sign of breakage, and MUST return `[]`, never throw. Only an
 * actual page-shape failure (the `.job-list-wrapper` container missing
 * entirely, or cards present but zero of them parsing) throws.
 *
 * `rate`/`weeklyHours` are deliberately left `undefined` on every `Gig` —
 * FractionalFinders' list card exposes neither a rate range nor a
 * weekly-hours figure anywhere (confirmed live), matching the legacy
 * tool's own observation that this board doesn't reliably publish either.
 * See this story's design_decisions.
 */

const SITE = "https://www.fractionalfinders.com";
const JOBS_URL = `${SITE}/jobs`;

interface FractionalFindersItem {
  /** The `/jobs/<slug>` path's slug, also this Gig's stable externalId. */
  externalId: string;
  url: string; // absolute per-listing url
  title: string;
  company?: string;
  /** e.g. "Remote" | "Hybrid" | "On-site" — absent on some real cards (confirmed live), left unset rather than guessed when so. */
  arrangement?: string;
  /** e.g. "August 12, 2026" — an ABSOLUTE date, unlike builtin.ts's relative "N days ago" text. */
  dateText?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Minimal HTML-entity decoder — same shape/duplication convention as fractionaljobs.ts's, fractionus.ts's, and builtin.ts's own copies. */
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
 * FractionalFinders' card shows an ABSOLUTE date ("August 12, 2026"), same
 * shape as fractionaljobs.ts's toPostedAt() (duplicated rather than
 * shared — see that file's comment). An unparseable/missing string leaves
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

/** "Remote" -> true, "On-site" -> false. "Hybrid" (genuinely mixed) or missing is left unknown rather than guessed — same convention as builtin.ts's toRemote(). */
function toRemote(arrangement: string | undefined): boolean | undefined {
  if (arrangement === "Remote") return true;
  if (arrangement === "On-site") return false;
  return undefined;
}

/**
 * Splits the jobs-list HTML into one raw HTML chunk per job card, using each
 * card's own `slug="" role="listitem" class="job-items w-dyn-item"` marker
 * as the boundary — same slice-to-next-marker-or-end approach as
 * builtin.ts's splitJobCards().
 */
function splitJobCards(html: string): string[] {
  const starts: number[] = [];
  const re = /<div slug="" role="listitem" class="job-items w-dyn-item">/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) starts.push(m.index);
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

const HREF_RE = /href="(\/jobs\/[^"]+)" class="job-item-wrapper w-inline-block">/;
const COMPANY_RE = /fs-cmsfilter-field="company-name" class="job-item-h3">([^<]*)<\/h3>/;
const TITLE_RE = /fs-cmsfilter-field="job-role" class="job-item-h3">([^<]*)<\/div>/;
const ARRANGEMENT_RE = /fs-cmsfilter-field="job-arrangement">([^<]*)<\/div>/;
const DATE_RE = /post-date-txt">([^<]*)<\/div>/;

function parseCard(card: string): FractionalFindersItem | null {
  const href = HREF_RE.exec(card)?.[1];
  const title = TITLE_RE.exec(card)?.[1];
  if (href === undefined || title === undefined || title.trim().length === 0) return null; // can't build a valid Gig without a url and a title

  const externalId = /^\/jobs\/([^/?#]+)/.exec(href)?.[1];
  if (!externalId) return null;

  const companyRaw = COMPANY_RE.exec(card)?.[1];
  const company = companyRaw ? decodeEntities(companyRaw).trim() : "";

  // The work-arrangement tag is genuinely absent on some real cards
  // (confirmed live) — left undefined rather than guessed, not a parse
  // failure.
  const arrangementRaw = ARRANGEMENT_RE.exec(card)?.[1];
  const dateTextRaw = DATE_RE.exec(card)?.[1];

  return {
    externalId,
    url: `${SITE}${decodeEntities(href)}`,
    title: decodeEntities(title).trim(),
    company: company.length > 0 ? company : undefined,
    arrangement: arrangementRaw ? decodeEntities(arrangementRaw).trim() : undefined,
    dateText: dateTextRaw ? decodeEntities(dateTextRaw).trim() : undefined,
  };
}

function toGig(item: FractionalFindersItem): Gig {
  return {
    sourceId: "fractionalfinders",
    externalId: item.externalId,
    title: item.title,
    company: item.company,
    // The real per-listing page (this card's own /jobs/<slug> permalink),
    // never the /jobs search/listing page itself.
    url: item.url,
    // rate/weeklyHours deliberately omitted (left unset/unknown) — see
    // file-level comment.
    remote: toRemote(item.arrangement),
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
      `fractionalfinders: network error fetching ${JOBS_URL}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`fractionalfinders: fetch failed for ${JOBS_URL}: HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  // Sanity check this is really FractionalFinders' own jobs-list container
  // and not, say, an error/interstitial page — mirrors builtin.ts's
  // #jobs-list shape check, just for this site's own wrapper class.
  if (!html.includes('class="job-list-wrapper"')) {
    throw new Error(`fractionalfinders: unexpected response shape from ${JOBS_URL} (no .job-list-wrapper container)`);
  }
  return html;
}

export const fractionalFindersSource: Source = {
  id: "fractionalfinders",
  label: "FractionalFinders",
  auth: "none",
  async fetch(_cfg: SourceConfig): Promise<Gig[]> {
    const html = await fetchJobsHtml();
    const cards = splitJobCards(html);
    const items = cards.map(parseCard).filter((x): x is FractionalFindersItem => x !== null);

    // The page had job-items markers but every single one failed to yield a
    // valid item — that's a real parsing break (markup drift), not a
    // legitimately quiet board. Throw instead of silently returning [] —
    // matches builtin.ts's real two-tier throw/return-[] split exactly. A
    // page that loads fine with .job-list-wrapper present but few or zero
    // cards at all (this board only had 16 live listings during planning —
    // see file-level comment) is NOT this branch: it falls through to the
    // return below, correctly as [].
    if (cards.length > 0 && items.length === 0) {
      throw new Error(`fractionalfinders: found ${cards.length} job card(s) but could not parse any of them`);
    }

    // Dedup by externalId within this single page (defensive, mirrors
    // builtin.ts/braintrust.ts).
    const byId = new Map<string, FractionalFindersItem>();
    for (const item of items) byId.set(item.externalId, item);

    return [...byId.values()].map(toGig);
  },
};

registerSource(fractionalFindersSource);
