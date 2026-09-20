/** Per-event properties only: blog context must not leak into later app views. */
export function blogPageProperties(pathname: string): Record<string, string> {
  if (pathname === "/blog") return { app_area: "blog", blog_page_type: "index" };
  const match = /^\/blog\/([^/]+)\/?$/.exec(pathname);
  return match
    ? { app_area: "blog", blog_page_type: "article", post_slug: match[1] }
    : {};
}

export type BlogEngagement = { visibleSeconds: number; articleProgress: number };

/** One event per visit. Hidden tabs and suspended timers do not count as reading. */
export function observeBlogEngagement(
  article: HTMLElement,
  onEngaged: (engagement: BlogEngagement) => void,
  isEnabled: () => boolean,
): () => void {
  let visibleSeconds = 0;
  let lastTick = performance.now();
  let wasVisible = document.visibilityState === "visible";

  const visibilityChanged = () => {
    wasVisible = document.visibilityState === "visible";
    lastTick = performance.now();
  };
  const cleanup = () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", visibilityChanged);
  };
  const timer = window.setInterval(() => {
    const now = performance.now();
    const elapsed = (now - lastTick) / 1000;
    lastTick = now;
    if (!isEnabled()) {
      visibleSeconds = 0;
      return;
    }
    const visible = document.visibilityState === "visible";
    const bounds = article.getBoundingClientRect();
    const inView = bounds.top < window.innerHeight && bounds.bottom > 0;
    if (visible && wasVisible && inView && elapsed <= 2) visibleSeconds += elapsed;
    wasVisible = visible;
    const articleProgress = bounds.height > 0
      ? Math.min(100, Math.max(0, Math.round((window.innerHeight - bounds.top) / bounds.height * 100)))
      : 0;
    if (visible && inView && visibleSeconds >= 30 && articleProgress >= 50) {
      cleanup();
      onEngaged({ visibleSeconds: Math.floor(visibleSeconds), articleProgress });
    }
  }, 1000);
  document.addEventListener("visibilitychange", visibilityChanged);
  return cleanup;
}
