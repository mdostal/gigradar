import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";

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
 * `rate`/`weeklyHours` are deliberately left `undefined` on every `Gig` —
 * Fractionus' list card exposes neither a rate range nor a weekly-hours
 * figure anywhere (confirmed live), matching the legacy tool's own
 * observation that this board doesn't reliably publish either. See this
 * story's design_decisions.
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
// "category-link-copy-c" tags (status/industry badges, not parsed here).
const CATEGORY_LINK_RE = /blog-post4-header_category-link w-container">\s*<div class="text-block-32 text-size-tiny">([^<]*)<\/div>/g;

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
  };
}

function toGig(item: FractionusItem): Gig {
  return {
    sourceId: "fractionus",
    externalId: item.externalId,
    title: item.title,
    company: item.company,
    // The real per-listing page (this card's own /jobs/<slug> permalink),
    // never the /jobs search/listing page itself.
    url: item.url,
    // rate/weeklyHours deliberately omitted (left unset/unknown) — see
    // file-level comment.
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

    // cards.length === 0 (jobs-page heading present, genuinely zero
    // listings right now) falls through here too, correctly returning []
    // rather than throwing.
    return [...byId.values()].map(toGig);
  },
};

registerSource(fractionusSource);
