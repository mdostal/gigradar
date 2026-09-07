# Design discussion: usability-and-completeness-audit

## 0. Trigger

Owner, 2026-09-07, after a full day of real fixes: "we have to get this
running so I can truly track engagements and do real applications...
right now, considering this is missing data, isn't solid, isn't actually
doing much... the drafts make no sense how it is done... the old shitty
gig radar on the dostal@hive and the command center had more functionality
being derived directly through the AI than this... we have to spend the
week fixing this up to be useful." He asked for 3 real, deep review passes
(code/refactor, product/feature-completeness, UI/UX with real visual
verification via `simman`), plus a resume-store feature, plus a precise
root-cause on the draft-format confusion. Four parallel research passes
were run (never implementing, evidence-only) before this epic was written
— findings below.

## 1. Emergency finding made DURING this research, not by design: the scan
pipeline can hang forever

Not one of the requested 3 passes — found while checking whether the
crawler-enrichment fix (merged earlier today) had reached real data.
**Live-confirmed twice today**: a manual `npm run radar` run sat at 0.0%
CPU with zero database writes for a full 60 minutes before being killed;
separately, the production `com.mdostal.gigradar-scheduler` launchd process
hung the identical way for over an hour immediately after being restarted
with the day's fixes. Root cause, confirmed by reading the code directly:
`runRadar()`'s own source loop (`src/lib/apply/runner.ts:88-103`) is a
plain sequential `for (const sc of config.sources...) { gigs = await
src.fetch(...) }` — no `Promise.race` against a deadline, no
`AbortController`, no per-source timeout of any kind. A per-source error
(bad login, verification challenge, bad extraction recipe) is caught and
recorded cleanly — that machinery works, confirmed in the error log. But a
source whose `fetch()` never SETTLES at all (never resolves, never
rejects — a network call or browser step that just hangs) blocks this
`await` forever, and because the loop is sequential, every source after it
in `config.sources` never even gets a chance to run that cycle. This is
filed as triage entry **t-001** (`.pHive/triage/queue.yaml`,
priority p0/critical) per the owner's own instruction to route real
findings through `/hive:triage`. Confirmed via process inspection (no
child Chrome/real-chrome-profile process spawned during the latest hang)
that this specific hang was NOT the browser-automation path — it's most
likely a plain `fetch()` in one of builtin/linkedin/fractionus/
fractionaljobs/fractionalfinders/braintrust with no client-side timeout,
though the exact source needs to be pinned down live rather than guessed
further (see story A).

**Why this matters more than any other finding here**: this is the actual
mechanism keeping the owner's real data current. Every fix shipped today
(the gate() roleArea fix, the crawler enrichment) sat unable to reach real
data for a large fraction of today specifically because of this bug — it
is the most likely reason "I'm not seeing shit in gig radar" has persisted
even after real, verified-correct fixes landed upstream of it.

## 2. Draft-format confusion — real, precise root cause found

Real research against the owner's live database + full read of
`src/lib/apply/draft.ts`: `resolveApplicationFormat()` (draft.ts:129) is
correctly wired into the ONE real draft-creation path
(`stageApplication()`, `runner.ts:337`), used identically by both the
manual "Generate draft" UI action and `auto-draft-on-scan` — no bypass, no
display-layer bug (drafts-client.tsx already branches correctly on
`format`). The real bug: of gigradar's 10 real source adapters, only
`gofractional.ts` (`"why-fit"`) and `linkedin.ts` (`"form-fields"`)
actually set a real `Source.applicationFormat` — the other 8
(`fractionus`, `fractionaljobs`, `builtin`, `wellfound`, `braintrust`,
`ateam`, `fractionalfinders`, `gun-io`) have none, so every draft from them
silently falls through to the documented `"cover-letter"` default. That's
why the owner has only ever seen cover-letter-shaped drafts: `builtin`
(8 real drafts) and `fractionus` (4 real drafts) are the ONLY sources that
have ever actually produced a draft, and neither has a real
`applicationFormat` set. `linkedin` (428 gigs, the one source with real
`"form-fields"` differentiation already coded) has had ZERO green-tier
matches this whole time (its own separate, already-known "fractional"
search-keyword-noise problem), and `gofractional` has been
Cloudflare-blocked/in scheduler backoff for days — so the two sources that
already had correct format differentiation have simply never gotten the
chance to produce a draft to compare against. A live `simman` vision-model
pass (see §4) independently CONFIRMS the display side works correctly:
when a seeded draft had `format: "form-fields"` set, the real UI rendered
genuinely different, format-aware copy the vision model itself correctly
described. This is a **pure data-coverage bug**, not a display bug and not
a resolution-logic bug — 9 of the 12 real stored drafts also simply predate
`DraftFormat` existing at all (pre-PR-#106, format key absent entirely),
which additionally muddies what the owner has been looking at.

## 3. Resume store — real inventory, clean extension path

`src/lib/documents/resume-store.ts` stores exactly ONE resume at a fixed
path (`resume.enc`, always overwritten, encrypted at rest via the same
`vault.ts` mechanism as `config.json`) — its own header comment already
says this was a deliberate, deferred decision ("ONE resume, not
versioned"). Referenced by one config field
(`ApplyProfileConfig.resumePath`), consumed by `prep.ts`'s
`generatePrepPacket()`. The chat co-pilot's real `propose_config_edit` tool
(`agent-chat-loop.ts:77`) establishes the exact gated-suggestion SHAPE this
epic's review-suggestions feature should follow: propose → pause for
owner approve/reject by default → apply, with a separately-configured
auto-apply escape hatch that still surfaces a mandatory warning banner —
not a literal reuse (that tool is scoped to config.json edits
specifically), but the same UX contract. Real, scoped new work: (a)
keyed/versioned multi-resume storage (redesign resume-store.ts's
single-fixed-path shape), (b) associating a specific resume with a specific
gig/draft (no such concept exists anywhere in the schema today), (c) a
resume-vs-gig fit/suggestion feature (can extend `generatePrepPacket()`'s
existing real fit-scoring LLM call rather than build new matching logic
from scratch), (d) a review-suggestion UI following `propose_config_edit`'s
approve/reject contract.

## 4. Broad code-quality + product-completeness + UI/UX passes — findings

**Code quality (pass 1)**: reassuring. Zero TODO/FIXME/HACK markers, zero
silent catch blocks, in the core matching/apply/store/sources/scheduler
pipeline. Checked specifically for the "two independent copies of the same
logic silently disagreeing" bug class the `gate-fit-check-too-strict` fix
was earlier today — found NO other instance; `score-tiering.ts`,
`tiering.ts`, `match-band.ts`, `rank-bucket.ts` all correctly reuse each
other's exported functions rather than reimplementing. One real, low-
severity housekeeping item: `src/app/embedded-webview-spike/page.tsx`
(added PR #155) is an orphaned dev-only spike page, not linked from nav,
never referenced — harmless, but should be deleted.

**Product completeness (pass 2)**: gigradar's real nav surfaces
(Dashboard, All Gigs, Today, Metrics, Drafts, Profile assist, Chat, Issues,
Setup, Config) are ALL genuinely, substantively wired — no second instance
of today's `gig-detail-embedded-apply-entry-point`-style disconnected-
capability bug was found in the time available. **The legacy-tool
comparison does not hold up**: SSH research into `dostal@hive`'s
`~/Code/gig-radar/` (read-only, no credentials touched) found it is a flat
pile of ~35 one-off scripts, not a structured app, and its ENTIRE real
AI/LLM usage is a single script (`interview-prep.mjs`) that gigradar's own
`generatePrepPacket()` already matches and arguably exceeds (reads real
Config/Profile instead of a hardcoded personal blurb baked into source).
The legacy tool has zero chat/co-pilot/self-tuning capability at all —
gigradar's chat co-pilot is a real capability the legacy tool never had.
**This specific complaint appears to be an impression, not a verified
gap** — worth telling the owner directly rather than chasing a phantom
feature; if he has something more specific in mind about what "felt more
AI-powered," that's worth asking him directly.

**UI/UX (pass 3, real simman vision-AI runs, not just code-reading)**: ran
against an isolated seeded instance (never real data). Confirms §2's
finding directly (a format-aware draft rendered correctly). One new, real
finding: asked simman to "add a new tracking group" from Config — it
tapped the identical "Groups & Needs" text twice (sidebar nav label, then
a card) and the synthesized plan terminated at "the editing interface is
displayed" without ever finding/clicking an actual "add new group"
affordance in 2 steps. Inconclusive on its own (could be a real
discoverability gap, or just a shallow exploration budget) — worth a
targeted, deeper look, not a certain bug.

## 5. Scope for this epic

Four real, independently-shippable stories below. Explicitly OUT of scope:
chasing the legacy-tool "AI-derived functionality" gap further (report
back to the owner instead, per §4); the "add group" simman finding gets
its own small story since it's concrete enough to investigate directly,
not folded into anything bigger.
