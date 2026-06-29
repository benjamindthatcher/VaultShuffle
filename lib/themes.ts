export const THEME_STORAGE_KEY = "vaultshuffle.theme";

export const THEME_OPTIONS = [
  { id: "ultraviolet-steam", name: "Ultraviolet Steam" },
  { id: "cosmic-blueberry", name: "Cosmic Blueberry" },
  { id: "arcade-dusk", name: "Arcade Dusk" },
  { id: "glass-aurora", name: "Glass Aurora" },
  { id: "moonlit-lagoon", name: "Moonlit Lagoon" },
  { id: "soft-console", name: "Soft Console" }
] as const;

export type ThemeOptionId = (typeof THEME_OPTIONS)[number]["id"];

export const DEFAULT_THEME_ID: ThemeOptionId = "ultraviolet-steam";

const THEME_IDS = new Set<string>(THEME_OPTIONS.map((theme) => theme.id));

export function isThemeOptionId(value: unknown): value is ThemeOptionId {
  return typeof value === "string" && THEME_IDS.has(value);
}
