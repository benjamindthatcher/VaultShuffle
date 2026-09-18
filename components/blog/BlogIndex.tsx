import Image from "next/image";
import Link from "next/link";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { formatPostDate, isPublished, type BlogPost } from "@/lib/blog/posts";
import styles from "./BlogIndex.module.css";

/**
 * The blog index: every post full width, newest first.
 *
 * Its own layout rather than InfoPage's, for the same reason /releases has its
 * own - these pages are different jobs. A legal page is a document you search
 * for one clause in; an index is a set of invitations you choose between.
 *
 * One treatment for every post rather than a lead and a grid of smaller ones.
 * Four posts do not need a hierarchy imposed on them, and the wide card is the
 * one that has room for a three-header cover without cropping the game names
 * off - which a 464px grid cell does not.
 *
 * The covers are Steam header art for games each post is about, the one kind of
 * imagery this site can use honestly: real, already on a CDN, and quicker to
 * read than any headline. Colour, accent edge and type all still come from the
 * existing theme.
 */

const STEAM_HEADER = (appid: number) =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;

/**
 * The banner.
 *
 * Steam tiles are decorative - the headline carries the meaning, and naming
 * three games in alt text would just be read out before it. A supplied image
 * may well carry meaning, so it takes the alt it was given and only falls back
 * to decorative when none was.
 *
 * Unoptimized for the Steam kind because those are Steam's own 460x215 headers,
 * already the right size on their own CDN - running them through the optimiser
 * would bill a transformation each to change nothing. A supplied image goes
 * through it normally, because we do not know what size it arrived at.
 */
function PostBannerArt({ post, priority }: { post: BlogPost; priority?: boolean }) {
  const { banner } = post;

  if (banner.kind === "image") {
    return (
      <span className={styles.cover}>
        <Image
          className={styles.coverImage}
          src={banner.src}
          alt={banner.alt ?? ""}
          fill
          sizes="(max-width: 640px) 100vw, 940px"
          priority={priority}
        />
        <span className={styles.coverScrim} aria-hidden="true" />
      </span>
    );
  }

  return (
    <span className={styles.cover}>
      {banner.appids.map((appid) => (
        <Image
          key={appid}
          className={styles.coverTile}
          src={STEAM_HEADER(appid)}
          alt=""
          width={460}
          height={215}
          sizes="(max-width: 640px) 50vw, 320px"
          priority={priority}
          unoptimized
        />
      ))}
      <span className={styles.coverScrim} aria-hidden="true" />
    </span>
  );
}

export function BlogIndex({ posts }: { posts: BlogPost[] }) {
  return (
    <div className={styles.page}>
      {/* Eyebrow and heading, and nothing else. The posts are the page, and a
          paragraph explaining what a blog is only pushed the first one down.
          The heading is a column's name, borrowing the product's own noun - the
          Vault is what draws a game, so notes from it is where the data it sees
          gets written up. It carries no keyword at all, which is why the title
          tag keeps them; the post titles do the search work, and they are
          better at it anyway. "Steam Deck Verified games you can beat in under
          10 hours" is the thing somebody actually types. */}
      <p className={styles.eyebrow}>Blog</p>
      <h1>Notes from the Vault</h1>

      {posts.length === 0 ? (
        <p className={styles.empty}>Nothing published yet. The first post is on its way.</p>
      ) : (
        <ul className={styles.list}>
          {posts.map((post, index) => (
            <li key={post.slug}>
              <Link className={styles.post} href={`/blog/${post.slug}`}>
                {/* Only the first cover is eager - it is the one above the fold. */}
                <PostBannerArt post={post} priority={index === 0} />
                <span className={styles.postBody}>
                  <span className={styles.meta}>
                    <span className={styles.topic}>{post.topic}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={post.published}>{formatPostDate(post.published)}</time>
                    <span aria-hidden="true">·</span>
                    <span>{post.readingMinutes} min read</span>
                    {isPublished(post) ? null : (
                      <span className={styles.scheduled}>Scheduled · not public</span>
                    )}
                  </span>
                  <span className={styles.postTitle}>{post.heading}</span>
                  <span className={styles.postDek}>{post.dek}</span>
                  <span className={styles.read}>
                    Read this post
                    <VaultIcon name="chevron-right" size={15} />
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
