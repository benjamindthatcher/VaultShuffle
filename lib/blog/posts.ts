import type { ReactNode } from "react";
import type { InfoSection } from "@/components/site/InfoPage";
import type { VaultIconName } from "@/components/shared/VaultIcon";
import { deckUnderTenHours } from "@/components/blog/posts/deck-under-ten-hours";

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

// Draft modules stay off the registry until their content is approved.
export const BLOG_POSTS: readonly BlogPost[] = [
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
    // A Short Hike, Firewatch and Portal 2, all included in the article.
    banner: { kind: "steam", appids: [1055540, 383870, 620] },
    content: deckUnderTenHours
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
