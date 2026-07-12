import type { CSSProperties } from "react";

export type VaultIconName =
  | "all-games" | "played" | "backlog" | "completed" | "paused" | "in-progress"
  | "collections" | "smart-collections" | "custom-collections" | "games-in-collections"
  | "wishlist" | "on-sale" | "in-library" | "following" | "filter" | "sort"
  | "grid" | "list" | "session" | "mood" | "goal" | "genre" | "new"
  | "finish" | "surprise" | "chill" | "intense" | "brain-off"
  | "price" | "calendar"
  | "action" | "adventure" | "rpg" | "sci-fi" | "fantasy" | "strategy"
  | "survival" | "horror" | "indie" | "cozy" | "narrative" | "open-world"
  | "roguelike" | "platformer" | "puzzle" | "sim" | "shooter" | "exploration"
  | "heart" | "chevron-left" | "chevron-right" | "clear-filters"
  | "open-steam" | "pin" | "draw-again" | "snooze" | "details" | "clock" | "search";

type VaultIconProps = {
  name: VaultIconName;
  size?: number;
  className?: string;
};

export function VaultIcon({ name, size = 22, className }: VaultIconProps) {
  const url = `/assets/vaultshuffle/icons/${name}.svg`;
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
