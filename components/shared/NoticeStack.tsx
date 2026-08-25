"use client";

import { Fragment, type ReactNode } from "react";

/**
 * How many actionable strips may sit above a page's actual content.
 *
 * On a busy account the top of Library could stack pinned games, a recap, a
 * completion prompt, an enrichment notice and a celebration before anything the
 * page is actually for. Each one is individually reasonable, which is exactly
 * how it happens.
 *
 * Three is the cap, and a fourth waits for one of the three to clear rather than
 * pushing the page further down.
 */
export const MAX_STACKED_NOTICES = 3;

export type StackedNotice = { id: string; node: ReactNode };

/**
 * Renders the highest-priority notices that actually have something to say.
 *
 * Priority is the order they are passed in. `reserved` accounts for strips
 * rendered further up by the app shell, so the cap is a property of the whole
 * screen rather than of one component.
 */
export function NoticeStack({ notices, reserved = 0 }: { notices: StackedNotice[]; reserved?: number }) {
  const limit = Math.max(0, MAX_STACKED_NOTICES - reserved);
  const visible = notices.filter((notice) => notice.node).slice(0, limit);
  if (!visible.length) return null;
  return <>{visible.map((notice) => <Fragment key={notice.id}>{notice.node}</Fragment>)}</>;
}
