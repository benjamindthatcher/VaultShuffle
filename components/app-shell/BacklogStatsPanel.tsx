"use client";

import Link from "next/link";
import { buildBacklogStats, formatHours, formatMoney, formatValueRate } from "@/lib/backlog-stats";
import type { DemoGame } from "@/lib/demo-data";
import styles from "./BacklogStatsPanel.module.css";

/**
 * The glance version, for the account menu.
 *
 * Leads with value completed because that is the number worth coming back for:
 * it moves every time a game is finished, which is exactly the loop the app is
 * trying to create. The rival paywalls this same figure.
 */
export function BacklogStatsPanel({ games }: { games: DemoGame[] }) {
  const stats = buildBacklogStats(games);
  if (!stats.totalGames) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.headline}>
        <p className={styles.label}>Library completed</p>
        <p className={styles.value}>
          {formatMoney(stats.completedValueCents, stats.currency)}
          <span className={styles.of}> of {formatMoney(stats.libraryValueCents, stats.currency)}</span>
        </p>
        <div className={styles.track} role="img" aria-label={`${stats.valueCompletedPercent}% of library value completed`}>
          <span className={styles.fill} style={{ width: `${Math.max(stats.valueCompletedPercent, 1.5)}%` }} />
        </div>
        <p className={styles.hint}>{stats.valueCompletedPercent}% of your library&apos;s value finished</p>
      </div>

      <dl className={styles.grid}>
        <div><dt>Completed</dt><dd>{stats.completedGames} <small>of {stats.totalGames} · {stats.completedPercent}%</small></dd></div>
        <div><dt>Hours played</dt><dd>{formatHours(stats.totalHours)}</dd></div>
        <div><dt>Never opened</dt><dd>{stats.unplayedGames} <small>· {formatMoney(stats.unplayedValueCents, stats.currency)}</small></dd></div>
        {stats.bestValue ? (
          <div><dt>Best value</dt><dd className={styles.tight}>{stats.bestValue.title} <small>· {formatValueRate(stats.bestValue, stats.currency)}</small></dd></div>
        ) : null}
      </dl>

      {stats.latestCompletion ? (
        <p className={styles.latest}>
          <span>Last finished</span>
          <strong>{stats.latestCompletion.title}</strong>
        </p>
      ) : null}

      <Link className={styles.more} href="/stats">See everything</Link>
    </div>
  );
}
