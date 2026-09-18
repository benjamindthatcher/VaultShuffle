import type { ReactNode } from "react";
import type { InfoSection } from "@/components/site/InfoPage";
import type { VaultIconName } from "@/components/shared/VaultIcon";
import { deckUnderTenHours } from "@/components/blog/posts/deck-under-ten-hours";
import { shortGamesFinished } from "@/components/blog/posts/short-games-finished";
import { unplayedLibrary } from "@/components/blog/posts/unplayed-library";
import { whatUsersPlay } from "@/components/blog/posts/what-users-play";

/**
 * The post registry, and the publishing schedule.
 *
 * `published` is a date, not a flag. A post whose date has not arrived is
 * written, reviewable and committed, but invisible in production: it is left
 * out of the index, the sitemap and generateStaticParams, and its own route
 * returns a 404 until the date passes.
 *
 * Nothing needs to be deployed on the day. The blog index, the sitemap and the
 * post pages all carry a revalidate window, and `dynamicParams` is left at its
 * default, so the first request after a post's date renders it on demand and
 * the index and sitemap pick it up within the window. Write several, stagger
 * the dates, and they let themselves out.
 *
 * Scheduled posts are visible in `next dev` so they can be proofed, with a
 * badge saying so. That branch is on NODE_ENV, so production cannot leak one.
 */

/**
 * A post's banner, which is either real Steam artwork or a supplied image.
 *
 * Steam art is the default because it is honest and free: the games a post is
 * about, from their own CDN, already the right size. But some posts have no
 * natural game to show - an opinion piece, or a chart that is the point of the
 * article - so those take an image instead. One field, two kinds, and the index
 * renders whichever it finds.
 *
 * Three AppIDs for the steam kind: three 460x215 headers across a full-width
 * card crop by about a sixth, which is little enough to keep the game names.
 */
export type PostBanner =
  | { kind: "steam"; appids: readonly [number, number, number] }
  /** `src` is a path under /public, or a host allowed in next.config images. */
  | { kind: "image"; src: string; alt?: string };

export type BlogPostMeta = {
  slug: string;
  /** The <title>. Front-loaded with the answer, because that is what earns the click. */
  title: string;
  /** The on-page h1, which can be shorter than the title tag. */
  heading: string;
  description: string;
  /** The standfirst under the heading. */
  dek: string;
  /** YYYY-MM-DD, treated as 00:00 UTC. A future date schedules the post. */
  published: string;
  /** Set when the substance changes, not when a typo is fixed. */
  updated?: string;
  readingMinutes: number;
  topic: string;
  icon: VaultIconName;
  banner: PostBanner;
};

/**
 * A post's content in the shape InfoPage already takes, because the blog uses
 * the same component as privacy, FAQ, releases and steam-data rather than a
 * layout of its own. `overview` is the standfirst panel; each h2 of a post is
 * a section, opened on arrival so a post reads as an article and not as an
 * accordion.
 */
export type PostContent = {
  overview: ReactNode;
  sections: InfoSection[];
};

export type BlogPost = BlogPostMeta & {
  content: () => PostContent | Promise<PostContent>;
};

export const BLOG_POSTS: readonly BlogPost[] = [
  {
    slug: "how-much-of-a-steam-library-goes-unplayed",
    title: "Two Thirds of a Steam Library Has Under an Hour Played",
    heading: "Two thirds of a Steam library has under an hour played",
    description:
      "We measured playtime across 383,663 owned games in 667 Steam libraries. Half have never been launched, and two thirds have under an hour on them.",
    dek: "Half of the games in a Steam library have never been launched. The more revealing number is the one just above it.",
    published: "2026-09-17",
    readingMinutes: 4,
    topic: "Library data",
    icon: "playtime",
    // The shape of a big library: three of the most-owned games in the catalogue.
    banner: { kind: "steam", appids: [620, 105600, 489830] },
    content: unplayedLibrary
  },
  {
    slug: "steam-deck-games-you-can-beat-in-under-10-hours",
    title: "10 Best Short Steam Deck Games You Can Beat in Under 10 Hours",
    heading: "10 best short Steam Deck games you can beat in under 10 hours",
    description:
      "Ten of the best short Steam Deck Verified games, all under ten hours to beat and all strongly reviewed, with VaultShuffle data on how many players actually finish them.",
    dek: "From a 90 minute hike to Portal 2, every game here is Verified and short enough to finish this week.",
    published: "2026-09-17",
    readingMinutes: 5,
    topic: "Steam Deck",
    icon: "clock",
    // Portal 2, Balatro, Celeste - the top of the list this post renders.
    banner: { kind: "steam", appids: [620, 2379780, 504230] },
    content: deckUnderTenHours
  },
  {
    slug: "do-people-actually-finish-short-games",
    title: "Do People Actually Finish Short Games? We Checked",
    heading: "Do people actually finish short games?",
    description:
      "Everyone says play something short to beat your backlog. Across 128,000 started games, completion rate barely moves with length. Here is what does.",
    dek: "The standard backlog advice is to play something short. The data does not support the reason people give for it.",
    published: "2026-09-24",
    readingMinutes: 5,
    topic: "Library data",
    icon: "completed",
    // INSIDE, Firewatch, Brothers - the narrative shorts named in the post.
    banner: { kind: "steam", appids: [304430, 383870, 225080] },
    content: shortGamesFinished
  },
  {
    slug: "what-steam-games-do-people-actually-play",
    title: "What Steam Games Do People Actually Play, Not Just Own?",
    heading: "What people actually play, not just own",
    description:
      "Owning a game is not choosing it. We ranked VaultShuffle libraries by launch rate, average hours and completion instead of by ownership.",
    dek: "Ownership rankings are mostly a record of what Valve bundled. Ranking by engagement gives a different list.",
    published: "2026-10-01",
    readingMinutes: 5,
    topic: "Library data",
    icon: "trophy",
    // ELDEN RING, Baldur's Gate 3, Cyberpunk 2077 - the top of the ranking.
    banner: { kind: "steam", appids: [1245620, 1086940, 1091500] },
    content: whatUsersPlay
  }
];

function publishedAt(post: BlogPostMeta): number {
  return new Date(`${post.published}T00:00:00Z`).getTime();
}

export function isPublished(post: BlogPostMeta, now: Date = new Date()): boolean {
  return publishedAt(post) <= now.getTime();
}

/** True only outside production, where a scheduled post may be proofed. */
export function canPreviewScheduled(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Newest first. Scheduled posts are included only when previewing is allowed. */
export function listPosts(options: { includeScheduled?: boolean } = {}): BlogPost[] {
  const includeScheduled = options.includeScheduled ?? false;
  const now = new Date();
  return BLOG_POSTS
    .filter((post) => includeScheduled || isPublished(post, now))
    .slice()
    .sort((a, b) => publishedAt(b) - publishedAt(a));
}

export function getPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((post) => post.slug === slug);
}

/** Long form, for the byline: "17 September 2026". */
export function formatPostDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}
