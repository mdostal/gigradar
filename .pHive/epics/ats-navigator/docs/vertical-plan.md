# Vertical Plan: ats-navigator

Each slice is independently shippable and leaves the app in a working
state. Slices 1-3 form the onboarding chain (each depends on the last);
Slice 4 (ATS resume score) is independent and can ship in parallel.

## Slice 1: source-presets (foundation)

A new, small curated `SOURCE_PRESETS` array (mirrors `role-templates.ts`'s
shape exactly: `id`/`label`/`description`/a `custom-llm-source`-shaped
`settings` object) for Welcome to the Jungle and Zoho Recruit — Indeed
deliberately excluded per design-discussion.md §4.1/§5. No UI yet; this
slice just makes the presets exist and be tested, so Slices 2 and 3 have
one real source of truth to read from instead of two divergent lists.

**Working state after this slice:** presets exist, are unit-tested
(same "non-empty, no self-contradiction" discipline
`role-templates.test.ts` already enforces), and are NOT yet reachable
from any UI — a deliberate, safe intermediate state.

## Slice 2: config-add-source-presets (UI, cheap)

Adds a preset dropdown to `/config`'s existing "Add a source" flow
(`config-client.tsx`) that pre-fills a `custom-llm-source` `SourceConfig`
from a `SOURCE_PRESETS` entry, still going through the exact same
`saveConfig()` write path every other config edit uses. A user can now
add a Welcome to the Jungle or Zoho Recruit source WITHOUT hand-typing a
`custom-llm-source` settings object.

**Working state after this slice:** a user can add either preset from
the UI today, entirely without chat.

## Slice 3: chat-guided-source-onboarding

Extends `agent-chat-loop.ts` with `list_source_presets` (read-only,
auto-executes) and `add_source` (write, approval-gated — proposes the
exact `SourceConfig` it would write, same `pendingApproval` mechanism
every other write tool in that loop already uses, no exceptions). A user
can now say "I use Welcome to the Jungle, here's a company's jobs page
URL" in `/chat` and approve the proposed source addition inline.

**Working state after this slice:** the "walk people through it"
onboarding experience is real, end to end, via chat.

## Slice 4: ats-resume-score

Extends `generatePrepPacket()`/`PrepPacketContent` with a deterministic
parseability check (multi-column/table/image-text/header-contact-info/
non-standard-heading detection against the already-ingested resume) plus
a keyword-overlap score against the specific gig's own description,
surfaced in the existing prep-packet UI. No new page, no new LLM call
site shape — an extension of a call site that already exists.

**Working state after this slice:** every prep packet now also answers
"will my resume even get past an automated filter for this specific
listing, and why/why not."

## Explicitly deferred (not this epic, tracked as follow-ups)

- **Indeed** — needs an explicit, owner-approved robots.txt exception
  (design-discussion.md §3/§5) before any adapter/preset work starts.
- **`SubmitAdapter`s** for WTTJ/Zoho Recruit — real submission automation
  needs its own live-verification pass (GoFractional precedent), not
  assumed to work because the fetch side does.
- **Any 4th+ platform** — owner's "and etc." is an open question
  (design-discussion.md §5, item 1), not silently expanded here.
