"use client";

import { useEffect, useId, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import styles from "./PinnedCommitments.module.css";

export function PinnedPlaytimeRefresh() {
  const { isLive, isSyncing, isRefreshingPinnedPlaytime, pinnedRefreshAvailableAt, refreshPinnedPlaytime } = useAppData();
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const noticeId = useId();

  useEffect(() => {
    let timer = 0;
    const update = () => {
      const seconds = Math.max(0, Math.ceil(((pinnedRefreshAvailableAt ?? 0) - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0 && timer) window.clearInterval(timer);
    };
    const firstTick = window.setTimeout(update, 0);
    timer = window.setInterval(update, 1000);
    return () => {
      window.clearTimeout(firstTick);
      window.clearInterval(timer);
    };
  }, [pinnedRefreshAvailableAt]);

  if (!isLive) return null;

  async function handleRefresh() {
    setNotice(null);
    try {
      const result = await refreshPinnedPlaytime();
      const updated = result.refreshed;
      setNotice({
        error: result.skipped > 0,
        message: result.skipped > 0
          ? `Refreshed ${updated} of ${updated + result.skipped} pinned games. The rest were left unchanged.`
          : updated > 0
            ? `Playtime updated for ${updated} pinned game${updated === 1 ? "" : "s"}. Steam can take a little while to catch up after playing.`
            : "No pinned games to refresh.",
      });
    } catch (error) {
      setNotice({ error: true, message: error instanceof Error
        ? error.message === "unauthorized" ? "Please sign in again to refresh your pinned games." : error.message
        : "Playtime could not be refreshed. Your saved progress is unchanged; please try again." });
    }
  }

  return <>
    <button
      type="button"
      className={styles.refreshButton}
      disabled={isRefreshingPinnedPlaytime || isSyncing || remaining > 0}
      onClick={() => void handleRefresh()}
      title={isSyncing ? "Your Steam library is already syncing" : "Refresh playtime from Steam for your pinned games only"}
      aria-label={isRefreshingPinnedPlaytime ? "Refreshing pinned game playtime" : remaining > 0 ? `Refresh pinned game playtime in ${remaining} seconds` : "Refresh pinned game playtime"}
      aria-describedby={notice ? noticeId : undefined}
      aria-busy={isRefreshingPinnedPlaytime}
    >
      <span className={styles.refreshIcon} data-spinning={isRefreshingPinnedPlaytime || undefined} aria-hidden="true">
        <SiteGlyph name="refresh-data" size={16} />
      </span>
      {isRefreshingPinnedPlaytime ? "Refreshing…" : isSyncing ? "Library syncing…" : remaining > 0 ? `Refresh in ${remaining}s` : "Refresh playtime"}
    </button>
    <p id={noticeId} className={styles.refreshFeedback} data-error={notice?.error || undefined} role="status" aria-atomic="true">
      {notice?.message ?? ""}
    </p>
  </>;
}
