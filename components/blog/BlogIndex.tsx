import Link from "next/link";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { formatPostDate, isPublished, type BlogPost } from "@/lib/blog/posts";
import { PostCover } from "./PostCover";
import styles from "./BlogIndex.module.css";

export function BlogIndex({ posts }: { posts: BlogPost[] }) {
  return (
    <div className={styles.page}>
      <p className={styles.eyebrow}>Blog</p>
      <h1>Notes from the Vault</h1>

      {posts.length === 0 ? (
        <p className={styles.empty}>Nothing published yet. The first post is on its way.</p>
      ) : (
        <ul className={styles.list}>
          {posts.map((post, index) => (
            <li key={post.slug}>
              <Link className={styles.post} href={`/blog/${post.slug}`} data-blog-action="open_post" data-post-slug={post.slug} data-post-topic={post.topic}>
                <PostCover banner={post.banner} layout="feature" eager={index === 0} />
                <div className={styles.postBody}>
                  <span className={styles.meta}>
                    <span className={styles.topic}>{post.topic}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={post.published}>{formatPostDate(post.published)}</time>
                    <span aria-hidden="true">·</span>
                    <span>{post.readingMinutes} min read</span>
                    {isPublished(post) ? null : (
                      <span className={styles.scheduled}>{post.draft ? "Draft" : "Scheduled"} · not public</span>
                    )}
                  </span>
                  <h2 className={styles.postTitle}>{post.heading}</h2>
                  <span className={styles.postDek}>{post.dek}</span>
                  <span className={styles.read}>
                    Read this post
                    <VaultIcon name="chevron-right" size={15} />
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
