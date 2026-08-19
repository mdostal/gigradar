# gigradar

**Open-source radar for fractional / contract engagements.** Define your accounts, your needs, and your role — gigradar tracks the sources you enable, finds the roles that actually fit your hard criteria, tells you *why* everything else was rejected, runs on a schedule, and assists the apply. Human-in-the-loop by default: it shortlists and drafts; you approve.

Built in the spirit of the other tools in this suite (allergy-locator, mapstack) — a **generic, extensible core** you configure, not a bespoke script you edit.

## The one principle

**The core is generic. Your implementation is config + plugins *around* it — never a fork of the core.**

- **Core OSS (this repo):** the plugin framework for adding sites, the auth/login handling, the explainable match/gate engine, and the find→interact pipeline. Knows nothing about any one user.
- **Your layer (outside the core):** your profile, your criteria, the sources you enable, your session handling, and any *private* source adapters or apply logic you wire in. The core pulls these in through the plugin contract — you never touch core code to add a site or change your rules.

That separation is what makes it a real OSS tool: anyone can add a source and set their own needs without forking; you can point it at your own private implementations (e.g. an existing scraper) as plugins.

## How it works

```
your sources ──fetch──▶ normalize to Gig ──gate()──▶ pass? ──rank──▶ shortlist
   (plugins)                                  │                          │
                                              └── reasons ──▶ "why rejected"   └── assisted apply (you approve)
```

1. **Sources** — each enabled site/board is a `Source` plugin that fetches and normalizes listings (real per-listing URLs only, never a search page).
2. **Gate** — a pure, deterministic, *explainable* GO/NO-GO: rate floor, hours cap (a higher rate unlocks more hours), fresh-stage, no contract-to-hire, role/skill fit. Every gig gets a pass/fail **with a reason per rule** — nothing is silently dropped.
3. **Rank** — passers sorted by rate / hours / freshness / fit.
4. **Assisted apply** — stages a per-gig application draft keyed to your profile for **your review**. It does not blast auto-submissions.
5. **Schedule** — runs on a cron; each run is logged and observable.

## Install

**macOS:** [download the `.dmg`](https://github.com/mdostal/gigradar/releases/latest) and drag it to `/Applications`.

The `.dmg` is currently **unsigned** — there's no Apple Developer ID certificate behind it yet (real notarized signing is on the roadmap; see `docs/ARCHITECTURE.md`). macOS Gatekeeper will block the first launch with an "unidentified developer" warning. That's Gatekeeper flagging an unsigned app, **not** a corrupted download. Fix it with one command after installing, then launch normally:

```
xattr -cr /Applications/gigradar.app
```

**Any OS, from source:**

```
git clone https://github.com/mdostal/gigradar.git
cd gigradar
npm install
npm run dev
```

Either way, a local dashboard comes up at `127.0.0.1:3000` by default (falling back to another free port automatically if 3000 is already taken — see `GIGRADAR_PORT` in `docs/gmail-oauth-setup.md` if you need a stable alternative for Gmail OAuth) — never exposed beyond your machine.

**Native desktop window instead of a browser tab:** `npm run electron` runs the exact same app inside Electron (spawns the same server as a child process — server code never runs inside Electron's own process). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)'s "Two runtime modes" section for the details, and the roadmap entry for a fully packaged, auto-updating `.app`/`.dmg` (Tauri) beyond the unsigned build above.

## Configure

Everything is set up through the `/config` page in the running app — no hand-editing JSON required, though `config.example.json`/`.env.example` at the repo root show the underlying shape if you want to see it. There you set:

- **Your profile & needs** — roles, skills, rate/hours thresholds (see `Needs`/`EngagementProfile` below), remote-only, etc.
- **Sources** — pick from the built-in adapter presets (LinkedIn, GoFractional, A.Team, Wellfound, Braintrust, and more) or add your own via a source URL + an LLM-driven extraction recipe (no code required).
- **Credentials — BYOK.** gigradar never ships or proxies any API key on your behalf. LLM-driven features (custom-source extraction, assisted-apply drafting, profile-assist) need your own Anthropic API key, entered directly in `/config`; browser-session sources need a one-time guided login (`Capture Login`) so gigradar can replay your own authenticated session. Google-account sources (e.g. Gmail digest ingestion) need your own OAuth client — see [`docs/gmail-oauth-setup.md`](docs/gmail-oauth-setup.md) for the one-time setup.

Want gigradar's data queryable from Claude Desktop/Claude Code instead of (or alongside) the dashboard? It ships an MCP server (`npm run mcp`) exposing `list_gigs`/`get_gig`/`update_gig_status`/`get_status_summary`/`run_scan` over stdio — see [`docs/mcp-setup.md`](docs/mcp-setup.md) for copy-pasteable client config.

## Add a source (the whole extension story)

```ts
import { registerSource } from "@/lib/sources/source";
export const mySource: Source = {
  id: "my-board", label: "My Board", auth: "browser-session",
  async fetch(cfg, profile) { /* return normalized Gig[] with real urls */ },
};
registerSource(mySource);
```

Set your rules — either through `/config`, or directly in your own config.json (kept outside the repo, gitignored):

```ts
const needs: Needs = {
  engagementProfiles: [
    { id: "fractional-contract", label: "Fractional/contract", types: ["contract", "fractional"],
      minRate: 175, highRate: 250, maxHours: 20, maxHoursAtHighRate: 40, rateUnit: "hour" },
  ],
  freshStageOnly: true, remoteOnly: true,
};
```

## Status

`v0.25.2` — real source adapters (LinkedIn, GoFractional, A.Team, Wellfound, Braintrust, and more, plus LLM-driven custom sources and Gmail digest ingestion), the Next.js dashboard/config UI, guided browser-session login, ranked engagement profiles, assisted-apply drafting with a career-tracker/interview-prep layer, an MCP server for Claude Desktop/Code, a cron scheduler with desktop notifications, a severity-tiered issues view with an in-UI human-verification co-pilot, and an opt-in, trust-gated auto-fire submission system. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and build-out roadmap. Try it live at [mdostal.github.io/gigradar](https://mdostal.github.io/gigradar/).

## Support this project

Free and open source, always. A few ways to help — or just say hi:

- **Use it, star it, file an issue.** Honestly the best support an open-source project can get. → [this project](https://github.com/mdostal/gigradar)
- **Hire me.** I do fractional-CTO and consulting work — fixing and scaling tech stacks. → [mdostal.com/contact](https://mdostal.com/contact)
- **[Buy me a coffee](https://www.buymeacoffee.com/mdostal)** if it saved you time.
- **More tools like this** → [tools.mdostal.com](https://tools.mdostal.com)
- **Life outside the terminal** → [life.mdostal.com](https://life.mdostal.com)
- **What we're building at Firefly Events** — event discovery, 8,000+ events/day from 7+ sources → [ff.events](https://ff.events)

Always up for a conversation if any of it's useful to you.

## License

MIT © 2026 Mathew Dostal
