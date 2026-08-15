/**
 * The set of app-icon options a user can pick between (`Config.appIcon`,
 * see types.ts) — used both server-side (layout.tsx's generateMetadata()
 * picks the favicon) and client-side (config-client.tsx's picker UI). Pure
 * data, no server-only APIs, so it's safe to import from either.
 *
 * `"classic"` is the original hand-drawn radar-dot mark (docs/favicon.svg).
 * The rest were generated (Gemini "Nano Banana") as alternatives explored
 * alongside the Tauri installer's app-icon work — see
 * .pHive/epics/tauri-installer/. `iso-radar` is the current default
 * (`DEFAULT_APP_ICON_ID`), chosen over `classic` for its stronger presence
 * at small (dock/favicon) sizes; `classic` remains a selectable option, not
 * deprecated.
 */
export interface AppIconOption {
  id: string;
  label: string;
  description: string;
  /** Public path under `public/icons/`, servable directly by Next.js. */
  path: string;
}

export const APP_ICONS: readonly AppIconOption[] = [
  {
    id: "classic",
    label: "Classic",
    description: "The original radar-dot mark.",
    path: "/icons/classic.png",
  },
  {
    id: "iso-radar",
    label: "Isometric dish",
    description: "Retro-futuristic radar dish, isometric, soft teal glow.",
    path: "/icons/iso-radar.png",
  },
  {
    id: "sweep-blip",
    label: "Sweep + blip",
    description: "Minimalist radar sweep with a single green blip.",
    path: "/icons/sweep-blip.png",
  },
  {
    id: "gradient-rings",
    label: "Gradient rings",
    description: "Concentric teal-to-green rings, one red blip.",
    path: "/icons/gradient-rings.png",
  },
  {
    id: "g-arc-monogram",
    label: "G-arc monogram",
    description: "A 'G' formed by a single radar-sweep arc.",
    path: "/icons/g-arc-monogram.png",
  },
  {
    id: "tier-blips",
    label: "Tier blips",
    description: "Classic radar screen with green/yellow/red blips.",
    path: "/icons/tier-blips.png",
  },
  {
    id: "crosshair-node",
    label: "Crosshair node",
    description: "Circular crosshair with one highlighted green node.",
    path: "/icons/crosshair-node.png",
  },
  {
    id: "neon-sweep",
    label: "Neon sweep",
    description: "Cyberpunk neon-outline radar sweep on near-black.",
    path: "/icons/neon-sweep.png",
  },
  {
    id: "tower-waves",
    label: "Tower waves",
    description: "Radar tower emitting green-to-red concentric waves.",
    path: "/icons/tower-waves.png",
  },
  {
    id: "compass-dial",
    label: "Compass dial",
    description: "Compass-meets-radar dial with a pulsing green dot.",
    path: "/icons/compass-dial.png",
  },
  {
    id: "ring-monogram",
    label: "Ring monogram",
    description: "A 'G' monogram nested in a green-yellow-red ring.",
    path: "/icons/ring-monogram.png",
  },
] as const;

export const DEFAULT_APP_ICON_ID = "iso-radar";

/** Falls back to the default whenever `id` is missing/unrecognized — never throws on a stale/hand-edited config.json. */
export function resolveAppIcon(id: string | undefined): AppIconOption {
  return APP_ICONS.find((icon) => icon.id === id) ?? APP_ICONS.find((icon) => icon.id === DEFAULT_APP_ICON_ID)!;
}
