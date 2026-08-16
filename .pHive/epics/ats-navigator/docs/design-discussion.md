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

Follow-up round (same session, after seeing §3's robots.txt findings
below): "yeah, i don't give a shit about indeed and their robots -- and
HALF of these things will go with a gmail addition for scanning your
email as well -- but the career site also had a reverse to see if you
match their job description and then prep and what to do to tweak etc --
so we need bi directional ATS scanning and pulling in all the components
and features of that career section as the etc." This resolves three
things this document originally left open (see §5's history): Indeed is
IN, explicitly owner-overridden (§3 Indeed, revised); Gmail connection is
part of onboarding, not a separate ask (§4.2, revised); and "and etc."
does NOT mean more job boards — it means the full candidate-portal
feature set (match score + concrete tweak/prep guidance, bidirectional)
that these platforms already offer, which is what §4.4/Ask B actually is
(revised, expanded).

Two related but architecturally distinct asks, both under one theme
("help candidates navigate ATS-driven hiring systems"):

- **A. Guided onboarding + auto-apply readiness** for common job
  platforms (Indeed, Welcome to the Jungle, Zoho Recruit — owner-confirmed
  closed list, not open-ended; see §3's "and etc." resolution) —
  source/apply layer, plus wiring each platform's onboarding to the
  existing Gmail-digest-ingestion mechanism where relevant.
- **B. Bidirectional ATS scanning** — not just a score: how well does the
  user's resume match a SPECIFIC job's posted text (forward direction,
  parseability + keyword overlap), AND, given a gap, concrete tweaks to
  close it (reverse direction — what to actually change) — the same
  "match + prep + what to tweak" feature shape real ATS candidate portals
  already offer, given away free and fully explainable instead of gated
  behind the hiring platform's own black box.

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

**Owner-overridden, explicitly, with this finding in front of them**
("i don't give a shit about indeed and their robots") — same posture
`linkedin.ts`'s own documented robots.txt exception already established
in this codebase: a deliberate, informed decision, not an oversight. One
real distinction worth recording here (not a rationalization, an actual
fact about how the fetch happens): the disallow rules and the AI-bot
section both target automated CRAWLERS identifying by `User-Agent`
string (`GPTBot`, `ClaudeBot`, etc.) — gigradar's fetch path is a real,
headed Chrome instance (`real-chrome.ts`, already used for Capture
Login), presenting a normal browser User-Agent, driven on behalf of one
real user's own account/search, at the volume one person's job search
produces — a materially different activity from a mass AI-training
crawler, even though the underlying automation library is the same. Given
Indeed's likely-aggressive bot detection (a large site actively fighting
scraping, more so than LinkedIn's guest pages), this still goes through
`custom-llm-source` + Capture Login (`customAuth: "browser-session"`)
rather than a naive unauthenticated `fetch()`, and the FETCH side
shipping does not imply a `SubmitAdapter` ships automatically — that
still needs its own live-verification pass (§4.3), mirroring GoFractional's
own "fetch works, submit is paused" precedent.

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

### "and etc." — resolved

Originally left open as "which other job boards?" — owner clarified it
means the FEATURE SET, not more platforms: "pulling in all the
components and features of that career section as the etc" refers to the
candidate-portal match/prep/tweak experience real ATS sites offer
alongside their listings (§4.4/Ask B, expanded below), not a longer
platform list. The platform list is now a closed, owner-confirmed set of
three: Indeed, Welcome to the Jungle, Zoho Recruit.

## 4. Design decisions

### 4.1 Per-platform strategy

| Platform | Strategy | Why |
|---|---|---|
| Indeed | **Source preset**, `customAuth: "browser-session"` by default (Capture Login) given its likely-aggressive bot detection — owner-overridden robots.txt exception, see §3. | Large, robots.txt-hostile, likely bot-detection-sensitive — the generic mechanism first, same "preset before bespoke adapter" reasoning as WTTJ; a hand-written `indeed.ts` adapter is a possible later upgrade if the generic extraction proves unreliable, not started here. |
| Welcome to the Jungle | **Source preset** pre-filling a `custom-llm-source` config (public, `customAuth` unset), pointed at a specific company/listing page the user supplies — never a search URL. | robots.txt allows listing pages; no AI-bot carve-out; matches the existing "real per-listing URLs only" rule with zero exception needed. |
| Zoho Recruit | **Source preset** pre-filling a `custom-llm-source` config, `customAuth` left to the user (most Zoho Recruit careers pages are public; a minority may be login-gated, in which case the existing Capture Login flow already covers it). | Self-hosted-per-company ATS — the generic mechanism's whole reason to exist, no bespoke adapter would ever "finish." |
| More platforms | Out of scope — owner-confirmed closed list of three (§3 "and etc." — resolved). | Not an open question anymore. |

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
- **Gmail wiring, folded into the SAME onboarding step, not a separate
  ask** ("HALF of these things will go with a gmail addition for scanning
  your email as well"): after `add_source` proposes and the user approves
  a new preset-based source, the chat's next turn checks whether that
  source's preset carries a `suggestsGmailDigest: true` flag (Zoho
  Recruit and Indeed both do — both notify application status/interview
  invites by email; WTTJ does not carry the flag by default since its
  candidate messaging is mostly in-platform) and, if so, offers to run
  the EXISTING `start_gmail_connect` tool (already shipped in the
  agent-chat epic's Slice 3, `chat-sessions-screenshots` story) for that
  account — same approval-gated mechanism, not a new one. This reuses the
  ALREADY-BUILT `email-digest-ingestion` epic wholesale; no new email
  parsing logic.

### 4.3 Auto-fire wiring

No second mechanism. Any `SubmitAdapter` this epic registers plugs into
the existing `AutoFireRuleConfig`/`evaluateAutoFire()` gate unmodified.
This epic does **not** ship a `SubmitAdapter` for any of the three
platforms yet, even with Indeed back in scope for FETCH — a submit
adapter for any of the three is real, separate, live-verify-required
work for a later epic, mirroring GoFractional's own "fetch works, submit
is paused pending live verification" precedent rather than assuming
submit automation will just work because fetch did.

### 4.4 Bidirectional ATS scanning (Ask B, expanded, then re-grounded)

Extends `generatePrepPacket()`'s existing single-shot LLM call rather
than adding a new page or a new LLM call site — bidirectional per the
owner's clarification: not just a diagnosis, a forward score AND a
reverse, concrete action plan to close the gap.

**Real finding that changed the original plan (research step, not a
guess):** the original framing assumed a "deterministic parseability
check against whatever the resume-ingestion path already extracted."
That data doesn't exist in this codebase. `extractProfile()`
(`profile-ingestion/extract.ts`) sends a resume PDF NATIVELY to Claude as
a document content block — deliberately never locally text-extracted —
and its result (`ExtractProfileResult`) is only `{roles, skills,
warnings}`. Neither the raw resume bytes/text NOR any structural
metadata (columns, tables, fonts, header placement) is persisted
anywhere; `Profile` itself only ever stores `{name, roles, skills,
timezone, homeBase}`. There is no stored resume STRUCTURE for a pure,
deterministic, no-LLM parseability pass to run against — building one
would mean either fabricating structure that was never actually
observed (violating this repo's own no-fabricated-data rule) or silently
adding a new persistent resume-storage mechanism, which is a real
architecture decision (where, encrypted how, PII-retention tradeoffs)
this design does not make unilaterally on the owner's behalf.

**Scope, re-grounded to what's actually achievable with data this
codebase already has:**

- **Forward direction — keyword-overlap score:** `profile.skills` +
  `profile.roles` (already structured, already persisted, already the
  exact fields `generatePrepPacket()`'s existing call reads via
  `buildApplicantDataBlock()`) vs. the SPECIFIC gig's own `description`
  (already scraped, already in hand). One LLM call, same BEGIN/END
  untrusted-DATA framing every other call site in this repo applies to
  scraped gig text. This is real, grounded, shippable now.
- **Reverse direction — concrete tweaks (the "bi directional" half):**
  given the forward score's gaps, a short, specific, actionable list —
  "add 'Kubernetes' to your skills — it appears 3× in this listing, 0×
  in your profile." Distinct from `PrepPacketContent`'s existing
  `keyGaps`/`recommendation` (holistic/interview-prep-oriented);
  `resumeTweaks` is narrowly ATS-keyword-mechanical. Same LLM call as the
  keyword-overlap score, not a second one.
- **Deliberately NOT shipped this slice — deterministic file-level
  parseability checks** (multi-column/table/image-text/header-contact-
  info detection against the actual resume file). Flagged as a real
  follow-up requiring its own design decision: either (a) an ephemeral,
  not-persisted resume upload at prep-packet-generation time (mirrors
  `extractProfile()`'s own per-call, non-persisted resume input), or (b)
  a new persistent resume-storage field with its own encryption/PII
  tradeoffs. Both are real options, neither decided here — see Open
  Questions.
- Both fields (`keywordOverlapScore` + `matchedKeywords`/
  `missingKeywords`, `resumeTweaks`) feed into a new `atsScore` section
  of `PrepPacketContent`, surfaced in the existing prep-packet UI — not a
  new page, not a new drafting flow.

## 5. Open Questions — resolved this session

Originally three open questions; the owner's follow-up round (§0)
resolved all three directly:

1. ~~"and etc." — which other platforms actually matter?~~ **Resolved:**
   not more platforms — the full candidate-portal feature set (§4.4,
   above). Platform list is closed at three.
2. ~~Indeed: pursue a LinkedIn-style exception, or leave it out?~~
   **Resolved:** in, explicitly owner-overridden (§3 Indeed).
3. **Still open, deliberately not resolved by the owner's follow-up:**
   WTTJ/Zoho Recruit/Indeed `SubmitAdapter`s (real submission automation)
   need their own live-verification pass before shipping, mirroring
   GoFractional's own paused precedent — not started in this epic,
   flagged as the natural next epic once the fetch-side presets are live
   and trusted.
4. **New, surfaced by §4.4's research (not anticipated at plan time):**
   should gigradar start persisting resume content/structure so a real,
   deterministic file-level parseability check becomes possible, and if
   so, ephemeral-per-call (re-upload each time, nothing saved) or a new
   persistent field (which needs its own encryption/PII-retention design,
   not assumed)? This slice ships the keyword-overlap + resumeTweaks half
   without resolving this — real, useful, and honest about the gap rather
   than faking a parseability check against data that doesn't exist.

## 6. Scale assessment

**Medium-to-large.** Multi-file (new preset registry, two new chat
tools + UI wiring, a `PrepPacketContent` extension), but every piece
plugs into an existing mechanism rather than inventing one — no new
runtime, no new auth model, no new LLM-call shape. Vertical slices below;
no structured outline (this repo's own prior epics use design-discussion
+ vertical-plan only — see `llm-custom-sources`/`oauth-session-capture-v2`
for precedent, not a fresh structured-outline ceremony).
