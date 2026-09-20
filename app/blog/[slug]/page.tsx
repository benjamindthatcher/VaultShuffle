import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogAnalytics } from "@/components/blog/BlogAnalytics";
import { PostCover } from "@/components/blog/PostCover";
import { AllPostsLink } from "@/components/blog/BlogPieces";
import { InfoPage } from "@/components/site/InfoPage";
import { SharedInformationShell } from "@/components/site/SharedInformationShell";
import {
  canPreviewScheduled,
  formatPostDate,
  getPost,
  isPublished,
  listPosts
} from "@/lib/blog/posts";
import { pageOpenGraph, pageTwitter, siteConfig } from "@/lib/site";

/** Matches the index, so a scheduled post and its link go live together. */
export const revalidate = 3600;

/**
 * Only published posts are prerendered. `dynamicParams` is left at its default
 * of true, so a post that crosses its date is rendered on demand the first
 * time it is requested rather than waiting for a deploy.
 */
export function generateStaticParams() {
  return listPosts().map((post) => ({ slug: post.slug }));
}

type PageProps = { params: Promise<{ slug: string }> };

function visible(slug: string) {
  const post = getPost(slug);
  if (!post) return undefined;
  if (!isPublished(post) && !canPreviewScheduled()) return undefined;
  return post;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = visible(slug);

  if (!post) {
    return { title: "Post not found", robots: { index: false, follow: false } };
  }

  const url = `/blog/${post.slug}`;

  return {
    /* Google shows roughly 60 characters of a title. Appending the brand to a
       keyword led headline pushes it past that and the brand is what gets cut
       anyway, so a long title keeps its words and drops the suffix instead of
       being truncated mid phrase. Short titles still carry it. */
    title: {
      absolute: post.title.length > 45 ? post.title : `${post.title} | VaultShuffle`
    },
    description: post.description,
    alternates: { canonical: url },
    openGraph: pageOpenGraph({ url, title: post.heading, description: post.description }),
    twitter: pageTwitter({ title: post.heading, description: post.description }),
    // A post being proofed locally must never be indexable if it somehow ships.
    ...(isPublished(post) ? {} : { robots: { index: false, follow: false } })
  };
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const post = visible(slug);

  if (!post) notFound();

  const { overview, sections } = await post.content();
  const scheduled = !isPublished(post);

  /* The information pages' eyebrow already carries this kind of context - the
     Steam Data page uses "Data · Updated 4 September 2026". The scheduled
     warning goes here too rather than in furniture of its own. */
  const eyebrow = [
    post.topic,
    formatPostDate(post.published),
    `${post.readingMinutes} min read`,
    post.updated ? `Updated ${formatPostDate(post.updated)}` : null,
    scheduled ? "Scheduled, not public" : null
  ]
    .filter(Boolean)
    .join(" · ");

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        "@id": `${siteConfig.url}/blog/${post.slug}#post`,
        headline: post.heading,
        description: post.description,
        datePublished: post.published,
        dateModified: post.updated ?? post.published,
        inLanguage: "en-GB",
        url: `${siteConfig.url}/blog/${post.slug}`,
        mainEntityOfPage: `${siteConfig.url}/blog/${post.slug}`,
        isPartOf: { "@id": `${siteConfig.url}/blog#blog` },
        author: { "@id": `${siteConfig.url}/#organization` },
        publisher: { "@id": `${siteConfig.url}/#organization` }
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${siteConfig.url}/blog/${post.slug}#breadcrumbs`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: siteConfig.url },
          { "@type": "ListItem", position: 2, name: "Blog", item: `${siteConfig.url}/blog` },
          { "@type": "ListItem", position: 3, name: post.heading }
        ]
      }
    ]
  };

  return (
    <SharedInformationShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c")
        }}
      />
      <BlogAnalytics key={post.slug} slug={post.slug} topic={post.topic}>
      <InfoPage
        eyebrow={eyebrow}
        title={post.heading}
        intro={post.dek}
        cover={<PostCover banner={post.banner} eager />}
        icon={post.icon}
        variant="article"
        /* No label on the lede. "The short version" was the page introducing
           itself, which is the one thing a reader never needs. */
        overview={{ title: "", body: overview }}
        sections={[
          ...sections,
          {
            title: listPosts({ includeScheduled: canPreviewScheduled() }).length > 1 ? "More posts" : "",
            // No arrow: the button under it already says where it goes.
            icon: null,
            body: <AllPostsLink />
          }
        ]}
      />
      </BlogAnalytics>
    </SharedInformationShell>
  );
}
