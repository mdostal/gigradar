# Research brief: source-presets-expansion

Owner's request, verbatim: "all of the added sources need to be expanded
to any and all of the other things we think would be useful -- do a DEEP
research on that so we can get more overall."

Deep research pass across fractional/consulting marketplaces, general
freelance boards, and self-hosted ATS platforms, evaluating each on: real
scrapable URL structure, auth model, robots.txt findings, and email-digest
relevance. Full findings below; **implemented in this epic**: the 5
"Recommended" entries. The rest are reported for the owner's awareness/
decision, not silently included or silently dropped.

## Implemented this pass (added to `SOURCE_PRESETS`)

- **Greenhouse** (`job-boards.greenhouse.io/{company}`) — permissive
  robots.txt, no AI-bot block, public. `suggestsGmailDigest: true`.
- **Ashby** (`jobs.ashbyhq.com/{company}`) — clean robots.txt, public.
  Client-rendered SPA — exact card structure unverified by static fetch,
  hint flags this.
- **Workable** (`apply.workable.com/{company}`) — clean robots.txt,
  explicitly publishes `Content-Signal: ai-input=yes`. `suggestsGmailDigest: true`.
- **Contra** (`contra.com/opportunities`) — clean robots.txt, explicitly
  publishes `Content-Signal: ai-input=yes`. Client-rendered, unverified
  exact layout.
- **Landing.jobs** (`landing.jobs/jobs`) — clean robots.txt, public,
  EU/Portugal-centric, mixed seniority (not exclusively fractional).

## Flagged — explicit AI-bot block, needs an owner override decision

Same posture as the Indeed precedent (ats-navigator epic) — not silently
included or silently dropped, presented for a real decision:

- **Lever** (`jobs.lever.co/{company}`) — Cloudflare-managed robots.txt
  block explicitly disallows ClaudeBot/GPTBot/CCBot/Google-Extended/
  Applebot-Extended/meta-externalagent site-wide, no carve-out. A very
  common, well-structured ATS (title/department/location cards) — real
  value if overridden.
- **Malt** (malt.com/malt.de) — a major EU freelance/consulting
  marketplace (Comatch has been absorbed into it, no longer separate).
  robots.txt disallows GPTBot entirely AND explicitly disallows
  `/missions`/`/mission/` — its actual listing paths — for every
  user-agent, not just AI bots. Stronger signal than Indeed's case.
  Login-gated for full listing details regardless.

## Needs live verification (fetch got blocked — may be a generic bot-challenge, not a real policy objection)

- **RemoteOK** — a nuanced robots.txt: an auto-generated Cloudflare
  AI-bot block coexists with a LATER, hand-authored section explicitly
  re-allowing the same bots with a comment: "Permitted to crawl and cite
  public job listings, company pages, and category pages." Reads as
  genuine site-owner intent, contradicted by a leftover Cloudflare
  toggle. A plain fetch 403'd regardless — needs a real browser-session
  attempt to know for sure.
- **We Work Remotely** — robots.txt itself is completely clean, but a
  plain fetch 403'd on both the homepage and a category page (likely
  Cloudflare/WAF bot-challenge, not policy).
- **Upwork** — robots.txt itself returned 403 (couldn't even read the
  policy); a job-search fetch also 403'd site-wide. Same class of
  aggressive Cloudflare detection this codebase already hit and paused on
  for GoFractional. Lowest priority of the three — even live-verified,
  Upwork's senior/fractional work isn't cleanly separated from its
  general marketplace.

## Not recommended — no scrapable listing surface exists

- **Toptal, Business Talent Group, Paro, Torc, Turing** — confirmed (via
  their own marketing copy) pure matching platforms: submit a profile,
  their team/AI matches you privately. No `/jobs`, `/projects`, or
  `/opportunities` path exists at all.
- **GLG** — confirmed hybrid expert-network model, explicitly
  team-matched, no public/authenticated browsable listing.
  Guidepoint/AlphaSights/Prosapient are almost certainly architecturally
  identical (same "expert network" category) but were not individually
  verified — an inference, not a confirmed fact.
- **Chief** — a membership community/network, not a job board.
- **Otta** — merged into Welcome to the Jungle in 2023 (301-redirects);
  already fully covered by the existing WTTJ preset.
- **SmartRecruiters** — not deeply researched (no robots.txt found at the
  expected host); a real gap in this pass, not a "checked and rejected"
  verdict.
