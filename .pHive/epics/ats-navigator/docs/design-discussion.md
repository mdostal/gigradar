# Design Discussion: ats-navigator

## 0. Prelude

Owner's exact words (this session, 2026-08-16, immediately after the
agent-chat epic shipped and v0.23.0 was cut): "we should try to easy walk
people through the common application systems now -- indeed, welcome to
the jungle, zoho recruit, etc to try to get all of the easy apply parts
ready and able to auto apply as we go", followed shortly after by "go
ahead and steal the silly ATS rating and stuff that some of the others use
and see if we can navigate that around -- we're basically giving away a
free version of what all the companies are doing to screw people without
jobs atm."

Two related but architecturally distinct asks, both under one theme
("help candidates navigate ATS-driven hiring systems"):

- **A. Guided onboarding + auto-apply readiness** for common job
  platforms (Indeed, Welcome to the Jungle, Zoho Recruit, more TBD) —
  source/apply layer.
- **B. ATS resume-compatibility scoring** — give a user visibility into
  how their OWN resume would fare against the keyword/format screening
  real ATS platforms run, so they can fix it before applying — profile
  layer, orthogonal to which job board a listing came from.

**Framing for B, stated up front because it shapes every design choice
below:** this is a "beat the ATS" resume-coaching feature in the same
spirit as commercial tools like Jobscan/Resume Worded — deterministic,
explainable heuristics run against the user's OWN resume and a real job
posting's OWN text, both already in gigradar's possession. It is
**not** an attempt to reverse-engineer, scrape, or spoof any vendor's
proprietary scoring algorithm, and it is not aimed at any specific
company's hiring system. "Navigate around" here means "help a candidate's
resume survive automated keyword/format screening," matching this
project's existing north star (README: "explainable... never a black
box"; CLAUDE.md: gigradar "assists, never auto-submits"). If this were
ever to become a company/vendor-targeted evasion tool, that's out of
scope — it isn't what's being asked or what this design proposes.

## 1. Goal

Get a user from "I use these job systems" to "gigradar is watching them,
and I know whether my resume will even get past their filters" with
minimal manual config-file editing, using building blocks this codebase
already has — never inventing a second onboarding mechanism, a second
auto-apply mechanism, or a second LLM-analysis mechanism where an
existing one already does the job.

## 2. Existing building blocks (reused, not reinvented)

- **Generic BYOK LLM custom-source mechanism** (`llm-custom-sources`
  epic, done): `src/lib/sources/custom-llm-source.ts`. A user points
  `SourceConfig.settings.url` (+ optional `.hint`, `.customAuth`,
  `.sessionStatePath`, `.allowedOrigins`) at ANY page and gigradar
  LLM-extracts `Gig[]` from it, with recipe caching and pagination. No
  code required to add a site.
- **Hand-written `Source` adapters** (`src/lib/sources/*.ts`): the right
  call for a large, stable, worth-the-maintenance-cost centralized site
  (see `linkedin.ts`).
- **`role-templates.ts`'s preset-picker precedent**: a small curated
  array (`id`/`label`/`config`) rendered directly by the config UI's
  picker, distinct from the generic mechanism it configures. The exact
  same shape applies to SOURCE presets.
- **Graduated auto-fire trust system** (done): `src/lib/apply/autofire.ts`
  (`AutoFireRuleConfig { sourceId, tier, enabled, minApprovals, dailyCap }`,
  `evaluateAutoFire()`'s 6-step gate), `src/lib/submit/adapter.ts`'s
  `SubmitAdapter` registry (`registerSubmitAdapter({id, ...})`, `id` must
  match the fetch-side `Source.id`). The first real `SubmitAdapter`
  (GoFractional) is **paused** — live-verified blocked by a Cloudflare
  challenge even from a real authenticated session. "No adapter
  registered" is a correct, safe terminal state, not a bug.
- **`session-capture.ts` / `browser-session.ts`**: Capture Login flow for
  any login-gated site, via `real-chrome.ts`'s spawn-then-attach (already
  fixes bot-detection rejection of Google OAuth).
- **The just-shipped agent-chat epic**: `src/lib/chat/agent-chat-loop.ts`
  — a propose/approve tool-use loop already wired to source-connection
  tools (`start_capture_login`, `start_gmail_connect`, etc). This is a
  real candidate delivery vehicle for "walk people through it."
- **`generatePrepPacket()`** (`src/lib/apply/prep.ts`, career-crm epic):
  single-shot LLM fit/gap analysis producing `PrepPacketContent { score,
  rationale, topStrengths, keyGaps, recommendation, predictedQuestions,
  starlaStories }`, persisted via `saveInterviewPrep()`. This already
  scores a resume against ONE gig's posted text — the natural host for
  ATS-parseability scoring rather than a new page/mechanism.

## 3. Real research: per-platform shape (not a guess)

Fetched each platform's live `robots.txt` before proposing an approach —
the same discipline `linkedin.ts`'s own documented robots.txt exception
already established for this codebase (never assume, always check).

### Indeed

`robots.txt` (User-agent: `*`) explicitly disallows: `/job/`, `/Job/`,
`/jobs/{country}/` (every country code), `/viewjob?`, **`/applystart`**,
plus company-page paths. A separate section adds broader restrictions
specifically for AI bots (GPTBot, anthropic-ai, ClaudeBot, etc.),
including `/jobs` and `/career/`.

**This is materially different from LinkedIn's posture.** LinkedIn's
adapter has one documented, deliberate robots.txt exception because its
public guest search page is the only viable path and the decision was
made explicitly, in the open, with the tradeoff written down. Indeed
disallows exactly the two paths this feature would need most — the
per-listing detail page (`/viewjob`) and the apply flow itself
(`/applystart`) — and separately calls out AI bots by name. Building a
scraping `Source` or a `SubmitAdapter` against Indeed would require the
**same kind of deliberate, explicit, owner-approved exception** LinkedIn
got, not a default. This design does **not** propose one; it treats
Indeed as **explicitly out of scope for real automation** unless and
until the owner decides otherwise with this finding in front of them
(see Open Questions).

### Welcome to the Jungle (welcometothejungle.com)

`robots.txt` (User-agent: `*`) disallows `/me/*`, `/settings/*`,
`/users/*`, `*/jobs?query=*`, and broadly `/*?` (any URL carrying a query
string). It does **not** disallow individual job/company listing pages
themselves, and has no AI-bot-specific section. This lines up cleanly
with the "real per-listing URLs only, never a search page" rule every
adapter in this codebase already follows (`README.md` §How it works, step
1) — a WTTJ integration that discovers real listing URLs some other way
(e.g. a user-provided company jobs page, or an already-known listing) and
only ever fetches clean, query-string-free detail URLs stays inside the
disallow rules with no exception needed.

### Zoho Recruit

Not one central site — an ATS **vendor**. Every company self-hosts its
own careers/application page on it (its own domain or a
`*.zohorecruit.com` subdomain), each with its own layout. This is
architecturally identical to "any small ATS a user happens to apply
through" — exactly the case `custom-llm-source.ts` was built for. A
bespoke `zoho-recruit.ts` adapter would be maintaining a hand-written
scraper for a moving target with no single URL to test against; a
**preset** that pre-fills a `custom-llm-source` config (with a hint like
"this is a Zoho Recruit careers page — listings are usually a simple job
list with a title/location/apply link per row") gets 90% of the value for
a fraction of the maintenance burden, and degrades gracefully per-company
via the existing recipe-caching mechanism.

### "and etc."

The owner's own phrase leaves the platform list open-ended. This design
does **not** silently expand it — see Open Questions. What ships now is
the mechanism (presets + generic custom-llm-source + real per-platform
research before any bespoke adapter), not a fixed platform list; adding
the next platform later is a config/preset change, not new core code,
which is the whole point of the core/user-layer boundary.

## 4. Design decisions

### 4.1 Per-platform strategy

| Platform | Strategy | Why |
|---|---|---|
| Indeed | **Neither adapter nor preset, for now.** Registered as a KNOWN, documented gap. | robots.txt explicitly disallows the listing-detail and apply paths, and singles out AI bots. Needs an explicit, owner-approved exception (LinkedIn precedent) before any code is written — not a default this epic makes for the owner. |
| Welcome to the Jungle | **Source preset** pre-filling a `custom-llm-source` config (public, `customAuth` unset), pointed at a specific company/listing page the user supplies — never a search URL. | robots.txt allows listing pages; no AI-bot carve-out; matches the existing "real per-listing URLs only" rule with zero exception needed. Bespoke adapter is a possible LATER upgrade if the generic mechanism proves unreliable for this specific site — not started here, since the generic mechanism is cheaper to ship and maintain first. |
| Zoho Recruit | **Source preset** pre-filling a `custom-llm-source` config, `customAuth` left to the user (most Zoho Recruit careers pages are public; a minority may be login-gated, in which case the existing Capture Login flow already covers it). | Self-hosted-per-company ATS — the generic mechanism's whole reason to exist, no bespoke adapter would ever "finish." |
| More platforms | Out of scope this epic — see Open Questions. | Owner's own "etc." is a real open question, not an invitation to guess. |

Presets live alongside `role-templates.ts`'s pattern: a new, small,
curated array (`SOURCE_PRESETS` or similar) of `{id, label, description,
settings}` objects the config UI and the chat onboarding tool both read
from — one source of truth, not duplicated lists.

### 4.2 Onboarding delivery vehicle

Real decision, not an assumed answer: **both, but the chat is primary.**

- **Primary: extend `agent-chat-loop.ts`** with one new **read-only**
  tool (`list_source_presets`) and one new **approval-gated write** tool
  (`add_source`, following the exact `pendingApproval` propose/approve
  discipline every other write tool in that loop already uses — no
  exceptions, matching this epic's own established convention). This
  directly answers "walk people through it": a user can say "I use
  Welcome to the Jungle, here's a link to a company's jobs page" and the
  agent proposes the exact `SourceConfig` it would add, which the user
  approves before anything is written — reusing infrastructure that
  shipped this same session rather than building a parallel wizard.
- **Secondary, cheap: a preset picker in `/config`'s existing "Add a
  source" UI** (`config-client.tsx`), for users who don't use chat. Small
  addition — a dropdown of the same `SOURCE_PRESETS` array feeding the
  same `custom-llm-source` config shape the chat tool writes, so there is
  exactly one source-config-construction code path either way.

### 4.3 Auto-fire wiring

No second mechanism. Any `SubmitAdapter` this epic registers plugs into
the existing `AutoFireRuleConfig`/`evaluateAutoFire()` gate unmodified.
Given §3's findings, this epic does **not** ship a `SubmitAdapter` for
any of the three named platforms yet — Indeed is out of scope (§4.1),
and WTTJ/Zoho Recruit go through the generic `custom-llm-source` fetch
path first; a submit adapter for either is real, separate, live-verify-
required work for a later slice/epic, mirroring GoFractional's own
"fetch works, submit is paused pending live verification" precedent
rather than assuming submit automation will just work because fetch did.

### 4.4 ATS resume-compatibility scoring (Ask B)

Extends `generatePrepPacket()`'s existing single-shot LLM call rather
than adding a new page or a new LLM call site:

- **Deterministic parseability checks (no LLM, no black box):**
  well-documented, public facts about how real ATS parsers choke —
  multi-column layouts, tables, text embedded in images, headers/footers
  containing contact info, non-standard section headings, unusual fonts —
  run against whatever the existing resume-ingestion path
  (`profile-ingestion/extract.ts`) already extracted. Pure functions,
  fully explainable, each flag names the specific problem
  ("your contact info is in a header — many ATS parsers skip headers
  entirely"), matching this codebase's "explainable, never a black box"
  gate philosophy (`README.md` §The one principle) — gigradar's whole
  differentiator from the vendors it's leveling the playing field
  against is exactly that it doesn't hide its reasoning either.
- **Keyword-overlap score:** the user's resume text vs. the SPECIFIC
  gig's own `description` (already scraped, already in hand) — real
  content both sides already own, not a scrape of any vendor's internal
  model. Reuses the same BEGIN/END untrusted-DATA framing every other
  LLM call site in this repo applies to scraped gig text.
- Both feed into a new `atsScore` section of `PrepPacketContent` (or a
  sibling field), surfaced in the existing prep-packet UI — not a new
  page, not a new drafting flow.

## 5. Open Questions (owner input needed before/while executing)

1. **"and etc." — which other platforms actually matter?** This design
   deliberately does not guess a 4th/5th platform. Name them and they get
   the same real-robots.txt-first research treatment before any code.
2. **Indeed: pursue a LinkedIn-style deliberate exception, or leave it
   out entirely?** §3's finding (explicit AI-bot + apply-flow disallow)
   is a real, live fact in front of the owner now, not a soft guess —
   this design's default is "leave it out" unless explicitly overridden.
3. **WTTJ/Zoho Recruit `SubmitAdapter`s** — real submission automation
   for either needs the same "live-verify with the owner watching before
   calling it done" pass GoFractional's own attempt got (and got paused
   by). Not started in this epic; flagged as the natural next epic once
   the fetch-side presets are live and trusted.

## 6. Scale assessment

**Medium-to-large.** Multi-file (new preset registry, two new chat
tools + UI wiring, a `PrepPacketContent` extension), but every piece
plugs into an existing mechanism rather than inventing one — no new
runtime, no new auth model, no new LLM-call shape. Vertical slices below;
no structured outline (this repo's own prior epics use design-discussion
+ vertical-plan only — see `llm-custom-sources`/`oauth-session-capture-v2`
for precedent, not a fresh structured-outline ceremony).
