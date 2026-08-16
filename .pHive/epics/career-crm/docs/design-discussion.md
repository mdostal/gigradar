# Design discussion: career-crm

## 0. Prelude

**NORTH STAR**: task #56, picked up directly from the user: "should be in
~/Documents/work/personal... pull all of that in so we have the
judgement, the resume match, the match of the job to skillset, etc as
features to be built out -- there are a bunch of tools for the gig radar
there." Primary inputs: `.pHive/epics/career-crm/docs/extraction-reference.md`
(the older, page-inventory-level survey of the original `me-mdostal-com`
build) and a fresh mechanism-level survey of the CURRENT live source,
`~/Documents/work/personal/personal-site` (see
[[project_gigradar_career_tracker_interview_prep]]'s 2026-08-16 update for
the full findings — summarized in §1 below).

## 1. What the survey actually found (grounding, not re-derived here)

- **No real resume-parsing/matching feature exists.** "Resume match" in
  the source is a single hand-written markdown string
  (`buildProfileContext()`) compared against a job description — never an
  uploaded/parsed resume. gigradar's own `Profile` (structured
  `roles`/`skills`/etc.) is already a BETTER source for this than the
  string it would replace — this is an improvement-on-port, not a
  straight port.
- **The real "judgment" logic is two LLM call sites**: a `match-score`
  action (score 1-100/rationale/topStrengths/keyGaps/recommendation, via
  raw `JSON.parse()`, no schema validation) and a chat endpoint with
  mode-specific instructions (`fit-analysis`/`gap-analysis`/
  `interview-prep`/`outreach`/`salary-negotiation`). The PROMPT CONTENT is
  genuinely good and worth porting as instruction text; the MECHANISM
  (Vercel AI SDK, unvalidated JSON.parse) is explicitly NOT — this repo's
  own forced-tool-use pattern (`profile-suggest.ts`, `custom-source-recipe.ts`,
  `capture-guidance.ts`) is strictly better and replaces it.
- **Auth (NextAuth) and storage (Sanity CMS)** are personal-site-specific
  plumbing — gigradar is single-user/local-config, needs neither. Every
  Sanity-backed feature (job-application tracker, weekly checklist,
  strategy docs, message templates) needs a gigradar-native SQLite
  equivalent, not an import.
- **Reusable REFERENCE data** (not logic): the 12-step `PROCESS_STEPS`
  pipeline (discovery → negotiating) and `NEXT_ACTION_MAP`, and the
  Toptal/Bolster/GoFractional/Cerius/TechCXO platform-specific
  stage-by-stage prep content (ties into [[project_gigradar_platform_hub]]).

## 2. Scope decision: what ships in THIS epic

The full old Career CRM (dashboard, weekly checklist, chat assistant,
message-template library, strategy-doc library) is a large, multi-feature
product. Building all of it in one epic would repeat this session's own
learned lesson about vertical slicing. **This epic ships the single
highest-value, most concretely-scoped piece the user explicitly named**:
real fit/gap "judgment" — a per-gig prep packet combining a structured
fit-score/gap analysis with interview-prep content (predicted
questions + STARLA-format stories), generated from gigradar's OWN
structured `Profile` and the tracked `Gig`'s own data. Everything else
surveyed above (weekly checklist, message templates, strategy-doc
library, the richer 12-step status pipeline) is real, explicitly
DEFERRED scope for a follow-on epic — named here so it isn't silently
dropped, not built now.

## 3. Why per-gig, not a standalone tool

gigradar already tracks real gigs with real descriptions
(`Gig.description`) end to end (find → gate → tier → store). A prep
packet grounded in a SPECIFIC tracked gig (not a pasted-in job
description) is both more useful (one click from a gig already in the
pipeline) and safer (reuses the exact same `Gig`/`Profile` data every
other LLM call site in this repo already grounds itself in — no new
free-text-paste-a-job-description surface to build/secure).

## 4. Storage: a new `interview_prep` table, not a Sanity-style CMS

Mirrors `application_drafts` exactly (`src/lib/store/drafts.ts`/
`schema.ts`) — one row per gig, keyed by the SAME `gig_key` `gigs.key`
uses, real `PRAGMA foreign_keys=ON` FK enforcement, insert-or-replace on
regeneration (a stale prep packet for re-derived content is fully
replaced, not appended). `content` is JSON-stringified, mirroring
`DraftContent`'s own storage shape. This is genuinely regenerable,
LLM-derived content tied to one gig — the same tier as
`application_drafts`, not a new architectural pattern.

## 5. The LLM call: one structured tool-use call, not two

The old source's `match-score` and `interview-prep` chat mode are
SEPARATE calls. This epic combines them into ONE forced-tool-use call
(`generatePrepPacket()`) returning `{score, rationale, topStrengths,
keyGaps, recommendation, predictedQuestions, starlaStories}` — cheaper
(one call, not two) and the fit-analysis and interview-prep content are
naturally coherent when generated together (predicted questions should
already reflect the same gaps the fit analysis surfaced). Same
BEGIN/END-delimited untrusted-DATA framing every LLM call site in this
repo uses (the untrusted data here is `Gig.description`, third-party job
posting text). Same no-fabricated-data discipline: `keyGaps`/
`predictedQuestions` must be grounded in the actual gig/profile content,
never invented from nothing (this is naturally different from "the page
doesn't show this field" — an LLM's ANALYSIS is expected synthesis, not
verbatim extraction — see design_decisions in the story YAML for the
line this draws).

## 6. Scale assessment: **Medium**

One new store module (mirrors an existing one closely), one new LLM call
site (reuses an established pattern exactly), one Server Action, one UI
surface (a button + display on the dashboard/gig detail, mirroring the
existing "Generate draft" button). Two stories, not four.

## 7. Where owner input is genuinely unavoidable

None for the mechanism itself (built and unit-tested against mocks, same
discipline as every other epic this session). The DEFERRED scope in §2
(weekly checklist, message templates, strategy docs, richer status
pipeline) needs a real decision from the owner on priority/scope before
it's planned as a follow-on epic — not blocking this one.
