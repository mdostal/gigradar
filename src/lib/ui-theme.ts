// ui-theme-system epic. Small, dedicated home for the theme-id resolution
// logic (mirrors app-icons.ts's DEFAULT_APP_ICON_ID/resolveAppIcon shape,
// kept separate since theming isn't icon-specific) — the single place both
// layout.tsx (server-side, stamps data-theme) and config-client.tsx's
// ThemePicker (client-side, renders options) import from, so the theme list
// can't drift between the two.
// gigradar-command-center epic: "signal-deck" listed first -- it's the new
// default (see DEFAULT_UI_THEME below) -- radar/editorial/terminal remain
// fully selectable, unchanged, per ui-theme-system's own "additive, clean
// revert" precedent (see that epic's design-discussion.md §3a).
// signal-desk-theme story: "signal-desk" added last -- the calm-ops
// counterpart to signal-deck's mission-control look, a 5th additive
// option, default unchanged.
export const UI_THEMES = [
  { id: "signal-deck", label: "Signal Deck" },
  { id: "radar", label: "Radar" },
  { id: "editorial", label: "Editorial" },
  { id: "terminal", label: "Terminal" },
  { id: "signal-desk", label: "Signal Desk" },
] as const;

export type UiThemeId = (typeof UI_THEMES)[number]["id"];

export const DEFAULT_UI_THEME: UiThemeId = "signal-deck";

/** Falls back to the default whenever `id` is missing/unrecognized — never throws on a stale/hand-edited config.json, same posture as resolveAppIcon(). */
export function resolveUiTheme(id: unknown): UiThemeId {
  return UI_THEMES.some((t) => t.id === id) ? (id as UiThemeId) : DEFAULT_UI_THEME;
}
