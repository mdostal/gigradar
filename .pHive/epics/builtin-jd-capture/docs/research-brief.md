# Research Brief: builtin-jd-capture

## 1. Summary

BuiltIn's adapter (`src/lib/sources/builtin.ts`) captures `description`
from a short list-card snippet div (`fs-sm fw-regular mb-md
text-gray-04`), not the real job posting body — confirmed by direct code
read. Both `tiering.ts` (green/yellow/red classification) and `draft.ts`
(LLM-drafted applications, `assisted-apply-drafting`) actually consume
`gig.description` — a fuller, real description directly improves both.
Live-verified: BuiltIn's `/job/{slug}/{id}` detail pages are
robots.txt-compliant, return real, substantial content (confirmed: a real
job posting, ~37 paragraph/list elements), and need no login.

## 2. Key findings (live-checked, not assumed)

- `curl https://builtin.com/robots.txt` — `/job/` (singular, detail pages)
  is NOT in the `Disallow` list (only `/jobs/...` category-filter
  variants and unrelated paths like `/apply/`, `/search`, `/login*` are
  restricted).
- A real detail page fetch (`/job/software-engineer/10652802`, a real
  live listing) returned HTTP 200, 117KB, with a real `<title>` ("Software
  Engineer - Caterpillar | Built In") and ~37 `<p>`/`<li>` elements —
  confirming real, substantial description content is present and
  fetchable via a plain `fetch()`, matching the existing adapter's own
  established no-headless-browser-needed pattern.
- `tiering.ts:39` — `titleAndDescription = \`${title} ${gig.description
  ?? ""}\`` — the classifier's keyword matching directly depends on
  description quality/length.
- `draft.ts` — the drafting prompt includes `gig.description`, explicitly
  labeled/delimited as untrusted data (per `assisted-apply-drafting`'s
  established prompt-injection mitigation) — a fuller description
  produces a more grounded, accurate draft.

## 3. Patterns & conventions

- `builtin.ts`'s existing regex-over-HTML parsing style (no HTML-parsing
  dependency in this repo) is the pattern to extend, not replace — one
  more targeted regex against the detail page's own description
  container, following the same "throw on unrecognized shape" discipline
  already established there.
- This is an N+1 problem: today's adapter does ONE request (the category
  list page) for ~25 listings; capturing full descriptions means ONE
  ADDITIONAL request PER listing. Needs a bounded concurrency/rate
  approach so a single scan doesn't fire 25 simultaneous requests at
  BuiltIn — the exact class of "don't hammer a source" concern
  `scan-scheduler`'s backoff mechanism addresses at the SCHEDULE level,
  but this is a within-one-scan concern, a different problem.

## 4. Constraints

- Must preserve the existing list-page behavior exactly if a detail-page
  fetch fails for one listing — a single listing's detail-fetch failure
  should not break the whole scan; falls back to the existing short
  snippet description for that one listing, with the failure logged, not
  silently swallowed and not a fatal error for the whole adapter.
- Must not violate BuiltIn's `robots.txt` — confirmed clean for `/job/`
  paths (§2), but the SAME ethical-scraping discipline already
  established for this adapter (and `builtin.ts`'s own header comment
  citing this exact reasoning for why it's single-page-only on the list
  side) applies here too.

## 5. Risks

- **Medium — N+1 request volume per scan.** Fetching ~25 detail pages
  every scan cycle (times however often the scheduler runs) is a
  meaningfully larger request volume against BuiltIn than today's
  single-request adapter. Needs a bounded concurrency limit (not 25
  simultaneous requests) and should be weighed against whether EVERY
  listing needs its full description fetched, or only ones that pass an
  initial cheap check (e.g., already-seen gigs whose description was
  already captured in a prior scan don't need re-fetching).
- **Low — detail-page markup could differ in structure from what this
  research observed on one sample listing** — same accepted risk class
  every regex-based adapter in this project already carries (throw on
  unrecognized shape, don't guess).

## 6. Open questions

1. Fetch full descriptions for every listing every scan, or only for
   NEW listings (ones not already in the store with a description
   captured)? Leaning: only new/not-yet-detail-fetched listings — avoids
   needless repeat requests for gigs already scanned in a prior cycle,
   directly addresses the N+1 volume risk.
2. What bounded concurrency limit for the detail-page fetches within one
   scan? Leaning: a small, fixed limit (e.g. 3-5 concurrent requests) —
   real, meaningful parallelism without hammering the source.
