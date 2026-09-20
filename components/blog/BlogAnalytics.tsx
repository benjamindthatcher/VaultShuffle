"use client";

import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { ANALYTICS_EVENTS, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import { observeBlogEngagement } from "@/lib/blog-analytics";
import { isProductAnalyticsEnabled } from "@/lib/posthog-client";

/** The article and index remain server rendered; only measurement is interactive. */
export function BlogAnalytics({ children, slug, topic }: {
  children: ReactNode;
  slug?: string;
  topic?: string;
}) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const article = root.current?.querySelector("article");
    if (!slug || !article) return;
    return observeBlogEngagement(article, ({ visibleSeconds, articleProgress }) => {
      trackEvent(ANALYTICS_EVENTS.blogArticleEngaged, {
        post_slug: slug,
        topic,
        visible_seconds: visibleSeconds,
        article_progress: articleProgress,
      });
    }, isProductAnalyticsEnabled);
  }, [slug, topic]);

  function clicked(event: MouseEvent<HTMLDivElement>) {
    // auxclick covers opening a link with the middle button, not right clicks.
    if (event.button !== 0 && event.button !== 1) return;
    const link = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[data-blog-action]")
      : null;
    if (!link || !event.currentTarget.contains(link)) return;
    const action = link.dataset.blogAction;
    trackNavigationEvent(
      action === "try_guest" ? ANALYTICS_EVENTS.blogCtaClicked : ANALYTICS_EVENTS.blogLinkClicked,
      {
        action,
        blog_page_type: slug ? "article" : "index",
        post_slug: slug ?? link.dataset.postSlug,
        ...(slug && link.dataset.postSlug ? { destination_post_slug: link.dataset.postSlug } : {}),
        topic: topic ?? link.dataset.postTopic,
        ...(link.dataset.gameAppid ? { game_appid: Number(link.dataset.gameAppid) } : {}),
      },
    );
  }

  return <div ref={root} onClickCapture={clicked} onAuxClickCapture={clicked}>{children}</div>;
}
