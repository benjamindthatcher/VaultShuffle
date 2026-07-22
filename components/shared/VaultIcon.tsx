import { SiteGlyph } from "@/components/shared/SiteGlyph";

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
  | "heart" | "chevron-left" | "chevron-right" | "chevron-up" | "clear-filters"
  | "chevron-down" | "close" | "back" | "check" | "external-link" | "menu-dots"
  | "manage-pins" | "collection-picker" | "undo" | "add"
  | "open-steam" | "play-now" | "pin" | "draw-again" | "draw-from-vault" | "snooze" | "details" | "clock" | "search";

type VaultIconProps = {
  name: VaultIconName;
  size?: number;
  className?: string;
};

export function VaultIcon({ name, size = 22, className }: VaultIconProps) {
  return <SiteGlyph className={className} name={name} size={size} style={{ flex: "0 0 auto", display: "inline-block" }} />;
}
