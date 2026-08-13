# Research Brief: assisted-apply-drafting

## 1. Summary

The first real implementation of gigradar's INTERACT half (FIND is fully
built; INTERACT has been a documented `TODO(build)` stub since the first
epic). Scope for THIS epic, per the owner's own explicit framing: draft
generation (LLM-based, from Profile + gig data) → a real review/edit/
approve UI → status tracking through to submission — with actual
per-source automated form-filling AND the graduated auto-fire trust
system explicitly sequenced as separate, later epics (not silently
folded in here). This epic's "Done" bar is the human-approved half of
"assisted, not auto" — the architecture's own stated, confirmed-standing
principle, reaffirmed by the owner this session.

## 2. Key files & surfaces

- `src/lib/apply/runner.ts:91-107` — `ApplicationDraft` interface
  (`{gig, fields, status}`) and `stageApplication()`, currently an
  unimplemented throwing stub. The real target this epic builds.
- `src/lib/types.ts` — `Profile` (`name, roles, skills, timezone,
  homeBase`) has NO contact/apply-specific fields today (email, phone,
  LinkedIn URL, headline, bio, rate anchor) — a real gap for drafting a
  genuine application, not just matching one.
- `src/lib/store/schema.ts` — `SCHEMA_SQL`'s existing `IF NOT EXISTS`
  idempotent-migration pattern is the template for a new `application_drafts`
  table.
- `src/lib/config/schema.ts` / `load.ts` / `save.ts` — the established
  pattern for extending `Config`/`Profile` with new optional fields
  (matches `roleArea`/`schedule`'s existing "omitted = valid, not an
  error" convention).
- `src/app/dashboard-client.tsx` — the existing status-transition UI
  pattern (`New → Applied → Interview → Archived → Ignored` dropdown) —
  the draft-review UI's natural sibling, not a wholesale new pattern.
- **Legacy reference (structural pattern only — see §4's hard
  constraint)**: the private predecessor's `GATE.md` documents a real,
  already-proven **4-check auto-apply gate** (FIT: tier=green; ECONOMICS:
  clears rate floor; LIVE & NEW: not already applied/stale; FILLABLE: a
  human-reviewed draft exists) plus a separate **channel capability axis**
  (only a source with real, working submit automation can ever auto-fire
  — historically only ONE platform ever reached that bar). This is the
  exact shape `CONTEXT.md` already names as "not yet ported" — this
  epic's scope is deliberately narrower (draft + human-approve only); the
  4-check gate and channel-capability concepts are real, valuable
  reference for the LATER graduated-auto-fire epic, not built now.

## 3. Patterns & conventions

- LLM structured output via `@anthropic-ai/sdk` (already a dependency,
  `profile-overview-ingestion` epic) — the exact same tool-use/structured-
  output pattern used for resume extraction, reused for draft generation.
- The project's established "draft state in the client, nothing persists
  until an explicit save/approve action" UI pattern (`role-templates`'
  template picker, `resume-link-ui`'s extraction merge) — the draft-review
  UI's natural shape: an LLM-generated draft is NOT auto-saved to the DB
  as "approved"; it's staged, editable, and only transitions state on an
  explicit user action.
- `GigStatus`'s existing `"applied"` status already exists in the schema
  — this epic's draft/approval status lives on a NEW, separate table
  (drafts), not overloaded onto the existing gig status enum, since a gig
  can have a draft long before (or without ever) being marked "applied."

## 4. Constraints

- **Hard constraint, non-negotiable, learned the expensive way this
  session**: any "answer key" style reference material (universal form
  answers — real email, phone policy, LinkedIn URL, resume file path)
  is the owner's own real personal data. This epic builds the GENERIC
  MECHANISM (a `Profile` extension with these field SHAPES, populated by
  each user with their OWN values) — it must never contain the owner's
  actual real values anywhere in the gigradar repo, exactly the same
  core/user-layer boundary this project has held since kickoff, extended
  explicitly to this new field set. (This research was conducted by
  reading the legacy tool's real answer-key file for its STRUCTURAL
  shape only — the actual values seen were not transcribed here or
  anywhere in this epic's docs.)
- **"Assisted, not auto" is confirmed, not being revisited.** The owner's
  own answer this session: draft + human approval is the DEFAULT and
  starting behavior; a LATER, separate epic can build a graduated
  trust/auto-fire system (after enough manually-approved history proves
  draft quality), gated by the owner's own configurable verification
  rules — not built now.
- **No real per-source submit automation in this epic.** Even the legacy
  tool, after significant effort, only ever got ONE platform
  (GoFractional) to a genuine working auto-submit state — building real
  form-filling automation is real, source-specific engineering work,
  explicitly sequenced as a separate, later epic (the most natural
  candidate being GoFractional first, matching the legacy tool's own
  proven feasibility there).

## 5. Risks

- **Medium — LLM-drafted content quality/accuracy.** A drafted answer
  that fabricates or distorts the user's real experience would be a real
  harm (the legacy tool's own answer-keys doc explicitly calls out
  "accuracy landmines" — specific facts that are easy to garble). This
  epic's human-review-before-anything-happens gate is the primary
  mitigation; the draft generation prompt should be grounded strictly in
  the user's own `Profile`/resume content, never inventing unstated
  specifics.
- **Medium — `Profile`'s new apply-specific fields (email, phone,
  LinkedIn, etc.) are new, more sensitive personal data than anything
  `Profile` holds today.** Not secrets in the `env:`-reference sense, but
  genuinely personal contact information — worth a real design decision
  on whether these belong in the already-encrypted `config.json` (yes,
  by default, since it's already encrypted-at-rest) or need any
  additional handling.
- **Low — scope creep risk.** "Start actually sending applications" is a
  big, natural-language ask; this epic's job is to hold a narrow,
  honest, useful slice of it (draft + review + status tracking) rather
  than silently trying to build the whole INTERACT vision in one pass.

## 6. Open questions

1. Do the new apply-specific fields extend `Profile` directly, or live in
   a new, separate `ApplyProfile`/`ContactInfo` config section? Leaning:
   a new optional `Config.applyProfile` section (matching `roleArea`/
   `schedule`'s established "separate, optional, omitted = not
   configured" pattern) rather than growing `Profile` itself, since these
   fields are apply-specific, not fit-matching-relevant the way
   `Profile.skills`/`roles` are.
2. Where does a generated draft live once approved but not yet
   submitted — does the UI provide a direct "open the real listing +
   copy the draft" assist, or something more? Leaning: yes, exactly
   that — a copy-to-clipboard-ready draft + a direct link to the gig's
   real URL, with the user marking it "submitted" themselves (this
   epic's honest MVP; real auto-fill is the sequenced-later epic).
