# Career CRM — extraction reference

Captured 2026-08-14 from a local build of `me-mdostal-com`, immediately
before this tree was removed from the public personal site per operator
decision (zero recorded pageviews on `me.mdostal.com` in 90 days,
confirmed via PostHog). This is the reference snapshot for
re-implementing it as a real feature of gigradar — **not yet planned**;
this doc exists so the source material survives until a real `/plan`
pass runs against it (see task #56).

Source artifact (screenshots + full formatted page):
`https://claude.ai/code/artifact/7bf76612-856d-490f-86c5-560d1b18f22e`

## What it was

A private job-search tracker and career-management hub, built inside the
shared `mdostal.com`/`me.mdostal.com` codebase and feature-flagged off by
default. Never indexed, zero real traffic — a fully-built but unshipped
feature.

| | |
|---|---|
| Last known-good commit | `13fc5a6ba4f08b5192b318f6d34198a216bea06b` |
| Repo | `mdostal/me-mdostal-com` |
| Gate | `CAREER_ENABLED=true` |
| Indexing | `robots: noindex` (already private) |

## Dashboard — `/career`

The hub. Three AI-powered quick actions up top, then live status: active
application count by pipeline stage, upcoming follow-ups, and
weekly-checklist progress rolled up across all four weeks.

- Quick action: **Analyze a Role** — AI-powered fit & gap analysis against a job posting.
- Quick action: **Draft Outreach** — generates personalized outreach messages.
- Quick action: **Interview Prep** — STARLA-format stories + predicted questions.
- Application pipeline summary by status: Researching → Applied → Phone Screen → Interviewing → Offer → Rejected → Withdrawn.
- Checklist progress bar, broken out per week (Week 1–4+).

## AI Assistant — `/career/assistant`

Chat interface scoped to career-search context, backed by
`/api/career-chat` and `/api/career-generate`. Suggested-prompt chips per
topic (general strategy, per-role, per-application) and a persistent side
nav across the whole Career CRM.

- Context-aware suggested prompts (e.g. "What should I prioritize this week", "Review my overall career positioning", "What industries should I target").
- Free-text chat input, Enter to send / Shift+Enter for newline.
- Right rail: quick nav to Dashboard, Applications, Strategy Docs, Weekly Checklist, Message Templates.

## Weekly Checklist — `/career/checklist`

A structured, 48-item job-search plan spanning Week 1 through Week 4+,
sourced from Sanity (`checklistItem` documents tagged `career-week-1` …
`career-week-5-6`). Each item carries a priority tag and can link out to
a strategy doc.

- Overall progress bar (0/48 complete) plus a per-week sub-progress bar.
- Priority tags per item — High / Medium / Low.
- Items expand to reveal linked strategy docs, applications, and templates.
- Collapsible "Status & Priority Reference" legend.

## Job Applications — `/career/jobs` · `/career/jobs/[slug]`

The application tracker proper — a filterable list (All / Active) backed
by `JobApplication` Sanity documents, each with its own detail page at a
slug route.

- Status-based filter tabs with live counts.
- Detail page per application (company, role, status, notes — see `app/career/jobs/[slug]/page.tsx`).
- Feeds the dashboard's pipeline summary and the checklist's "linked applications".

## Strategy Docs — `/career/strategy` · `/career/strategy/[slug]`

Longer-form reference documents, grouped by category (Job Search, Career
Planning, …), each editable directly in Sanity Studio via a per-card
"Edit in Studio" link.

- Categorized doc list — e.g. *Fractional CTO Platform Applications Guide*, *LinkedIn Premium 30-Day Maximization Plan*, *Executive Compensation Negotiation Playbook*, *Fractional CTO Growth & Pricing Strategy*, *Fractional CTO Launch Playbook*.
- Per-doc priority + status pills (High/Active, etc.) and a last-reviewed date.
- Direct "Edit in Studio" deep link per document.

## Message Templates — `/career/templates`

Copy-ready outreach and communication templates, grouped by type, each
with a one-click Copy button and an "AI: Personalize" action to tailor it
to a specific role/company.

- Categories observed: Elevator Pitch (30s / 60s variants), with more groups below the fold (outreach, follow-up, networking per the page description).
- Per-template subject line + body, tagged (e.g. "networking", "detailed").
- "AI: Personalize" — regenerates the template via `/api/career-generate`.

## Toptal Prep — `/career/toptal`

A dedicated prep tracker for the Toptal screening funnel specifically —
one of several platform-specific sub-pages implied by the Strategy Docs
list (Bolster, GoFractional, Cerius, TechCXO also appear there as
checklist items).

- 4-stage process overview with pass rates: English Communication (~80%) → CCAT/IQ Assessment (~70%) → Live Technical Interview (~60%) → Trial Project (~50%).
- CCAT score target callout (30+/50, average is 24, top 2% score 36+).
- Prep-resources checklist below the fold, staged by process step.

## Tech stack & data model

Everything is server-rendered Next.js reading from the same shared
Sanity dataset the rest of the site uses, gated behind auth for write
actions.

| Layer | Detail |
|---|---|
| Gate | `app/career/layout.tsx` — `notFound()` unless `process.env.CAREER_ENABLED === 'true'`; also sets `robots: {index: false}`. Off by default in every environment observed. |
| Auth | `lib/career-auth.ts` + NextAuth `auth()`/`signOut()`; layout shows the signed-in user's email in a floating pill when a session exists. `/career/sign-in` is the login page. |
| Data | Sanity document types: `JobApplication`, `CareerChecklistItem` (via `lib/sanity-schemas.ts`), plus Strategy Docs and Message Templates content (same dataset, different types/tags). |
| API routes | `/api/career-chat` (assistant conversation), `/api/career-generate` (AI drafting/personalization), `/api/career-save` (persist checklist/application state). |
| Config | `lib/career-constants.ts`, `lib/career-profile.ts` — status/priority enums and the profile data fed into AI prompts. |
| Rendering | `export const dynamic = 'force-dynamic'` on the layout — always server-rendered, never statically cached. |

## Extraction notes (from the original owner's snapshot)

- Pull the full `app/career/` tree, `lib/career-*.ts`, and
  `app/api/career-*` from commit `13fc5a6` in `mdostal/me-mdostal-com` —
  that commit is the last one where these routes are intact and
  reachable (set `CAREER_ENABLED=true` locally to render them; they 404
  otherwise).
- The Sanity content (job applications, checklist items, strategy docs,
  templates) lives in the production dataset shared with
  `mdostal.com`/`me.mdostal.com` — it does **not** travel with the code.
  Export those document types separately if the new product needs the
  existing data, not just the UI shell.
- Auth currently piggybacks on the site's own NextAuth setup — a
  standalone product will need its own auth story (gigradar already has
  one — see `docs/ARCHITECTURE.md`'s Config/secrets sections; this
  should NOT be a second auth system).
- The three AI actions (analyze role, draft outreach, interview prep)
  all route through `/api/career-chat` and `/api/career-generate` —
  worth checking what model/prompt config those hit before assuming
  they're portable as-is.

```
git show 13fc5a6:app/career -- 2>/dev/null || git checkout 13fc5a6 -- app/career lib/career-auth.ts lib/career-constants.ts lib/career-profile.ts app/api/career-chat app/api/career-generate app/api/career-save
```

(Run against a checkout of `mdostal/me-mdostal-com`, not this repo.)

## Notes for the future `/plan` pass on this epic

Not decisions — just overlaps worth weighing when this gets a real
design discussion, so the planner doesn't rediscover them from scratch:

- **`JobApplication` (Sanity) vs. gigradar's own `gigs` + `application_drafts` tables.** gigradar already tracks a status pipeline (`new`/`applied`/`interview`/`archived`/`ignored` on `gigs.status`, plus `draft`/`approved`/`rejected`/`submitted` on `application_drafts.status`) that heavily overlaps the Career CRM's Researching → Applied → Phone Screen → Interviewing → Offer → Rejected → Withdrawn pipeline. Worth deciding whether Career CRM's richer pipeline REPLACES gigradar's simpler one, or layers on top of it, rather than running two parallel status models.
- **The AI Assistant / Interview Prep / Draft Outreach quick actions** overlap `src/lib/apply/draft.ts`'s existing `generateDraft()` LLM-call pattern (BYOK `apiKey` resolved by the caller, untrusted-content framing for scraped gig data) and the `graduated-auto-fire-trust` epic's trust/config posture — likely reuses the same LLM-integration conventions, not a new one.
- **Toptal Prep's platform-specific screening-funnel tracking** is a concrete, detailed example of exactly the "work through a specific platform" need described in [[project_gigradar_platform_hub]] (task #55) — Bolster/GoFractional/Cerius/TechCXO are named there too. These two features likely converge into one platform-aware prep/tracking surface rather than staying separate.
- **Message Templates** overlaps the existing `Config.applyProfile`/draft-content model — copy-ready, per-category templates with an "AI: Personalize" action is close to what `generateDraft()` already does per-gig; may be a generalization of it rather than a separate system.
- **Auth**: do not port NextAuth. gigradar has no multi-user auth today (single local user, local config) — Career CRM's auth requirement was for a shared public-site codebase with real user accounts, which doesn't apply here unless gigradar itself grows multi-user support (out of scope unless separately decided).
