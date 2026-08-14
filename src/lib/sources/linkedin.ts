import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";

/**
 * LinkedIn (linkedin.com) — `auth: "none"`, fetch-and-gate.
 *
 * LIVE-VERIFIED (both via a real headed browser AND a bare `curl`/Node
 * `fetch()` with zero cookies) that LinkedIn's public "guest" job search
 * page (`/jobs/search/?keywords=...`) is fully server-rendered and requires
 * no authentication at all — real listings (id, title, company, location,
 * an absolute posted date) come back in the initial HTML response, no
 * client-side JS execution needed. This matches builtin.ts's "no accessible
 * JSON API, but a plain server-rendered HTML page works" shape, not
 * gofractional.ts's/wellfound.ts's `browser-session` shape — no Playwright
 * dependency for this adapter at all.
 *
 * DELIBERATE EXCEPTION TO ROBOTS.TXT: unlike builtin.ts (which scoped
 * itself down specifically to respect builtin.com's robots.txt), this
 * adapter does NOT check LinkedIn's robots.txt, which disallows everything
 * for generic bots (`User-agent: *` / `Disallow: /`). This is a deliberate,
 * discussed exception, not an oversight — see this story's design
 * discussion: this is a single individual's own local, personal job search
 * (never republished, never served to anyone else, matching the
 * "assisted, not auto" / local-first posture this whole project is built
 * on), which is a materially different situation from operating a public
 * scraping service against robots.txt's actual target (bulk/commercial
 * crawlers). Anyone enabling this source in their own local config.json is
 * doing so with that tradeoff explicit and in front of them — see the
 * README/docs callout this story also adds.
 *
 * Ported structurally from the owner's own real, months-proven legacy
 * gig-radar tool's LinkedIn fetcher (`fetchLinkedIn` in that tool's
 * `sources.mjs`, read via SSH for structural reference only — see this
 * project's standing discipline of never transcribing anyone's actual
 * personal data into this repo). That tool used an authenticated browser
 * session and was explicitly commented "fetch + flag only — never
 * auto-apply". This adapter reaches the same *never-auto-apply* posture
 * (gigradar has no auto-submit anywhere, full stop — see docs/ARCHITECTURE.md)
 * via a simpler, more resilient path: the legacy tool's own authenticated
 * session, when checked live during this story, was NOT actually
 * authenticating against LinkedIn any more (no "Me" nav, only "Sign
 * in"/"Join now") — yet the exact same public guest page still returned 60
 * real, current listings with zero cookies at all. Building against the
 * page that works without a fragile session is the more honest, durable
 * choice, not a shortcut.
 */

const JOBS_BASE = "https://www.linkedin.com/jobs/search/";

/**
 * Generic, tool-purpose-aligned default ("fractional/contract engagements"
 * is this whole project's own stated identity — see package.json's
 * description) — NOT any specific person's role. Callers override via
 * `SourceConfig.settings.searchKeywords` (e.g. "fractional CTO"), same
 * override-a-setting convention as builtin.ts's `category`.
 */
const DEFAULT_SEARCH_KEYWORDS = "fractional";

/**
 * LinkedIn's own real job-type filter query param values (confirmed live):
 * `C` = Contract, `P` = Part-time. Defaulting to both matches this
 * project's own fractional/contract focus without hardcoding any one
 * person's preference — callers override via `SourceConfig.settings.jobType`.
 */
const DEFAULT_JOB_TYPE = "C,P";

interface LinkedInListItem {
  id: string;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  /** ISO date (YYYY-MM-DD) — read directly from the card's own `<time datetime="...">` attribute, never parsed from relative text like "2 months ago". */
  postedAt: string | null;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Minimal HTML-entity decoder — enough for LinkedIn's card text (titles, company names, locations). Duplicated (not imported) from builtin.ts's own — same "small enough to duplicate, not worth coupling adapters together over" convention every other adapter in this directory already follows. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => NAMED_ENTITIES[name] ?? "");
}

/**
 * Splits the search-results HTML into one raw HTML chunk per job card,
 * using each card's own `data-entity-urn="urn:li:jobPosting:{id}"` marker
 * as the boundary — mirrors builtin.ts's `id="job-card-{id}"`-anchored
 * splitJobCards() exactly, just with LinkedIn's own real marker.
 */
function splitJobCards(html: string): string[] {
  const starts: number[] = [];
  const re = /data-entity-urn="urn:li:jobPosting:\d+"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) starts.push(m.index);
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

function matchText(card: string, re: RegExp, group = 1): string | undefined {
  const m = re.exec(card);
  const value = m?.[group];
  return value === undefined ? undefined : decodeEntities(value).trim();
}

function parseCard(card: string): LinkedInListItem | null {
  const id = matchText(card, /urn:li:jobPosting:(\d+)/);
  const hrefRaw = matchText(card, /<a class="base-card__full-link[^"]*"[^>]*\shref="([^"]+)"/);
  const title = matchText(card, /<h3 class="base-search-card__title">\s*([\s\S]*?)\s*<\/h3>/);
  if (!id || !hrefRaw || !title) return null; // can't build a valid Gig without a stable id, url, and title

  const company = matchText(card, /<h4 class="base-search-card__subtitle">[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*<\/a>/);
  const location = matchText(card, /<span class="job-search-card__location">\s*([\s\S]*?)\s*<\/span>/);
  const postedAt = matchText(card, /<time class="job-search-card__listdate"\s+datetime="([^"]+)"/);

  return {
    id,
    // The real per-listing permalink, tracking query params (position,
    // pageNum, refId, trackingId) stripped — they're per-scan ephemeral,
    // not part of the listing's own stable identity, and would otherwise
    // make the same job's Gig.url churn on every single scan.
    url: decodeEntities(hrefRaw).split("?")[0]!,
    title,
    company: company ?? null,
    location: location ?? null,
    postedAt: postedAt ?? null,
  };
}

function toGig(item: LinkedInListItem): Gig {
  return {
    sourceId: "linkedin",
    externalId: item.id,
    title: item.title,
    company: item.company ?? undefined,
    url: item.url,
    // LinkedIn's guest search cards show neither a weekly-hours figure nor a
    // $-denominated rate anywhere — both left unset (unknown), never
    // guessed, same as gofractional.ts's own equivalent gap.
    postedAt: item.postedAt ?? undefined,
    raw: item,
  };
}

function searchKeywordsFrom(cfg: SourceConfig): string {
  const configured = cfg.settings?.searchKeywords;
  return typeof configured === "string" && configured.length > 0 ? configured : DEFAULT_SEARCH_KEYWORDS;
}

function jobTypeFrom(cfg: SourceConfig): string {
  const configured = cfg.settings?.jobType;
  return typeof configured === "string" && configured.length > 0 ? configured : DEFAULT_JOB_TYPE;
}

async function fetchSearchHtml(keywords: string, jobType: string): Promise<string> {
  const url = `${JOBS_BASE}?keywords=${encodeURIComponent(keywords)}&f_JT=${encodeURIComponent(jobType)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "text/html" } });
  } catch (e) {
    throw new Error(`linkedin: network error fetching ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`linkedin: fetch failed for ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  // Sanity check this is really LinkedIn's real jobs-search page and not,
  // say, an error/interstitial page — mirrors every other adapter's own
  // page-shape guard.
  if (!html.includes("base-search-card")) {
    throw new Error(`linkedin: unexpected response shape from ${url} (no job-card markers found)`);
  }
  return html;
}

export const linkedinSource: Source = {
  id: "linkedin",
  label: "LinkedIn",
  auth: "none",
  async fetch(cfg: SourceConfig): Promise<Gig[]> {
    const keywords = searchKeywordsFrom(cfg);
    const jobType = jobTypeFrom(cfg);
    const html = await fetchSearchHtml(keywords, jobType);
    const cards = splitJobCards(html);

    // Deliberately single-page (no `&start=N` pagination) — same accepted
    // scope limit as builtin.ts's/gofractional.ts's own single-page
    // precedent: each scan sees whatever LinkedIn's guest search renders on
    // its first page (confirmed live: ~60 cards for a real query), refreshed
    // every run.
    if (cards.length === 0) {
      throw new Error("linkedin: found 0 job cards — the card markup this adapter expects may have changed");
    }

    const byId = new Map<string, LinkedInListItem>();
    for (const card of cards) {
      const item = parseCard(card);
      if (item) byId.set(item.id, item); // de-dup by id within this single page
    }

    if (byId.size === 0) {
      throw new Error(`linkedin: found ${cards.length} job card(s) but could not parse any of them`);
    }

    return [...byId.values()].map(toGig);
  },
};

registerSource(linkedinSource);
