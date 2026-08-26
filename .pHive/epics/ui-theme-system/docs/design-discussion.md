# Design Discussion: ui-theme-system

## 0. Prelude

Follow-up to the deliberately-deferred "UI pass" from stale-pages-and-source-status. A 3-way parallel design swarm (radar/mission-control, editorial "the ledger", terminal/tmux) was run, each agent blind to the others, same real data, verified live (mojibake bug caught+fixed in 2 of 3 before showing the user). Owner's synthesis across all three, verbatim:

1. Dashboard keeps Title and Company as separate columns (already current app behavior — radar's choice, not a change).
2. Add session-health detail under "Connected" badges in Config (radar's feature — editorial/terminal didn't have it).
3. Add an inline "Run login capture" button directly on "Needs login" badge rows (radar's feature).
4. Build all three as real, selectable themes via a style picker — not just radar.
5. Default theme: radar.

## 1. Goal

A real, persisted per-user theme choice (radar / editorial / terminal) that reskins Dashboard, Config, and Issues — the three surfaces the swarm actually designed — via a token-driven architecture, picked from a new "Appearance" control, defaulting to radar. Plus two universal (theme-independent) feature additions to the Config Sources list.

## 2. Existing infrastructure (confirmed via research, not assumed)

- Tailwind v4 is already in use (`@tailwindcss/postcss`, `tailwindcss` in package.json), with an existing `@theme` block in `src/app/globals.css` defining brand tokens (`--color-brand-bg`, `--color-brand-accent`, etc.) — currently scoped to chrome only (nav, primary actions), explicitly NOT applied to the data-dense dashboard/config pages, which stay light today. This is the right foundation to extend, not replace.
- There's an exact precedent for a persisted, cosmetic, per-install UI preference: `Config.appIcon` (`src/lib/types.ts:216`, `z.string().optional()` in `schema.ts:142`). `layout.tsx`'s `generateMetadata()` and `RootLayout()` both call `readRawConfig()` directly and `resolveAppIcon(raw.appIcon)` to pick the favicon — raw (unresolved) read, never `loadConfig()`, since this is cosmetic, never a secret. `uiTheme` follows the exact same shape: a new optional `Config.uiTheme` field, read raw in `layout.tsx`, applied at the root.
- `/config`'s "Appearance" section (`config-client.tsx:2334`) already exists and hosts `IconPicker` — the natural, existing home for a new `ThemePicker`.
- `layout.tsx` is one of the 5 routes fixed to `force-dynamic` in the prior epic — reading `raw.uiTheme` fresh on every request needs no new revalidation work; that's already solved.
- The Capture Login trigger already exists and is fully wired: `handleStartCapture(i, source.id)` (`config-client.tsx:1347`) calls `startCaptureAction`, currently only rendered inside the separate `CaptureLoginControl` section below the badge. Adding an inline button next to the badge itself is a rendering-placement change reusing this exact handler — not new plumbing.
- `listIssues({ open: true })` (`src/lib/notify/issues.ts:111`) returns `StoredIssue[]` with a `context: string | null` field (JSON-stringified, e.g. `{"sourceId":"ateam"}`) — a structured, reliable way to find "does source X have an open issue" without string-sniffing error messages for words like "expired."

## 3. Approach

### 3a. Theme architecture

CSS custom properties, switched via `data-theme="radar" | "editorial" | "terminal"` on `<html>`, extending (not replacing) the existing `@theme` block's token names so both v4's `@theme`-derived utilities and hand-written CSS can read the same variables. `layout.tsx` resolves `Config.uiTheme` (default `"radar"`) server-side and stamps the attribute — same pattern as the existing `resolveAppIcon()` call.

Each theme is a self-contained CSS file (`src/app/themes/{radar,editorial,terminal}.css`) imported into `globals.css`, guarded by `[data-theme="..."]` selectors — additive, so removing a theme file is a clean revert. All three theme CSS files are authored FROM the verified swarm mockups (same token names as those files use internally where sensible) rather than reinvented from scratch, so the shipped result matches what the owner actually approved.

Scope boundary: only Dashboard, Config (Sources list + the rest of the form), and Issues get full bespoke theme treatment (matching the swarm mockups). Chat, Drafts, and Profile-assist inherit the base/chrome tokens (nav, buttons, backgrounds) but are NOT redesigned page-by-page in this epic — flagged explicitly, not silently scoped out.

### 3b. Config.uiTheme + ThemePicker

New optional `Config.uiTheme: "radar" | "editorial" | "terminal"` (schema + types), defaulting to `"radar"` when absent (existing config files need no migration). A `ThemePicker` component in the existing Appearance section, sibling to `IconPicker`, following its exact save/draft-state pattern (`edits.uiTheme = draft.uiTheme` in `saveConfigAction`).

### 3c. Feature: session-health note on Connected badges

NOT a fragile keyword-match on issue message text (rejected — "session expired" string-matching would misfire on unrelated fetch failures, e.g. a plain network blip). Instead: `checkSessionReadiness()` (or a sibling helper) additionally checks `listIssues({ open: true })` for any entry whose `context.sourceId` matches this source. If one exists, the badge shows a lighter secondary note — "Has an open issue — see Issues" — rather than presuming to diagnose the specific cause. Honest about what it actually knows.

### 3d. Feature: inline "Run login capture" on Needs-login badges

Render a compact button next to the "Needs login" badge itself, wired to the same `handleStartCapture` handler the existing (unchanged) `CaptureLoginControl` section already uses below. Purely additive — the existing control stays for sources that want the fuller capture UI (session backend picker, etc.); this is a shortcut, not a replacement.

## 4. Risks

- **Real visual regression risk**: this touches the three highest-traffic pages' markup directly, not just CSS classes swapped in place — real risk of breaking existing interactions (sort/filter, status-change dropdown, capture flow) while reskinning. Mitigated by keeping all existing functional markup/handlers intact and changing presentation only, verified via the existing test suite (behavior) plus live manual verification (visual) same as the prior epic.
- **Three real themes = three times the maintenance surface** going forward — any new UI element added later needs three token-compliant treatments, not one. Accepted tradeoff per explicit owner decision ("all 3 now").
- **Scope boundary (Chat/Drafts/Profile-assist inherit tokens only)** could look visually inconsistent against the three fully-themed pages. Flagged, not hidden — acceptable for this pass since those pages weren't part of the swarm's brief.

## 5. Open questions

None blocking — the owner already resolved the three real feature-vs-style questions and the "build all 3" scope call before this doc was written.

## 6. Scale assessment

**Large** — a new persisted architecture (token system + Config field), a new UI control, three full theme implementations across three real pages, and two new pieces of business logic (issue cross-reference, inline capture trigger). Proceeding to story decomposition directly (skipping the heaviest structured-outline/elicitation ceremony given this is a solo build with an already-confirmed spec from the owner, not an open design question) — stories will be sequenced as a vertical slice: architecture + radar first (a fully working, shippable state on its own), then editorial and terminal as additive follow-on slices, then the two universal features last (since they benefit from being visually verified against all three themes at once).
