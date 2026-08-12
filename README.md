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

## Add a source (the whole extension story)

```ts
import { registerSource } from "@/lib/sources/source";
export const mySource: Source = {
  id: "my-board", label: "My Board", auth: "browser-session",
  async fetch(cfg, profile) { /* return normalized Gig[] with real urls */ },
};
registerSource(mySource);
```

Set your rules in your own config (kept in `.local/`, gitignored):

```ts
const needs: Needs = { minRate: 175, highRate: 250, maxHours: 20, maxHoursAtHighRate: 40,
  allowContractToHire: false, freshStageOnly: true, remoteOnly: true };
```

## Status

`v0.1.0` — scaffold. Core contracts + the explainable gate engine are in place and runnable against the demo source. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and the build-out roadmap (real source adapters, auth/session handling, the Next.js config UI, and the assisted-apply drafting layer).

## License

MIT © 2026 Mathew Dostal
