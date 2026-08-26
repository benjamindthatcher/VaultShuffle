import { SiteGlyph } from "@/components/shared/SiteGlyph";

export type VaultIconName =
  | "all-games" | "played" | "backlog" | "completed" | "paused" | "in-progress"
  | "collections" | "smart-collections" | "custom-collections" | "games-in-collections"
  | "on-sale" | "in-library" | "following" | "filter" | "sort"
  | "grid" | "list" | "session" | "mood" | "goal" | "genre" | "new"
  | "finish" | "surprise" | "chill" | "intense" | "brain-off"
  | "short-session" | "evening-session" | "weekend-session"
  | "something-new" | "finish-something" | "surprise-me"
  | "price" | "calendar"
  | "action" | "adventure" | "rpg" | "sci-fi" | "fantasy" | "strategy"
  | "survival" | "horror" | "indie" | "cozy" | "narrative" | "open-world"
  | "roguelike" | "platformer" | "puzzle" | "sim" | "shooter" | "exploration"
  | "casual" | "racing" | "simulation" | "sports"
  | "heart" | "chevron-left" | "chevron-right" | "chevron-up" | "clear-filters"
  | "chevron-down" | "close" | "back" | "check" | "external-link" | "menu-dots"
  | "manage-pins" | "collection-picker" | "undo" | "add" | "add-game" | "new-collection" | "refresh-prices"
  | "open-steam" | "play-now" | "pin" | "unpin" | "sleep" | "mark-completed" | "restore-active"
  | "draw-again" | "draw-from-vault" | "snooze" | "details" | "clock" | "search" | "snooze-not-now" | "view-details"
  | "all-collections" | "ready-to-review" | "actioned" | "no-review-needed" | "keep-active"
  | "privacy" | "terms" | "steam-data" | "contact" | "feedback" | "cookies"
  | "current-pick" | "trophy" | "shuffle" | "lock";

type VaultIconProps = {
  name: VaultIconName;
  size?: number;
  className?: string;
};

export function VaultIcon({ name, size = 22, className }: VaultIconProps) {
  return <SiteGlyph className={className} name={name} size={size} style={{ flex: "0 0 auto", display: "inline-block" }} />;
}
