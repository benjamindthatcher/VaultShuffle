/** Shared by the article registry and the request gate; no article or database imports. */
export const BLOG_SCHEDULE: Record<string, { published: string; draft?: boolean }> = {
  "how-to-choose-your-next-steam-game": { published: "2026-09-28" },
  "steam-deck-games-you-can-beat-in-under-10-hours": { published: "2026-09-17" }
};

export function isUnpublishedArticle(pathname: string, now = Date.now()): boolean {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "blog") return false;
  let slug: string;
  try { slug = decodeURIComponent(parts[1]); } catch { return false; }
  const entry = BLOG_SCHEDULE[slug];
  return Boolean(entry && (entry.draft || new Date(`${entry.published}T00:00:00Z`).getTime() > now));
}
