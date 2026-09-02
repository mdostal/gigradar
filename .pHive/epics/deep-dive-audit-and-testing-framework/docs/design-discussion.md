# Design Discussion: gigradar Deep-Dive Audit + Testing Framework

## 0. Origin

Owner's own words (2026-09-02, verbatim excerpt): "a DEEP DIVE CHECK and full
testing framework around the gig radar. Currently the gig radar local
instance has a bunch of poorly configured things, is slow/broken often,
doesn't maintain state correctly (i don't see the jobs i've actually applied
to) seems to be missing the auto update notification and install/restart
ability... has HORRIBLE memory... it is pulling old and poorly structured
data... it is drafting things as if i'm going to be EMAILING them -- when
there are specific forms and things to be filled out PER PLATFORM... any of
the side by side, guided stuff, AND browser openings need to be brought INTO
THE APP... AND we have to break down a whole UI update and epic using the UI
squads."

This is a single message naming six distinct problem areas plus a UI
overhaul ask. Per the owner's own explicit instruction ("we've gone through
this and it keeps ignoring doing this the hive manner where we deep dive,
create slices and improve this"), this planning run's job is to (a) actually
verify each claim against real code/data before proposing fixes, and (b)
propose a clean multi-epic breakdown rather than cramming six unrelated
problem domains into one epic. Six parallel research agents ran against the
real codebase (and, where safe — copies only, never the live data dir
directly — real data) to ground every finding below in file:line citations,
not assumption.

## 1. Findings, by problem area

### 1a. State-tracking — "I don't see the jobs I've actually applied to"

**Severity: critical. This is a real, reproducible data-corruption bug, not
a UX/display issue.**

Real `gigs.db` (1,825 tracked gigs) shows only **1** gig with
`status='applied'` and 326 gigs auto-archived (`expired_unapplied` or
`withdrawn`). Root cause, confirmed with an isolated deterministic repro:

`recordScan()` (`src/lib/store/gigs.ts:290-325`) treats **any** non-empty
batch as an authoritative full source-scan and calls
`flagUnavailableForSource()` (`gigs.ts:228-265`), which archives every
tracked gig for that source NOT present in the batch — including gigs the
owner has manually marked `applied`, flipping them to `archived
(withdrawn)`.

The status-reconciliation backfill paths in
`src/lib/sources/wellfound-status.ts:216` and
`src/lib/sources/gofractional-status.ts:280` call `recordScan()` with a
**single-gig batch** to insert one backfilled application row — and that
tiny batch then gets treated as "the complete truth about every gig from
this source," mass-archiving everything else, including genuinely-applied
gigs, as collateral damage.

Repro (isolated temp DB, never touched real data): seed 2 gigs marked
`applied` + 1 `new`; run one single-gig `recordScan()` call mimicking the
backfill path. Result: **both applied gigs flip to `archived/withdrawn`.**
This is deterministic, not probabilistic — it fires every time reconciliation
backfills an unmatched row.

Secondary, much smaller issue: the dashboard's "Archived" tab folds
`archived` + `ignored` together and labels the result "Withdrawn/closed"
(`dashboard-client.tsx:43-47,83-89`) — actively misleading once the bug
above has fired, since the platform never withdrew anything.

### 1b. Auto-update — "missing the notification and install/restart ability"

**Severity: none — a process gap, not a code bug.** The feature is fully
built and shipped: `src-tauri/src/updater.rs` emits a real lifecycle event,
`src/app/update-notifier.tsx` is a real, mounted toast UI with
Restart-now/Snooze, the tray menu has a working Dev/Prod channel toggle.
The actual issue: the owner's install is on the **Dev** channel, and the
`dev-manifest` branch has not been refreshed since **Aug 15** (still
advertising v0.21.1) — while their installed build is already v0.28.2 and
prod has since shipped up through v0.29.0. The updater is correctly
reporting "no update available" because, on the channel it's polling,
that's true. Nothing to build; needs either a fresh `-dev.N` tag or the
owner switching their local channel to Prod (which does get refreshed on
every release).

### 1c. Memory/context quality — "HORRIBLE memory... pulling old poorly
structured data"

**Severity: high, multiple real gaps confirmed, plus live-verified
contamination.** Read directly off the owner's real, running `/config` page
(read-only): `profile.skills` currently contains **"Fractional CTO"** and
**"Principal Architect"** — literal duplicates of the first two entries in
`profile.roles`. Job titles sitting in the Skills field, with nothing in the
current pipeline that would ever catch or clean it.

Further gaps: the chat co-pilot has **no system prompt at all** (grepped,
zero hits) despite the epic's own design doc assuming one would exist;
`chat_preferences` (recorded via `note_preference`) is **write-only** —
`listPreferences()` has zero callers anywhere in the app, so anything the
owner tells the chat to remember goes into a black hole; `generateDraft()`
and `verifyGroupMatch()` never touch the owner's actual resume (which IS
persisted on disk, encrypted, via `resume-store.ts`) — only
`generatePrepPacket()` uses it; there is no structured career-history data
model anywhere in `Config` at all (just flat `roles[]`/`skills[]` strings).

### 1d. Per-platform apply drafting — "drafting as if I'm EMAILING them"

**Severity: high, confirmed by design not regression.** `generateDraft()`
(`src/lib/apply/draft.ts`) is 100% platform-agnostic — one fixed prompt, one
fixed output schema (`{coverText, answers}`), `gig.sourceId` never read.
Zero real `SubmitAdapter`s are registered in production for any platform
(only in tests) — `evaluateAutoFire()` confirms this at runtime, returning
"no SubmitAdapter registered" for every source, always. This was the
explicit, documented v1 design (`assisted-apply-drafting` epic's own docs:
"real per-source auto-fill is explicitly NOT built here") — not a
regression, but a real, owner-named gap now worth closing. At minimum four
distinct application-UX shapes exist that all collapse into one
`DraftContent` today: structured proposal (Catalant), free-text "why are you
a fit" (GoFractional), cover-letter + resume-upload (Indeed-style), and
auto-apply form-fields (LinkedIn Easy-Apply-style).

### 1e. Focus-stealing browser windows — "I can hardly use the computer"

**Severity: high, and bigger than the owner's own framing suggested.** Two
real culprits, not one:

1. The background self-heal fallback (PR #89) CAN pop a real Chrome window
   from an unattended scheduled cycle with zero warning, on auth failure or
   a verification challenge.
2. **The much larger contributor**: the DEFAULT, non-error scan path itself
   (`launchHeadedBrowser()`, `browser-session.ts:330-350`) launches a real,
   visible, `headless: false` Chrome window on **every single scheduled
   scan** of every browser-session source — not just on failure. This is
   because both GoFractional and A.Team were found (live-tested, at the
   time) to fail authentication in headless mode. This fires on the
   scheduler's own cadence, runs inside the packaged Tauri app too, and is
   almost certainly the dominant source of "flashing windows."

There's real prior art here, not a blank slate: `embedded-profile-assist`
epic Slice 1 (screenshot-refresh embedding for `/profile-assist`) is
**already shipped** (PR #52). Slice 2 (interactive click/type forwarding) is
designed but not built. Critical caveat the owner needs to understand: even
today's shipped embedding does NOT suppress the real native window — it's
an additive second view of a window that still pops up regardless. A real
Tauri v2 native multi-webview embedding option exists
(`WebviewBuilder`/`add_child`) as a further-out possibility, but hits the
same clickjacking/CSP wall the original design doc already found for
`<iframe>` on login-gated pages.

**SimMan** (`firefly-events/simman`) is a selectorless, vision-grounded
Playwright **test-authoring/verification** tool (screenshot → multimodal
model grounds a click → Playwright executes it → verify against a truth
signal) — not a computer-use or browser-embedding tool. It doesn't address
window-flashing at all. Plausible future fit: an alternative reasoning
backend for `profile-assist-loop.ts` on ARIA-broken/canvas-heavy pages, or
standalone QA coverage for gigradar's own scraping adapters — a genuinely
separate decision from the embedding/focus problem.

### 1f. Testing framework — "a full testing framework"

**Severity: real, confirmed gap.** 101 real vitest unit/integration test
files exist (1300+ tests), but **zero** committed Playwright/E2E specs, and
**zero CI workflow** runs `npm test`/`npm run typecheck` on any PR — the
only GitHub Actions workflow is the tag-triggered release pipeline. No
health-check/heartbeat mechanism exists anywhere for the packaged app's
sidecar — which is exactly why tonight's 2+-day dead-sidecar incident went
undetected. `docs/ARCHITECTURE.md` itself documents "live-verified on the
owner's real machine" as the accepted substitute for automated UI coverage
— this is a real gap in the documented contract, not an oversight in
reading it.

## 2. Proposed epic breakdown

Six problem areas, one testing-framework ask, one UI-overhaul ask. Cramming
all of this into one epic would violate the exact "slices" discipline the
owner asked for. Proposed split:

**Epic 1 (THIS epic, deep-dive-audit-and-testing-framework)** — scoped to
what's small, well-understood, and high-severity enough to fix now, plus the
testing-framework foundation everything else will build on:
- Fix the `recordScan()`/`flagUnavailableForSource()` data-corruption bug
  (1a) — small, isolated, and actively destroying real application history
  on every reconciliation run today.
- Fix the dashboard's misleading "Withdrawn/closed" label bleed-through (1a).
- Clean the owner's live-contaminated `profile.skills` (remove the
  role-title duplicates found in 1c) and add a basic cross-field sanity
  check so this can't silently recur.
- Wire up `listPreferences()` so recorded chat preferences aren't a black
  hole (1c) — the smallest, most contained piece of the memory gap.
- Add a minimal, real Playwright E2E scaffold (1f): `playwright.config.ts`,
  3-4 smoke specs (dashboard loads real gigs, config round-trips, contextual
  chat opens), plus a `ci.yml` workflow gating PRs on `npm test` +
  `npm run typecheck` + the new E2E specs — closing the "no CI at all" gap.
- Add a lightweight sidecar health-check (reusing the existing
  `raiseIssue()`/desktop-notification path) so a dead sidecar (tonight's
  incident) surfaces as a dashboard warning instead of silently sitting dead
  for days.
- Cut a fresh `-dev.N` tag (or document switching to Prod channel) to close
  the auto-update process gap (1b) — no code change needed, just process.

**Epic 2 (follow-on, not this run): platform-aware application drafting.**
Redesign `DraftContent` to be format-aware (proposal / why-fit /
cover-letter+upload / form-fields) per platform, add application-UX metadata
to the `Source` registry, build real submit adapters where platforms
support it. This is a genuine type-layer + LLM-layer + UI-layer redesign —
epic-sized on its own, per the research agent's own assessment.

**Epic 3 (follow-on): embedded browser + guided session + focus fix.**
Investigate whether GoFractional/A.Team's headless-auth-failure finding
still holds (worth re-testing — browser fingerprinting evolves) before
assuming headed-mode is permanently required; if it is, explore a
persistent, off-screen/minimized headed window reused across scans instead
of a fresh visible one each time; finish `embedded-profile-assist`'s Slice 2
(interactive forwarding); evaluate real Tauri v2 native webview embedding
for a true side-by-side browser+chat panel; scope SimMan as an optional
reasoning backend, separately from the embedding work; design the
skills+approval wrapper the owner asked for.

**Epic 4 (follow-on): deep memory/context.** Chat system prompt design,
resume/career-history reaching `generateDraft()`/`verifyGroupMatch()` (not
just prep packets), a real structured career-history data model — connects
to the already-flagged, still-unplanned `career-crm` extraction reference.

**Epic 5 (follow-on): UI overhaul, via UI squads.** A genuinely separate
visual/UX epic — dashboard, config, and chat surface redesign, run through
the owner's own parallel-independent-design-agent pattern (N agents, one
orthogonal creative direction each, real render+screenshot verification,
all N published for the owner's own synthesis to become the spec — not an
assistant pick).

## 3. Open questions for the owner

1. Confirm this 5-epic breakdown, or reshuffle scope (e.g., fold the
   preference-wiring or data cleanup into a different epic).
2. For the corruption-bug fix (1a): should already-mis-archived gigs from
   the past be left alone (can't reliably reconstruct true history) or is a
   best-effort recovery pass worth attempting for records where the
   evidence is unambiguous (e.g. `unavailableSince` set within seconds of
   insert, per the one surviving `applied` row's own fingerprint)?
3. For Epic 3: is re-testing whether headless auth still fails on
   GoFractional/A.Team worth doing before committing to "headed mode is
   permanent," given how much of the flashing-window complaint traces to
   that one constraint?
4. Scale confirmation: this epic (fix + E2E scaffold + CI + health-check)
   reads as **Medium** scope (multi-file, cross-stack, but bounded and
   well-understood) rather than Large — agree, or should H/V + full
   structured-outline ceremony run anyway given the epic sits inside a
   6-epic program?
