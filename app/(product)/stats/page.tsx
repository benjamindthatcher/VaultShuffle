"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { GuestFeatureGate } from "@/components/guest/GuestFeatureGate";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { Artwork } from "@/components/shared/Artwork";
import { buildBacklogStats, formatHours, formatMoney, formatValueRate } from "@/lib/backlog-stats";
import styles from "./stats.module.css";

export default function StatsPage() {
  const { games, isLive } = useAppData();
  const stats = useMemo(() => buildBacklogStats(games), [games]);

  const recentCompletions = useMemo(
    () => games
      .filter((game) => game.status === "Completed" && game.completedAt)
      .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))
      .slice(0, 6),
    [games]
  );

  const bestValueGames = useMemo(
    () => games
      .filter((game) => game.ownership === "Owned" && game.hoursPlayed >= 1 && Number(game.priceInitial ?? 0) > 0)
      .map((game) => ({ game, centsPerHour: Number(game.priceInitial) / game.hoursPlayed }))
      .sort((left, right) => left.centsPerHour - right.centsPerHour)
      .slice(0, 5),
    [games]
  );

  if (!isLive) {
    return (
      <GuestFeatureGate
        feature="Backlog stats"
        icon="details"
        title="See what your backlog is actually worth"
        description="Connect Steam and VaultShuffle can show what you own, what you have finished, and which games gave you the most for your money."
        benefits={[
          "Track how much of your library's value you have actually completed",
          "See the games sitting unopened, and what they cost",
          "Find the best value you have ever had from a game"
        ]}
      />
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Your backlog</p>
        <h1>The damage so far</h1>
        <p className={styles.sub}>
          Values are Steam&apos;s current store prices for the {stats.pricedGames} of {stats.totalGames} games we have
          pricing for — what they sell for now, not what you paid for them.
        </p>
      </header>

      <section className={styles.hero}>
        <p className={styles.heroLabel}>Library value completed</p>
        <p className={styles.heroValue}>
          {formatMoney(stats.completedValueCents, stats.currency)}
          <span> of {formatMoney(stats.libraryValueCents, stats.currency)}</span>
        </p>
        <div className={styles.track} role="img" aria-label={`${stats.valueCompletedPercent}% completed`}>
          <span className={styles.fill} style={{ width: `${Math.max(stats.valueCompletedPercent, 1.5)}%` }} />
        </div>
        <p className={styles.heroHint}>
          {stats.valueCompletedPercent}% finished · {stats.completedGames} of {stats.totalGames} games
        </p>
      </section>

      <section className={styles.tiles}>
        <article><p>Hours played</p><strong>{formatHours(stats.totalHours)}</strong><small>across the whole library</small></article>
        <article><p>Games completed</p><strong>{stats.completedPercent}%</strong><small>{stats.completedGames} of {stats.totalGames}</small></article>
        <article><p>Never opened</p><strong>{stats.unplayedGames}</strong><small>worth {formatMoney(stats.unplayedValueCents, stats.currency)}</small></article>
        <article><p>Best value</p><strong>{stats.bestValue ? formatValueRate(stats.bestValue, stats.currency) : "—"}</strong><small>{stats.bestValue ? stats.bestValue.title : "Play something to find out"}</small></article>
      </section>

      {bestValueGames.length ? (
        <section className={styles.section}>
          <h2><VaultIcon name="heart" size={18} />Most value for money</h2>
          <ol className={styles.rankList}>
            {bestValueGames.map(({ game, centsPerHour }) => (
              <li key={game.id}>
                <span className={styles.rankArt}><Artwork src={game.bannerUrl} sizes="72px" /></span>
                <span className={styles.rankBody}>
                  <strong>{game.title}</strong>
                  <small>{Math.round(game.hoursPlayed)}h from {formatMoney(Number(game.priceInitial), stats.currency)}</small>
                </span>
                <span className={styles.rankRate}>{formatMoney(Math.round(centsPerHour), stats.currency)}<small>/hour</small></span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className={styles.section}>
        <h2><VaultIcon name="completed" size={18} />Recently finished</h2>
        {recentCompletions.length ? (
          <ol className={styles.rankList}>
            {recentCompletions.map((game) => (
              <li key={game.id}>
                <span className={styles.rankArt}><Artwork src={game.bannerUrl} sizes="72px" /></span>
                <span className={styles.rankBody}>
                  <strong>{game.title}</strong>
                  <small>{new Date(String(game.completedAt)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</small>
                </span>
                <span className={styles.rankRate}>{formatMoney(Number(game.priceInitial ?? 0), stats.currency)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className={styles.empty}>
            <p><strong>Nothing finished yet.</strong> The bar above fills every time you complete something.</p>
            <Link className={styles.emptyAction} href="/vault">Draw something to play</Link>
          </div>
        )}
      </section>
    </div>
  );
}
