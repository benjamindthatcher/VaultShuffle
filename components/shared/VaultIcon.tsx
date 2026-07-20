import type { CSSProperties } from "react";

export type VaultIconName =
  | "all-games" | "played" | "backlog" | "completed" | "paused" | "in-progress"
  | "collections" | "smart-collections" | "custom-collections" | "games-in-collections"
  | "wishlist" | "on-sale" | "in-library" | "following" | "filter" | "sort"
  | "grid" | "list" | "session" | "mood" | "goal" | "genre" | "new"
  | "finish" | "surprise" | "chill" | "intense" | "brain-off"
  | "short-session" | "evening-session" | "weekend-session"
  | "something-new" | "finish-something" | "surprise-me"
  | "price" | "calendar"
  | "action" | "adventure" | "rpg" | "sci-fi" | "fantasy" | "strategy"
  | "survival" | "horror" | "indie" | "cozy" | "narrative" | "open-world"
  | "roguelike" | "platformer" | "puzzle" | "sim" | "shooter" | "exploration"
  | "heart" | "chevron-left" | "chevron-right" | "clear-filters"
  | "chevron-down" | "close" | "back" | "check" | "external-link" | "menu-dots"
  | "manage-pins" | "collection-picker" | "undo" | "add"
  | "open-steam" | "play-now" | "pin" | "draw-again" | "draw-from-vault" | "snooze" | "details" | "clock" | "search";

type VaultIconProps = {
  name: VaultIconName;
  size?: number;
  className?: string;
};

const UTILITY_NAMES = new Set<VaultIconName>([
  "search", "sort", "filter", "clear-filters", "grid", "list",
  "chevron-left", "chevron-right", "chevron-down", "close", "back", "check",
  "external-link", "menu-dots", "manage-pins", "collection-picker", "undo", "add",
  "clock", "session", "mood", "goal", "genre"
]);

export function VaultIcon({ name, size = 22, className }: VaultIconProps) {
  const url = UTILITY_NAMES.has(name)
    ? `/assets/vaultshuffle/site-icons/utility/${name}.svg`
    : `/assets/vaultshuffle/icons/${name}.svg`;
  const style = {
    width: size,
    height: size,
    flex: "0 0 auto",
    display: "inline-block",
    backgroundColor: "currentColor",
    mask: `url(${url}) center / contain no-repeat`,
    WebkitMask: `url(${url}) center / contain no-repeat`
  } as CSSProperties;

  return <span aria-hidden="true" className={className} style={style} />;
}
