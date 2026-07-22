const ICONS = {
  selections: ["short-session", "evening-session", "weekend-session", "brain-off", "chill", "intense", "something-new", "finish-something", "surprise-me"],
  stats: ["all-games", "played", "backlog", "completed", "in-progress", "all-collections", "smart-collections", "custom-collections", "games-in-collections", "wishlist", "on-sale", "in-library", "following"],
  actions: ["draw-from-vault", "pin", "unpin", "draw-again", "snooze-not-now", "sleep", "view-details", "mark-completed", "restore-active", "add-game", "new-collection", "save-follow", "remove", "refresh-prices"],
  genres: ["action", "adventure", "casual", "indie", "racing", "rpg", "simulation", "sports", "strategy"]
} as const;

export type BrandedIconGroup = keyof typeof ICONS;
export type BrandedIconName<G extends BrandedIconGroup = BrandedIconGroup> = (typeof ICONS)[G][number];

type BrandedIconProps<G extends BrandedIconGroup> = {
  group: G;
  name: BrandedIconName<G>;
  size?: number;
  className?: string;
  alt?: string;
};

export function BrandedIcon<G extends BrandedIconGroup>({ group, name, size = 32, className, alt = "" }: BrandedIconProps<G>) {
  const base = `/assets/vaultshuffle/site-icons/${group}/${name}`;
  return <picture className={className} aria-hidden={alt ? undefined : true}>
    <source srcSet={`${base}-64.webp 1x, ${base}-128.webp 2x`} type="image/webp" />
    <img src={`${base}-64.png`} srcSet={`${base}-64.png 1x, ${base}-128.png 2x`} width={size} height={size} alt={alt} draggable={false} style={{ width: size, height: size, objectFit: "contain", display: "block" }} />
  </picture>;
}
