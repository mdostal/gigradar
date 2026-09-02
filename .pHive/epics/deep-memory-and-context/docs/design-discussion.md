# deep-memory-and-context — design discussion

Follow-on epic 4 of 4 (platform-aware drafting, embedded browser/focus,
**deep memory**, UI overhaul) scoped in
`deep-dive-audit-and-testing-framework`'s own design-discussion.md as:
"Chat system prompt design, resume/career-history reaching
generateDraft()/verifyGroupMatch() (not just prep packets), a real
structured career-history data model — connects to the already-flagged,
still-unplanned career-crm extraction reference."

## 1. Current-state research (background research pass, this run)

- **Chat system prompt**: already shipped — `agent-chat-loop.ts`'s
  `buildSystemPrompt()` (deep-dive-audit epic, PR #103) sends identity
  grounding + `listPreferences(MAX_PREFERENCES_IN_PROMPT=20)`. This part of
  the epic's name is already closed; not re-touched here. `StoredChatPreference`
  is 100% free text — the "should preferences become structured facts"
  question is still open (`chat-copilot-self-tuning` design doc §3b) but is
  a separate, later decision, not blocking this epic's actual gap.
- **The real, confirmed gap**: `generateDraft()` (`draft.ts`) and
  `verifyGroupMatch()` (`matching/ai-verify.ts`) both only ever saw
  `Profile`'s shallow `{roles, skills, timezone, homeBase}` fields — never
  the applicant's real resume file, even though `career-documents` already
  persists one and `apply/prep.ts`'s `generatePrepPacket()` has attached it
  (via `loadResume()`/`buildResumeContentBlock()`) since that epic shipped.
  The two call sites the epic's own name calls out simply never adopted
  that already-proven mechanism.
- **Structured career-history data model**: does NOT exist anywhere in
  this codebase. `Profile` has no work-history/dates/projects/quantified-
  achievements fields. `career-crm`'s own design doc never proposed one —
  it explicitly judged gigradar's existing `Profile` shape as *already
  better* than the predecessor tool's hand-written markdown-string
  approach, and deferred richer things (weekly checklists, message
  templates) that are unrelated to a structured history model.

## 2. Scope decision (made directly, matching Epic 2/3's own precedent —
no owner gate needed, low-risk extension of an already-proven pattern)

**In scope, this run**: extend `generateDraft()` and `verifyGroupMatch()`
to attach the real resume file the exact same way `prep.ts` already does —
reusing `loadResume()`/`buildResumeContentBlock()` verbatim, never a second
implementation. `verifyGroupMatch()` also gains `profile`/`applyProfile`
parameters (previously had zero candidate signal at all — pure gig-vs-
GroupConfig comparison), with a deliberately MINIMAL candidate-background
block (roles/skills only, no contact info/links — this check has no
legitimate reason to see PII the way a draft does) plus the same optional
resume attachment. The added context stays scoped to ROLE-TYPE
disambiguation ("is this genuinely the kind of role being searched for"),
explicitly NOT personal-fit judgment (`prep.ts`'s own separate job) — the
prompt wording says so directly, to avoid scope-blurring the feature.

**Explicitly deferred, documented not dropped**: a real structured
`CareerHistory` data model (work history, dates, project-level detail,
quantified achievements). This is genuine greenfield work with zero prior
art anywhere in this codebase or in `career-crm`'s own design docs — a
speculative data-model invention without real owner input on what fields
matter would be a worse outcome than not building it. The resume-file
attachment shipped this run already closes most of the practical gap (the
LLM sees the *actual* resume content, unstructured but complete, for both
drafting and role-type verification) — a structured model would mainly
help NON-LLM consumers (e.g. deterministic keyword matching against a
structured field) that don't exist yet either. Better scoped as its own
future epic if/when the owner has a concrete shape in mind, per the
already-flagged `career-crm` extraction reference
(`project_gigradar_career_tracker_interview_prep` memory).

## 3. Stories

- `attach-resume-to-draft-generation` — `generateDraft()` gains resume-file
  attachment via `loadResume()`/`buildResumeContentBlock()`, switching its
  AI-SDK call from a single string `prompt` to a `messages`/content-blocks
  array (mirrors `prep.ts` exactly) so a PDF resume can be embedded
  natively, not just as extracted text.
- `attach-resume-and-profile-to-match-verification` — `verifyGroupMatch()`
  gains `profile`/`applyProfile` parameters plus the same resume
  attachment; `applyAiVerification()`'s signature and its one real call
  site (`apply/runner.ts`'s `runRadar()`) updated to pass `config.profile`/
  `config.applyProfile` through.
