# Design discussion: match-quality-feedback-loop

## 0. Trigger

Owner, 2026-09-07, in direct response to the `gate-fit-check-too-strict`
bug (a real GREEN-tier gig silently gated out, undetected for weeks):
"the ai checks should have caught and helped to suggest and improve
that -- get that into a plan." This is a real, planned epic per that
request — NOT dispatched for immediate execution (unlike
`gate-fit-check-too-strict`, which is the urgent fix); this is the
longer-term structural answer to "how do we stop this class of bug from
hiding silently again."

## 1. Why the EXISTING AI-verification feature could not have caught this

`ai-match-verification` (`matching/ai-verify.ts`) is explicit about its
own scope, in its own header comment: it runs ONLY on groups a gig
ALREADY, heuristically matched (i.e., already cleared `gate()`). A gig
`gate()` rejects — exactly what happened to the CTO listing this session
found — never reaches `ai-verify.ts` at all. Architecturally, the
current AI-verification layer has ZERO visibility into anything `gate()`
throws away. This is a real, structural blind spot, not a tuning
problem with the existing feature.

## 2. What this epic should build

A genuinely new capability: periodic (or on-demand) AI review of a
sample of REJECTED gigs, looking for ones that plausibly SHOULD have
matched, and producing concrete, actionable, owner-reviewed suggestions
— never an auto-apply, matching this codebase's own "assists, never
auto-submits" posture (`auto_fire_trust_spec`) and the chat co-pilot's
own existing `propose_config_edit` gated-suggestion pattern (reuse that
mechanism rather than inventing a second one).

Rough shape (needs its own real `/plan` pass before building — this
design-discussion is scoping, not a finished spec):

1. A scheduled or on-demand job samples recently-rejected gigs (gate()
   `pass: false`) — bounded (cost control; an LLM call per rejected gig
   at real scan volume is not viable) to some real cap, prioritizing
   ones with a real signal worth checking (e.g., the group's own tier
   said GREEN/YELLOW despite the gate rejecting it -- the EXACT
   inconsistency class `gate-fit-check-too-strict` found, which is now
   fixed for the ROLE-fit path specifically, but the same inconsistency
   could recur for a DIFFERENT reason later, e.g. a rate-parsing bug, a
   new profile field, etc. This job is the general-purpose backstop for
   whatever the NEXT version of this bug class looks like, not
   redundant with this session's specific fix).
2. For each sampled gig, ask an LLM (reusing this app's existing
   LLM-provider harness, never a new parallel integration — see
   `llm-provider-harness` epic): "here's a gig gate() rejected, here's
   why (the real `MatchResult.reasons`), here's the owner's real
   profile/group config -- does this look like a real miss? If so, name
   the SPECIFIC config field and change that would fix it (a keyword to
   add, a rate floor to adjust, etc.), grounded in the actual reasons
   text, never a vague 'update your config' non-answer."
3. Surface suggestions in the UI as real, dismissible/actionable items
   — likely alongside or reusing the existing Issues system
   (`src/lib/notify/issues.ts`) rather than inventing a third
   "things needing your attention" surface, OR the chat co-pilot's
   existing `propose_config_edit` flow if that fits better structurally
   -- a real decision the `/plan` pass for this epic should make with
   research, not guessed here.
4. Never auto-applies a suggested config change. The owner reviews and
   approves, same as every other config-editing surface in this app.

## 3. Explicitly out of scope for this design-discussion

- Which exact UI surface / whether it's the Issues system or chat
  co-pilot's propose_config_edit — a real `/plan` decision, not
  pre-decided here.
- Whether this replaces or supplements `ai-match-verification` — likely
  supplements (different scope: rejected vs. already-passed gigs), but
  worth explicit confirmation during planning.
- Cost/frequency tuning specifics (how many gigs sampled per cycle,
  whether it's opt-in) — needs real design attention given LLM call
  cost at scan volume.

## 4. Status

Planned, not started. This epic exists so the idea is captured as a
real, concrete backlog item (per the owner's own explicit request) —
`/plan` should be run properly on this (full research + design pass,
not the lean single-turn treatment `gate-fit-check-too-strict` got
under time pressure) when it's time to build it.
