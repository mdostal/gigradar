# Design Discussion: assisted-apply-drafting

## 0. Prelude

**NORTH STAR**: "start actually sending applications through it" — with
the owner's own explicit, confirmed answer this session: draft + human
approval is the default; a graduated auto-fire trust system (per-source/
tier, gated by the owner's own configurable verification rules, earned
after enough approved history) is real but explicitly a LATER epic, not
this one. This epic is the foundation everything else builds on: real
LLM-drafted applications, a real review/edit/approve workflow, and status
tracking through to submission.

No relevant prior decisions in the shared KG beyond this project's own
epics (same cross-project noise pattern every prior query hit — disregarded).

## 1. What Are We Doing?

1. **`Config.applyProfile`** (new, optional section) — the apply-specific
   fields a real application form needs that `Profile` doesn't hold
   today: email, phone, LinkedIn URL, headline, a short bio, and a rate
   anchor. Encrypted at rest for free (same `config.json` vault).
2. **`stageApplication()`, implemented for real** — an LLM call
   (`@anthropic-ai/sdk`, the same structured-output pattern
   `profile-overview-ingestion` already uses) drafts a per-gig
   application (cover text + any structured answers) from `Profile` +
   `Config.applyProfile` + the gig's own title/company/description.
   Grounded strictly in what the user has actually provided — never
   inventing unstated specifics.
3. **A new `application_drafts` table** — persists each draft, linked to
   a gig by key, with a status (`draft → approved → submitted` or
   `rejected`), separate from the gig's own `status` field (a gig can
   have a draft long before, or without ever, being marked "applied").
4. **A review/approve UI** — a new dashboard section listing pending
   drafts: full editable text, an Approve/Reject action, and (once
   approved) a direct link to the real gig URL plus a copy-ready draft —
   the user completes the actual submission themselves and marks it
   submitted. Real per-source auto-fill is explicitly NOT built here.

"Done": the owner can see a real, LLM-drafted application for a real gig,
edit it if needed, approve it, and have a fast, low-friction path to
actually submitting it on the source's real site — with every draft
grounded in their own real profile data, nothing fabricated, and nothing
ever auto-submitted.

## 2. What I Found

- `ApplicationDraft`/`stageApplication()` have existed as an unimplemented
  stub since the project's first epic — this is the real implementation,
  not a new concept.
- `Profile` has no contact/apply-specific fields today — a genuine gap
  for drafting (not just matching) an application.
- The legacy tool's real, proven 4-check gate + channel-capability
  concept (structural pattern only, no real values ever transcribed) is
  exactly what `CONTEXT.md` already names as "not yet ported" — directly
  validates that this is real, previously-scoped work, not a new
  invention, and gives the LATER auto-fire epic concrete prior art to
  build from.
- The project's established "draft in client state, nothing persists
  until an explicit action" UI pattern (role-templates, resume-link-ui)
  is the natural shape for the review/approve UI.

## 3. My Proposed Approach

1. **`Config.applyProfile` schema** — resolves research brief open
   question #1: a NEW, separate, optional `Config` section (matching
   `roleArea`/`schedule`'s established "omitted = not configured, not an
   error" pattern), not grown onto `Profile` itself, since these fields
   are apply-specific (needed to FILL a form), not fit-matching-relevant
   the way `Profile.skills`/`roles` are:
   ```
   ApplyProfileConfig {
     email: string
     phone?: string
     linkedInUrl?: string
     headline?: string
     bio?: string
     rateAnchor?: number   // the single number to anchor when a form asks for one
   }
   ```
   Zod schema mirrors it exactly, same `ConfigSchema.optional()` pattern.
   Encrypted at rest automatically — `config.json`'s existing vault
   coverage, no new storage mechanism. **Config UI extension named
   explicitly (collaborative-review finding)**: `config-client.tsx`'s
   `DraftConfig`/`configToDraft()`/`draftToEdits()` have no hook for a
   new optional section today — this story must add a
   `DraftApplyProfile` (mirroring `DraftRoleArea`'s enabled-flag tri-state
   pattern exactly) and extend the draft-conversion functions, not just
   the schema layer.
2. **`src/lib/apply/draft.ts`** (new) — `generateDraft(gig, profile,
   applyProfile, apiKey): Promise<DraftContent>`. One Anthropic Messages
   API call, structured tool-use output (`{coverText: string, answers:
   Record<string,string>}`), prompt grounded strictly in the real
   `Profile`/`applyProfile`/gig data passed in — explicit instruction to
   the model to never fabricate unstated experience/figures (directly
   addresses research brief's "accuracy landmines" risk).
   **API-key resolution corrected (collaborative-review finding, real
   context difference)**: the design originally claimed this "matches
   `extract.ts`'s pattern exactly," but `extract.ts`'s actual pattern is
   that its CALLER resolves the key (via `readEnvVar()`, since Server
   Actions never populate `process.env` — only `loadConfig()`'s CLI/cron
   path does) and passes it in as a parameter — `extractProfile()` itself
   never resolves anything. `generateDraft()` follows that SAME real
   shape: `apiKey` is a required parameter, resolved by whichever caller
   invokes it (the CLI/MCP path can read it from the already-populated
   `process.env` post-`loadConfig()`; a future dashboard Server Action
   would use `readEnvVar()`, exactly like `extractProfileFromResumeAction`
   does) — `draft.ts` itself stays agnostic to which calling context
   resolved the key, never assumes `process.env` is populated. Untrusted
   gig content handling: see the new item added to §4 below.
   **Missing-applyProfile handling decided (added
   post-grill, resolves H2 below)**: `Config.applyProfile` is optional
   (§3 step 1); `stageApplication()` throws a specific, actionable error
   ("Set up your apply profile in /config before generating a draft")
   when it's unset, rather than attempting a degraded draft with
   garbled/missing contact fields — matches this project's established
   "throw loud, don't silently degrade" convention (e.g.
   `browser-session.ts` throwing on a missing session file).
   **Tier guardrail decided (added post-grill, resolves U1 below)**:
   `stageApplication()` also throws a specific error for `tier ===
   "red"` — a minimal, common-sense guardrail (never spend a real LLM
   call drafting for a gig the tiering system already flagged as
   clearly off-target), distinct from and much narrower than the full
   4-check gate (economics/live-new/fillable checks are explicitly NOT
   built here — those stay scoped to the later auto-fire epic). Green
   and yellow tiers are both draftable — yellow is "unknown, worth a
   look," never a hard reject, per this project's own tiering
   philosophy.
3. **`application_drafts` table** (new, `schema.ts`'s existing `IF NOT
   EXISTS` pattern):
   ```sql
   CREATE TABLE IF NOT EXISTS application_drafts (
     gig_key      TEXT PRIMARY KEY REFERENCES gigs(key),
     content      TEXT NOT NULL,      -- JSON-stringified DraftContent
     status       TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','approved','rejected','submitted')),
     generated_at TEXT NOT NULL,
     approved_at  TEXT,
     submitted_at TEXT
   ) STRICT;
   ```
   `src/lib/store/drafts.ts` (new, mirrors `gigs.ts`'s shape):
   `saveDraft()`, `getDraft(gigKey)`, `listDrafts(filter)`,
   `setDraftStatus(gigKey, status)`.
4. **`stageApplication(matchResult)` implemented**: calls
   `generateDraft()`, persists via `saveDraft()` with status `"draft"`,
   returns the `ApplicationDraft`. Callable from the CLI/MCP (a natural
   `stage_application` MCP tool addition, though wiring that into
   `src/mcp/server.ts` is this epic's own story, not a separate epic) and
   eventually a dashboard "Generate draft" action per green/yellow-tier
   gig.
5. **Review/approve UI** — resolves research brief open question #2: a
   new `/drafts` page (or a dashboard section, implementation's call)
   listing pending drafts — full editable text (Server Action to save
   edits back to `content`), Approve/Reject buttons (`setDraftStatus()`),
   and once approved: the real gig URL (opens in a new tab) + a
   copy-to-clipboard-ready draft. The user completes the actual
   submission on the source's real site themselves, then marks it
   "submitted" (a status transition, same UI pattern as the dashboard's
   existing gig-status dropdown). Real per-source auto-fill (Playwright
   form-filling) is explicitly NOT built in this epic.
   **Status sync decided (added post-grill, resolves H1 below)**: marking
   a draft `"submitted"` ALSO transitions the linked gig's own `status`
   to `"applied"` — one user action, both consistent state updates.
   Otherwise a user could end up with a draft showing "submitted" while
   the gig itself still shows "new" in the main dashboard — exactly the
   confusing desync this epic exists to prevent, not introduce. Marking a
   draft `"rejected"` does NOT change the gig's status (rejecting a draft
   isn't a claim about the gig itself, just that draft).
   **Made genuinely atomic (collaborative-review finding)**: `setStatus()`
   is a standalone single UPDATE (confirmed by code read) — the
   submitted+applied sync is a NEW combined function
   (`markDraftSubmitted(gigKey)`, in `store/drafts.ts`) wrapping both the
   draft-status update and the gig-status update in ONE `withTransaction()`
   call, the exact pattern `recordScan()` already uses — never two
   separate, non-atomic calls, which could leave the desync grill H1 was
   raised to prevent if a crash happened between them.

## 4. What Could Go Wrong

- **Medium — LLM-drafted content could fabricate or distort real
  experience** (the "accuracy landmines" risk). Mitigated by: (a) the
  generation prompt explicitly instructed to ground strictly in provided
  data, never invent; (b) the human-review-and-edit gate before ANYTHING
  happens; (c) nothing is ever auto-submitted regardless of draft
  quality.
- **Medium — `Config.applyProfile`'s new fields (email, phone, LinkedIn)
  are more personal than anything `Profile` holds today.** Mitigated:
  already covered by `config.json`'s existing encryption-at-rest vault —
  no new storage mechanism, no new exposure surface, just new field
  names in an already-protected file.
- **Low — scope creep back toward the full INTERACT vision.** Explicitly
  held to draft+review+status-tracking only; real per-source submit
  automation and the graduated auto-fire gate are named, sequenced,
  separate future epics, not silently absorbed here.
- **Medium — prompt injection via untrusted gig content (added,
  collaborative-review finding).** A gig's `title`/`company`/`description`
  is untrusted, scraped, third-party content — structurally identical to
  `profile-overview-ingestion`'s already-flagged fetched-link-text risk.
  Fed unguarded into `generateDraft()`'s prompt, adversarial content in a
  scraped listing could attempt to manipulate the drafted output or probe
  for the user's contact info to be echoed back inappropriately.
  Mitigation: the SAME untrusted-content framing/delimiting treatment
  already established for link-fetched text — gig content is clearly
  delimited/labeled as DATA in the prompt, with an explicit instruction
  that content within it is never treated as instructions to the model.
  The human-review-before-anything-happens gate remains the final
  backstop regardless.

## 5. Dependencies and Constraints

- Depends on `@anthropic-ai/sdk` (already a dependency,
  `profile-overview-ingestion`), the existing store/schema patterns, and
  the existing config encryption vault (`encrypted-local-storage`).
- No new runtime dependencies.
- Real API cost per draft generation (same accepted tradeoff as
  `profile-overview-ingestion`'s resume extraction — an explicit,
  user-triggered action, not automatic/scheduled).

## 6. Open Questions

1. ~~Where do apply-specific fields live?~~ — **resolved**: new, separate
   `Config.applyProfile` section, §3 step 1.
2. ~~What does "approved" actually enable?~~ — **resolved**: a
   copy-ready draft + direct link to the real gig, user completes
   submission themselves, §3 step 5.

## 6a. Grill Findings Addressed

Grill round 1 (`.pHive/epics/assisted-apply-drafting/docs/grill-record.md`,
`unresolved_count: 3`) surfaced 3 findings, all resolved:

- **H1** (draft-submitted vs. gig-applied status sync unaddressed) —
  resolved in §3 step 5: marking a draft submitted also transitions the
  linked gig to "applied," one action, both consistent states.
- **H2** (missing-`applyProfile` case for `generateDraft()` unaddressed)
  — resolved in §3 step 2: throws a specific, actionable error pointing
  at `/config`, rather than attempting a degraded draft.
- **U1** (no tier restriction, despite citing the legacy tool's own
  "Red never applies" principle as prior art) — resolved in §3 step 2: a
  minimal red-tier guardrail added, explicitly distinct from and much
  narrower than the full 4-check gate reserved for the later auto-fire
  epic.

## 6b. Collaborative Review Findings Addressed

One backend/security-lens review, run against the grill-revised draft,
confirmed the FK relationship is clean (`gigs.key` matches exactly, and
`PRAGMA foreign_keys = ON` is already set) and surfaced 4 concrete
findings — all grounded in direct reads of the real current code, all
resolved:

- The config UI (`DraftConfig`/`configToDraft()`/`draftToEdits()`) needs
  explicit extension for the new optional section, not just the schema
  layer — §3 step 1.
- The API-key resolution claim overstated "same pattern as extract.ts" —
  corrected to match its REAL shape (the caller resolves and passes the
  key in; `draft.ts` itself stays agnostic to calling context) — §3
  step 2.
- The submitted→applied status sync needed to be a genuine
  `withTransaction()`-wrapped atomic operation, not two separate calls
  that could desync on a crash — §3 step 5.
- Gig content fed into the drafting prompt is untrusted, scraped,
  third-party data — the same prompt-injection risk class already
  identified for `profile-overview-ingestion`'s link-fetching, now
  addressed here too — §4.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest; @anthropic-ai/sdk (existing dependency)
  Platforms: Node.js
  Automated: draft.ts unit tests with a MOCKED Anthropic client (no real
    API calls in the automated suite, matching this project's existing
    convention) — covers structured-output parsing, prompt grounding
    (asserting the prompt includes only the real provided profile/gig
    data, never placeholder/invented content), and API-key-per-call
    resolution (not module-scope, matching the established pattern).
    store/drafts.ts tests mirroring gigs.ts's existing test shape —
    save/get/list/status-transition correctness, including the
    gig_key foreign-key relationship. UI tests for the review/approve
    flow's status transitions (draft -> approved -> submitted,
    draft -> rejected).
  Manual: a real end-to-end run — generate a draft for one of the
    owner's own real tracked gigs, review/edit it in the UI, approve it,
    confirm the copy-ready content and real gig link both work, and
    manually complete a real submission to prove the full loop actually
    gets an application out the door (the epic's own stated goal).
  Not verifying: real per-source auto-fill/submit automation (explicitly
    a separate, later epic); the graduated auto-fire trust system
    (explicitly a separate, later epic, needs real approval history to
    graduate from).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~14-16 (Config.applyProfile schema + config UI fields,
    src/lib/apply/draft.ts + tests, new store/drafts.ts + schema
    addition + tests, new review/approve UI page + Server Actions,
    stageApplication() real implementation, docs/ARCHITECTURE.md update)
  Subsystems: a genuinely new "draft" concept spanning config (new
    profile fields), store (new table), apply (real LLM drafting), and
    UI (new review workflow) — the most cross-cutting epic since
    dashboard-config-ui
  Migration required: no — purely additive (new optional config section,
    new table, new UI page)
  Cross-team coordination: no
  Unknowns: 0 remaining (both open questions resolved above)

  RECOMMENDATION: Needs H/V planning (Medium-Large)
  RATIONALE: This is the first epic to touch config schema, store schema,
    LLM drafting, AND a new UI surface all at once — genuinely
    cross-cutting, unlike this session's recent smaller, single-surface
    epics. Sequencing matters: the applyProfile config + drafts table +
    draft-generation module should land and be proven first (mirroring
    every prior epic's isolate-the-foundation pattern — vault-module,
    profile-ingestion-module), with the review/approve UI as a dependent
    second story built on top of a working, tested foundation.
```
