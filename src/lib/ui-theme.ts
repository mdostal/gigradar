// ui-theme-system epic. Small, dedicated home for the theme-id resolution
// logic (mirrors app-icons.ts's DEFAULT_APP_ICON_ID/resolveAppIcon shape,
// kept separate since theming isn't icon-specific) — the single place both
// layout.tsx (server-side, stamps data-theme) and config-client.tsx's
// ThemePicker (client-side, renders options) import from, so the theme list
// can't drift between the two.
export const UI_THEMES = [
  { id: "radar", label: "Radar" },
  { id: "editorial", label: "Editorial" },
  { id: "terminal", label: "Terminal" },
] as const;

export type UiThemeId = (typeof UI_THEMES)[number]["id"];

export const DEFAULT_UI_THEME: UiThemeId = "radar";

/** Falls back to the default whenever `id` is missing/unrecognized — never throws on a stale/hand-edited config.json, same posture as resolveAppIcon(). */
export function resolveUiTheme(id: unknown): UiThemeId {
  return UI_THEMES.some((t) => t.id === id) ? (id as UiThemeId) : DEFAULT_UI_THEME;
}
