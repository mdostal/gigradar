import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";

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
 * `rate`/`weeklyHours` are deliberately left `undefined` on every `Gig`:
 * although SOME cards do show an hourly range ("$150 - $200 / hr") and a
 * weekly-hours range ("10 - 20 hrs"), plenty of others show neither — the
 * legacy tool this adapter is ported from marks its own FractionalJobs
 * output `_flagOnly: true` for exactly this reason (never reliable enough
 * to auto-apply against). Partially populating a structured field from an
 * inconsistent source risks looking more authoritative than the data
 * actually is — see this story's design_decisions.
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
  // work-arrangement/location text (hours and rate, when present, come
  // first — deliberately not parsed, see file-level comment).
  let location: string | undefined;
  const moreInfo = MORE_INFO_RE.exec(card)?.[1];
  if (moreInfo) {
    const fields = [...moreInfo.matchAll(TEXT_INLINE_RE)].map((f) => decodeEntities(f[1] ?? "").trim());
    location = fields.length > 0 ? fields[fields.length - 1] : undefined;
  }

  const dateTextRaw = DATE_RE.exec(card)?.[1];

  return {
    externalId,
    url: `${SITE}${decodeEntities(href)}`,
    title: decodeEntities(title).trim(),
    company: company.length > 0 ? company : undefined,
    location,
    dateText: dateTextRaw ? decodeEntities(dateTextRaw).trim() : undefined,
  };
}

function toGig(item: FractionalJobsItem): Gig {
  return {
    sourceId: "fractionaljobs",
    externalId: item.externalId,
    title: item.title,
    company: item.company,
    // The real per-listing page (this card's own /jobs/<slug> permalink),
    // never the root jobs-list url itself.
    url: item.url,
    // rate/weeklyHours deliberately omitted (left unset/unknown) — see
    // file-level comment.
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

    // cards.length === 0 (container present, genuinely zero listings right
    // now) falls through here too, correctly returning [] rather than
    // throwing.
    return [...byId.values()].map(toGig);
  },
};

registerSource(fractionalJobsSource);
