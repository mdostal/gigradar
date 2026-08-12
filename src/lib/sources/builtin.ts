import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";

/**
 * BuiltIn (builtin.com) — a public, no-login tech job board.
 *
 * Unlike Braintrust, BuiltIn has no accessible unauthenticated JSON API
 * (confirmed live while building this adapter: `api.builtin.com` exists but
 * its root responds `catch-all-external` and no XHR/fetch call to a JSON
 * endpoint was ever observed backing the job list). What it DOES have is a
 * plain server-rendered HTML page at `/jobs/{category}` — no client-side
 * rendering step required: a bare Node `fetch()` with zero special headers
 * returns full real listing data (id, title, company, comp range, work
 * type, posted time, description) baked directly into the HTML, confirmed
 * live against the real site (see the "manual live verification" note in
 * this story's commit message for the exact run). So this is the SPA-vs-API
 * fork Braintrust's own doc comment calls out — BuiltIn lands on the other
 * side of it (plain HTML, not a JSON API), but is still a legitimate,
 * dependency-free `fetch()` target: `auth: "none"` is accurate here too.
 *
 * Parsing is done with targeted regexes over the raw HTML rather than a DOM
 * library (no HTML-parsing dependency exists in this repo yet) — brittle in
 * the sense that a markup rewrite on BuiltIn's end would break it, but that
 * risk is identical in kind to Braintrust's JSON-shape assumption breaking
 * on an API change; both are guarded by throwing on an unrecognized shape
 * rather than silently returning [].
 *
 * Deliberately single-page (no `?page=N` pagination): BuiltIn's own
 * robots.txt disallows `*?page=` for the generic `User-agent: *` bots
 * (verified live at https://builtin.com/robots.txt while building this
 * adapter — only named AI crawlers like GPTBot get an explicit `Allow:
 * /jobs*` that covers query strings, and this adapter doesn't spoof being
 * one of those). Respecting that is a deliberate scope limit, not a
 * technical one: each scan sees the ~25 listings BuiltIn puts on page 1 of
 * the chosen category, refreshed every run.
 */

const JOBS_BASE = "https://builtin.com";

/**
 * BuiltIn's own job-category taxonomy (from its `/jobs/{category}` nav)
 * puts software/dev roles under "dev-engineering" — the closest single
 * category to "engineering-type roles". Callers can override via
 * `SourceConfig.settings.category` (e.g. "data-analytics").
 */
const DEFAULT_CATEGORY = "dev-engineering";

interface BuiltinListItem {
  id: string;
  url: string; // absolute, e.g. https://builtin.com/job/{slug}/{id}
  title: string;
  company?: string;
  workType?: string; // "Remote" | "Hybrid" | "In-Office" | "Remote or Hybrid" | "In-Office or Remote" (observed live)
  salaryText?: string; // e.g. "265K-311K Annually" | "61-119 Hourly"
  postedText?: string; // e.g. "21 Minutes Ago" | "Reposted Yesterday"
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

/** Minimal HTML-entity decoder — enough for BuiltIn's card text (titles, company names, bullet-separated tags). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => NAMED_ENTITIES[name] ?? "");
}

/**
 * Splits the jobs-list HTML into one raw HTML chunk per job card, using
 * each card's own `id="job-card-{id}"` marker as the boundary. The last
 * card's chunk runs to end-of-document (harmless: field regexes below only
 * take their first match, which always occurs within that card's own
 * markup before the next card's fields would appear in the real page).
 */
function splitJobCards(html: string): string[] {
  const starts: number[] = [];
  const re = /<div id="job-card-\d+"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) starts.push(m.index);
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

function matchText(card: string, re: RegExp, group = 1): string | undefined {
  const m = re.exec(card);
  const value = m?.[group];
  return value === undefined ? undefined : decodeEntities(value).trim();
}

function parseCard(card: string): BuiltinListItem | null {
  const id = matchText(card, /id="job-card-(\d+)"/);
  const titleMatch = /href="(\/job\/[^"]+)"[^>]*data-id="job-card-title"[^>]*>([^<]+)</.exec(card);
  const titleHref = titleMatch?.[1];
  const titleText = titleMatch?.[2];
  if (!id || titleHref === undefined || titleText === undefined) return null; // can't build a valid Gig without an id, url and title

  const company = matchText(card, /data-id="company-title"[^>]*><span>([^<]+)<\/span>/);
  const workType = matchText(
    card,
    /fa-house-building[^<]*<\/i><\/div>\s*<span class="font-barlow text-gray-04">([^<]+)<\/span>/,
  );
  const salaryText = matchText(
    card,
    /fa-sack-dollar[^<]*<\/i><\/div>\s*<span class="font-barlow text-gray-04">([^<]+)<\/span>/,
  );
  const postedText = matchText(card, /fa-clock fs-xs text-gray-03[^>]*><\/i>([^<]+)/);
  const description = matchText(card, /<div class="fs-sm fw-regular mb-md text-gray-04">([^<]*)<\/div>/);

  return {
    id,
    url: `${JOBS_BASE}${decodeEntities(titleHref)}`,
    title: decodeEntities(titleText).trim(),
    company,
    workType,
    salaryText,
    postedText,
    description,
  };
}

/** "Remote" -> true, "In-Office" -> false. Anything mixed (Hybrid, "Remote or Hybrid", "In-Office or Remote") or missing is left unknown rather than guessed. */
function toRemote(workType: string | undefined): boolean | undefined {
  if (workType === "Remote") return true;
  if (workType === "In-Office") return false;
  return undefined;
}

const SALARY_RE = /^(\d+)(K)?-(\d+)(K)?\s+(Annually|Hourly)$/;

/** BuiltIn's list-card salary is always "N(K)-N(K) Annually|Hourly" (observed live) or absent entirely. */
function toRate(salaryText: string | undefined): Gig["rate"] {
  if (!salaryText) return undefined;
  const m = SALARY_RE.exec(salaryText);
  if (!m) return undefined;
  const scale = (k: string | undefined) => (k ? 1000 : 1);
  const min = Number(m[1]) * scale(m[2]);
  const max = Number(m[3]) * scale(m[4]);
  const unit = m[5] === "Annually" ? "year" : "hour";
  return { min, max, unit };
}

const RELATIVE_POSTED_RE =
  /^(?:Reposted\s+)?(?:(Today)|(Yesterday)|(\d+)\s+(Minute|Hour|Day|Week|Month)s?\s+Ago)$/i;

/**
 * BuiltIn's list card never shows an absolute posted date, only a relative
 * string ("21 Minutes Ago", "Reposted Yesterday", "Reposted 3 Days Ago",
 * ...) computed against whenever the page was rendered. Converts that to an
 * ISO date relative to `now` (the real fetch time) rather than fabricating
 * a fixed date — an unparseable string leaves postedAt unset (unknown), not
 * guessed.
 */
function toPostedAt(postedText: string | undefined, now: Date): string | undefined {
  if (!postedText) return undefined;
  const m = RELATIVE_POSTED_RE.exec(postedText.trim());
  if (!m) return undefined;

  const d = new Date(now.getTime());
  if (m[2]) {
    d.setUTCDate(d.getUTCDate() - 1); // Yesterday
  } else if (m[3] && m[4]) {
    const n = Number(m[3]);
    switch (m[4].toLowerCase()) {
      case "minute":
        d.setUTCMinutes(d.getUTCMinutes() - n);
        break;
      case "hour":
        d.setUTCHours(d.getUTCHours() - n);
        break;
      case "day":
        d.setUTCDate(d.getUTCDate() - n);
        break;
      case "week":
        d.setUTCDate(d.getUTCDate() - n * 7);
        break;
      case "month":
        d.setUTCMonth(d.getUTCMonth() - n);
        break;
    }
  }
  // else: "Today" — d already equals now.
  return d.toISOString().slice(0, 10);
}

function toGig(item: BuiltinListItem, now: Date): Gig {
  return {
    sourceId: "builtin",
    externalId: item.id,
    title: item.title,
    company: item.company,
    // The real per-listing page (BuiltIn's own `/job/{slug}/{id}` permalink
    // baked into the card by the server), never a search/category URL.
    url: item.url,
    rate: toRate(item.salaryText),
    // BuiltIn's list card exposes neither weekly hours nor a contract-to-hire
    // concept at all — left unset (unknown) rather than guessed.
    remote: toRemote(item.workType),
    postedAt: toPostedAt(item.postedText, now),
    description: item.description,
    raw: item,
  };
}

function categoryFrom(cfg: SourceConfig): string {
  const configured = cfg.settings?.category;
  return typeof configured === "string" && configured.length > 0 ? configured : DEFAULT_CATEGORY;
}

async function fetchCategoryHtml(category: string): Promise<string> {
  const url = `${JOBS_BASE}/jobs/${category}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "text/html" } });
  } catch (e) {
    throw new Error(`builtin: network error fetching ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`builtin: fetch failed for ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  // Sanity check this is really BuiltIn's jobs-list page and not, say, an
  // error/interstitial page — mirrors Braintrust's isBraintrustJobsPage
  // shape check, just for HTML instead of JSON.
  if (!html.includes('id="jobs-list"')) {
    throw new Error(`builtin: unexpected response shape from ${url} (no #jobs-list container)`);
  }
  return html;
}

export const builtinSource: Source = {
  id: "builtin",
  label: "BuiltIn",
  auth: "none",
  async fetch(cfg: SourceConfig): Promise<Gig[]> {
    const category = categoryFrom(cfg);
    const html = await fetchCategoryHtml(category);
    const cards = splitJobCards(html);

    const now = new Date();
    const items = cards.map(parseCard).filter((x): x is BuiltinListItem => x !== null);

    // The page had job-card markers but every single one failed to yield a
    // valid item — that's a real parsing break (markup drift), not a
    // legitimately empty category. Throw instead of silently returning [].
    if (cards.length > 0 && items.length === 0) {
      throw new Error(`builtin: found ${cards.length} job card(s) but could not parse any of them`);
    }

    // Dedup by id within this single page (BuiltIn is not observed to repeat
    // a listing on one page, but keep the same defensive dedup Braintrust
    // uses across its pages).
    const byId = new Map<string, BuiltinListItem>();
    for (const item of items) byId.set(item.id, item);

    return [...byId.values()].map((item) => toGig(item, now));
  },
};

registerSource(builtinSource);
