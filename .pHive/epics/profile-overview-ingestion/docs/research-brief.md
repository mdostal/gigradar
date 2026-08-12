# Research Brief: profile-overview-ingestion

## 1. Summary

Two related gaps the owner hit immediately after standing up v0.8.0 locally:
(1) `/` (dashboard) and `/config` (setup) have zero navigation between them
and no single view of "what's connected, what's configured, what's
happened" — confirmed by direct inspection, not assumed; (2) `Profile.skills`
and `Profile.roles` (`src/lib/types.ts`) must be hand-typed today — there's
no way to feed in a resume or a profile link and have gigradar extract them.
Per the owner's explicit, informed choice, extraction is LLM-based (Claude
API) — gigradar's first external API dependency and first use of an LLM,
though this is already foreshadowed in `docs/ARCHITECTURE.md`'s roadmap
("Assisted-apply drafting: LLM/agent drafts answers from Profile").

## 2. Key files & surfaces

- `src/app/layout.tsx` — bare root layout, no nav. `src/app/page.tsx`
  (dashboard) and `src/app/config/page.tsx` (config) have zero links to each
  other — confirmed by grep, zero `href`/`Link` hits in either.
- `src/lib/types.ts:4-15` — `Profile` (`name`, `roles`, `skills`, `timezone`,
  optional `homeBase`) — the extraction target.
- `src/lib/config/schema.ts` — `ProfileSchema`, mirrors `Profile` exactly;
  any new field needs both updated in lockstep (existing project convention,
  no codegen).
- `src/app/config/config-client.tsx` — has an existing "Start from a
  template" draft-then-Apply pattern (from `role-templates`, v0.7.0) for
  `roleArea` — the same UX shape fits extracted skills/roles: a draft the
  user reviews and applies, never a silent overwrite.
- `src/lib/store/schema.ts` — no dedicated "last scan" timestamp column, but
  `last_seen` is bumped on every gig touched by a scan; `MAX(last_seen)`
  across all gigs approximates "last successful scan" well enough for an
  overview summary with zero schema migration.
- `src/lib/config/load.ts` / `save.ts` — the existing `env:`-reference
  secret pattern (`resolveEnvString()`) and the encrypted-at-rest `.env`
  loader (just shipped, v0.8.0) — the natural home for an LLM API key,
  reusing infrastructure rather than inventing new secret storage.
- `package.json` — zero HTML-parsing or LLM-SDK dependency today. `dotenv`,
  `next`, `playwright`, `react`, `zod` only.

## 3. Patterns & conventions

- **Draft-then-Apply, never silent overwrite** — established by
  `role-templates`' template picker: an action populates client-side draft
  state, the user reviews it in the existing form fields, and only an
  explicit Save persists it. Directly reusable for extracted skills/roles.
- **`env:`-reference secrets** — every existing API-key-requiring
  integration (Braintrust in older code, before that adapter's own auth
  needs) stores the key in `.env`, referenced by name, resolved at
  read-time, never logged. An LLM API key should follow the exact same
  path: `ANTHROPIC_API_KEY` in `.env`, read via `process.env` at call time
  — no new secret-storage mechanism needed, and it inherits the
  encryption-at-rest just shipped in v0.8.0 for free.
- **Claude's Messages API supports PDF documents natively** (as a base64
  document content block) — the model reads the PDF directly server-side.
  This avoids needing a separate PDF-text-extraction dependency for the
  resume-upload path; only plain-text resumes need trivial handling beyond
  that.
- **`docs/ARCHITECTURE.md`'s "Assisted, not auto" principle** (line 452):
  "applications are staged for human approval; nothing submits itself."
  The same posture should extend to profile extraction — the LLM's output
  is a draft to review, never an automatic overwrite of the user's own
  hand-entered Profile.

## 4. Constraints

- **This is gigradar's first external API call of any kind** (every source
  today is either `auth:"none"` public-board scraping or
  `auth:"browser-session"` — no source has ever made an authenticated
  outbound API request with a bearer key). Genuinely new surface, not a
  copy of an existing pattern.
- **LinkedIn specifically blocks unauthenticated scraping** (bot-walled,
  typically returns a login page to an unauthenticated fetch) — a "paste
  your LinkedIn URL and we'll crawl it" promise would not reliably work
  without the browser-session mechanism (a real login), which is a much
  heavier lift than a public portfolio/GitHub link fetch. Needs an explicit
  scope decision, not an implied "just works."
- **Uploaded resume content is sensitive personal data** (name, contact
  info, full work history) — same sensitivity class the project already
  treats seriously for session/config files (hence v0.8.0's
  encryption-at-rest epic). Whether the raw file needs to be PERSISTED at
  all, or can be processed in-memory and discarded, is a real design
  question with a real privacy-surface-area answer either way.
- **Core/user-layer boundary still applies**: this is core-repo
  functionality (the extraction mechanism), not a hardcoded personal
  resume — same discipline as every prior epic.

## 5. Risks

- **Medium — sending personal resume/profile data to a third-party API is
  a meaningful privacy posture change** for a project whose entire history
  so far has been "100% local." Needs to be an explicit, informed,
  opt-in action each time (a button the user clicks), never automatic, and
  clearly documented — not buried.
- **Medium — LinkedIn link-crawling likely doesn't work as a user would
  naively expect** (bot wall) — scope needs to state this plainly rather
  than silently failing or (worse) implying full support.
- **Low-Medium — cost/rate exposure**: each extraction call costs real
  money against the user's own Anthropic API key. Since it's an explicit,
  user-initiated, one-shot action (not automatic/recurring/scheduled), the
  exposure is bounded and consented, but worth naming.
- **Low — new dependency surface**: `@anthropic-ai/sdk` (or equivalent) is
  a new, real dependency — first non-Next/React/Playwright/zod runtime
  dependency in the project.

## 6. Open questions

1. Does extraction populate `Profile.skills`/`Profile.roles` only, or also
   suggest `roleArea` keywords? Leaning: skills/roles only for v1 — the
   user explicitly asked for "skills and stuff" onto Profile; `roleArea`
   already has its own dedicated template-picker UX from the prior epic.
2. Is the raw uploaded resume file persisted anywhere, or processed
   in-memory and discarded once extraction completes? Leaning: in-memory
   only — avoids a whole new sensitive-file-storage design surface, and
   nothing in the ask requires keeping the original file around after its
   content has been extracted into the draft.
3. What link types are actually supported in v1? Leaning: plain
   server-side `fetch()`-able public pages (GitHub profile/READMEs,
   personal portfolio/blog) — LinkedIn explicitly named as NOT reliably
   supported in v1, documented as a known limitation rather than a silent
   failure mode.
