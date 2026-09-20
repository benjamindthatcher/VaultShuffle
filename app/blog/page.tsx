import type { Metadata } from "next";
import { BlogAnalytics } from "@/components/blog/BlogAnalytics";
import { BlogIndex } from "@/components/blog/BlogIndex";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
import { canPreviewScheduled, isPublished, listPosts } from "@/lib/blog/posts";
import { pageOpenGraph, pageTwitter, siteConfig } from "@/lib/site";

const description =
  "Data and writing about Steam backlogs from VaultShuffle: how much of a library goes unplayed, which games actually get finished, and lists of games worth your evening.";

/**
 * The title tag carries the keywords the h1 no longer does.
 *
 * "Notes from the backlog" is a column's name - right on the page, useless in a
 * result list, where nobody is scanning for a column they have never heard of.
 * A title and an h1 are allowed to differ, and this is the case for it: one is
 * read by someone already here, the other by someone deciding whether to come.
 */
export const metadata: Metadata = {
  title: "Steam Backlog Notes & Game Lists",
  description,
  alternates: { canonical: "/blog" },
  openGraph: pageOpenGraph({ url: "/blog", title: "VaultShuffle Blog", description }),
  twitter: pageTwitter({ title: "VaultShuffle Blog", description })
};

/**
 * An hour, because this page is how a scheduled post lets itself out. A post
 * whose date passes is not in this list until the page regenerates, so the
 * window is the worst-case delay between a post's date and it being linked.
 */
export const revalidate = 3600;

export default function BlogIndexPage() {
  const posts = listPosts({ includeScheduled: canPreviewScheduled() });

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Blog",
    "@id": `${siteConfig.url}/blog#blog`,
    url: `${siteConfig.url}/blog`,
    name: `${siteConfig.name} Blog`,
    description,
    inLanguage: "en-GB",
    publisher: { "@id": `${siteConfig.url}/#organization` },
    blogPost: posts
      .filter((post) => isPublished(post))
      .map((post) => ({
        "@type": "BlogPosting",
        "@id": `${siteConfig.url}/blog/${post.slug}#post`,
        headline: post.heading,
        description: post.description,
        datePublished: post.published,
        url: `${siteConfig.url}/blog/${post.slug}`
      }))
  };

  return (
    <SharedInformationShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c")
        }}
      />
      <BlogAnalytics><BlogIndex posts={posts} /></BlogAnalytics>
    </SharedInformationShell>
  );
}
