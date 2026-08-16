# Vertical Plan: ats-navigator

Each slice is independently shippable and leaves the app in a working
state. Slices 1-3 form the onboarding chain (each depends on the last);
Slice 4 (bidirectional ATS scanning) is independent and can ship in
parallel.

## Slice 1: source-presets (foundation)

A new, small curated `SOURCE_PRESETS` array (mirrors `role-templates.ts`'s
shape exactly: `id`/`label`/`description`/a `custom-llm-source`-shaped
`settings` object, plus a `suggestsGmailDigest?: boolean` flag) for
**Indeed, Welcome to the Jungle, and Zoho Recruit** — the owner-confirmed
closed list (design-discussion.md §3 "and etc." — resolved). Indeed's
preset defaults `customAuth: "browser-session"` (Capture Login) given its
likely-aggressive bot detection; Indeed and Zoho Recruit set
`suggestsGmailDigest: true` (both notify by email), WTTJ does not. No UI
yet; this slice just makes the presets exist and be tested, so Slices 2
and 3 have one real source of truth to read from instead of two
divergent lists.

**Working state after this slice:** presets exist, are unit-tested
(same "non-empty, no self-contradiction" discipline
`role-templates.test.ts` already enforces), and are NOT yet reachable
from any UI — a deliberate, safe intermediate state.

## Slice 2: config-add-source-presets (UI, cheap)

Adds a preset dropdown to `/config`'s existing "Add a source" flow
(`config-client.tsx`) that pre-fills a `custom-llm-source` `SourceConfig`
from a `SOURCE_PRESETS` entry, still going through the exact same
`saveConfig()` write path every other config edit uses. A user can now
add any of the three presets WITHOUT hand-typing a `custom-llm-source`
settings object.

**Working state after this slice:** a user can add any of the three
presets from the UI today, entirely without chat.

## Slice 3: chat-guided-source-onboarding

Extends `agent-chat-loop.ts` with `list_source_presets` (read-only,
auto-executes) and `add_source` (write, approval-gated — proposes the
exact `SourceConfig` it would write, same `pendingApproval` mechanism
every other write tool in that loop already uses, no exceptions). After
an `add_source` approval for a preset with `suggestsGmailDigest: true`,
the agent offers the ALREADY-BUILT `start_gmail_connect` tool (agent-chat
epic, Slice 3) for that account — same approval-gated mechanism, no new
one. A user can now say "I use Zoho Recruit at Acme, here's the careers
page" in `/chat`, approve the proposed source, and be walked straight
into connecting Gmail for application-status emails from the same
onboarding turn.

**Working state after this slice:** the "walk people through it"
onboarding experience is real, end to end, via chat, including the Gmail
half.

## Slice 4: ats-resume-score (bidirectional, re-grounded)

Real finding during this slice's own research step changed the plan --
see design-discussion.md §4.4: there is no persisted resume file/text or
structural metadata anywhere in this codebase (`Profile` only ever holds
`{name, roles, skills, timezone, homeBase}`; `extractProfile()` sends a
resume PDF natively to Claude and persists only `{roles, skills,
warnings}`). A "deterministic parseability check against the ingested
resume" would have to fabricate structure that was never actually
observed -- so it's deferred (design-discussion.md §5 open question 4),
not shipped as a fake pass.

What ships, using data this codebase actually has:
- a keyword-overlap score: `profile.skills`/`profile.roles` vs. the
  specific gig's own description — one LLM call;
- `resumeTweaks`: a short, concrete, ATS-mechanical action list grounded
  in the computed keyword gap ("add X to your skills, it appears N× in
  this listing") — reverse direction, the SAME LLM call as the
  keyword-overlap score, not a second call.

Surfaced in the existing prep-packet UI. No new page, no new LLM call
site shape — an extension of a call site that already exists.

**Working state after this slice:** every prep packet now also answers
"how well does my tracked skill/role profile match this specific
listing's keywords, and exactly what to add."

## Explicitly deferred (not this epic, tracked as follow-ups)

- **`SubmitAdapter`s** for Indeed/WTTJ/Zoho Recruit — real submission
  automation needs its own live-verification pass (GoFractional
  precedent), not assumed to work because the fetch side does.
  design-discussion.md §5's remaining open item.
- **Deterministic resume-file parseability checks** (multi-column/table/
  image-text/header-contact-info detection) — needs a real decision on
  whether/how gigradar persists resume content first (design-discussion.md
  §5, item 4). Not silently faked against data that doesn't exist.
