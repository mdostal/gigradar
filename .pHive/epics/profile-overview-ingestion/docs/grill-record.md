# Grill Record — profile-overview-ingestion

**Source draft:** .pHive/epics/profile-overview-ingestion/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass — research-brief.md has no such field; used its Risks/Open Questions sections as focusing input instead)
**round_number:** 1
**unresolved_count:** 4

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: 1 finding
- Convention violations: 1 finding
- Posture mismatches: clean

## Vocabulary mismatches

No findings. "Profile," "Source," and "Config" are all used consistently
with CONTEXT.md's definitions; no term shifts meaning mid-document.

## Hidden assumptions

- **H1** — §3 step 2 assumes "plain `fetch()`, strip HTML tags to visible
  text" produces clean input for the LLM call, without accounting for
  `<script>` and `<style>` ELEMENT CONTENT. A naive tag-strip (removing
  `<...>` markup) leaves the TEXT CONTENT of those elements behind — raw
  JavaScript and CSS would leak into what's labeled "visible text" and get
  sent to the LLM as if it were page content, degrading extraction quality
  on any real, non-trivial site (most portfolio/GitHub-profile pages have
  meaningful `<script>` blocks).
  - Draft location: §3 step 2 ("strip HTML tags to visible text — no
    headless browser, no new dependency")
  - Why this matters: this is exactly the kind of page (GitHub profiles,
    personal portfolios) §3 step 6 names as the SUPPORTED case — if the
    stripping approach is naive, the flagship supported use case degrades
    silently rather than failing loudly.
  - Question for planner: should the implementation explicitly strip
    `<script>`/`<style>` (and their content) before the general tag-strip,
    and does the verification plan (§7) need a fixture page with realistic
    `<script>`/`<style>` content to catch a regression here?

- **H2** — §3 step 6's bot-wall detection heuristic ("very short body, or a
  login-form marker") is stated without any concrete threshold or
  definition, and without addressing the false-positive case: a
  legitimately short, valid personal portfolio/landing page (a common,
  realistic shape — e.g. a single-page "here's my GitHub and email" site)
  could trip a "very short body" heuristic and be wrongly rejected as a
  bot-wall, even though it's exactly the kind of link this epic is meant
  to support.
  - Draft location: §3 step 6 ("A fetch that comes back as an obvious
    bot-wall/login page (heuristic: very short body, or a login-form
    marker)")
  - Why this matters: an undefined heuristic can't be tested or reasoned
    about, and the failure mode (rejecting a legitimate short page) directly
    undermines the epic's own supported-link-types goal.
  - Question for planner: should this be a much narrower, higher-confidence
    check (e.g. specifically detecting known login-wall markers/redirect
    patterns for LinkedIn specifically, rather than a generic
    length-based heuristic that risks false-positiving on legitimate
    content), with a concrete minimum body-length threshold if length is
    used at all?

## Unresolved tensions

- **U1** — The epic's own §0 Prelude states its north star as getting the
  owner "to full, real use of the tool end to end without hand-editing
  JSON" (directly inherited from the project's stated north_star, used
  verbatim across this project's planning inputs since `dashboard-config-ui`:
  "...without hand-editing JSON or running CLI scripts"). But §5
  Dependencies and Constraints requires the user to "obtain and set their
  own `ANTHROPIC_API_KEY` in `.env`" — and the project's `/config` UI (per
  research-brief.md §2) only edits `config.json` via `saveConfig()`; there
  is no UI path to set an `.env` value. This means using the epic's
  flagship feature requires exactly the kind of manual dotfile-editing
  outside the UI that the epic's own stated goal is to eliminate — an
  unreconciled contradiction between the "done" bar and the actual
  onboarding requirement for this specific feature.
  - Draft location: §0 (north star framing), §5 ("Requires the user to
    obtain and set their own ANTHROPIC_API_KEY in .env")
  - Tension: "no hand-editing dotfiles/JSON" (stated goal, this epic and
    every prior one) vs. "requires hand-editing .env to use this epic's
    own headline feature" (as currently scoped).
  - Question for planner: is manually setting one `.env` line an accepted,
    named exception for this one credential (analogous to how
    browser-session sources still needed SOME initial setup before the
    guided capture UI existed) — in which case the design doc should say so
    explicitly rather than silently requiring it — or does this epic need a
    minimal "set your Anthropic API key" field in the config UI (writing to
    `.env`, not `config.json`, a genuinely new write-path this design
    doesn't currently include) to actually hit its own stated bar?

## Convention violations

- **C1** — §3 step 5 claims this feature "reus[es] the exact draft-then-Apply
  UX from `role-templates`' template picker," but `role-templates`'
  documented design decision (its own `epic.yaml`/story `design_decisions`)
  is explicit: "Applying OVERWRITES the current draft (no confirmation
  dialog for v1)." This draft instead specifies MERGE-AND-DEDUPLICATE
  semantics ("merged (appended, de-duplicated) with whatever's already in
  the draft rather than replacing it outright"). Merge-not-overwrite is a
  reasonable, arguably better choice for enrichment-from-a-resume (additive
  information, not a full profile reset) — but claiming to reuse "the
  exact" prior UX while silently changing its core behavior is internally
  inconsistent, and a future reader comparing the two features would be
  misled about why they behave differently.
  - Draft location: §3 step 5
  - Convention: `role-templates` story's documented design decision
    (Apply = overwrite, no confirmation) — this draft's actual behavior
    diverges from it
  - Question for planner: revise §3 step 5 to state plainly that this
    diverges from `role-templates`' overwrite semantics, and why (resume
    content is additive/enrichment, not a full-profile reset) — reusing
    only the UI SHAPE (draft state + review + explicit Save), not the
    overwrite-on-apply behavior?

## Posture mismatches

No findings. The draft explicitly names and mitigates its one real posture
shift (first external API call, first LLM use, in a project whose stated
posture has been "single-user, local install") as its own top-listed risk
(§4, High) with a stated, specific mitigation (explicit opt-in, per-use,
never automatic) — this is surfaced and justified, not a silent departure,
so it doesn't meet grill's bar for a posture-mismatch finding (which is
for UNACKNOWLEDGED departures).

## Notes

The design doc's in-memory-only decision for the uploaded resume (§3 step 3,
resolving research-brief open question #2) is a genuinely strong choice —
it eliminates an entire class of findings this pass would otherwise expect
to raise (new sensitive-file storage location, retention/deletion policy,
encryption-at-rest scope questions) by construction rather than by an added
safeguard. Worth the planner explicitly preserving this decision through
story-writing, not loosening it for implementation convenience.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; revising
the draft (or documenting accepted deviations) is the next step, owned by
design-discussion, not by this record.
