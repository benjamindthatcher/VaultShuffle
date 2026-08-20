"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { GuestFeatureGate } from "@/components/guest/GuestFeatureGate";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { CompletionClaimBanner } from "@/components/shared/CompletionClaimBanner";
import { ShareCard } from "@/components/stats/ShareCard";
import { LibraryEnrichmentBanner } from "@/components/shared/LibraryEnrichmentBanner";
import { Artwork } from "@/components/shared/Artwork";
import { buildBacklogStats, formatHours, formatMoney, formatValueRate } from "@/lib/backlog-stats";
import { PageHeading } from "@/components/shared/PageHeading";
import { StatCard, StatPanel } from "@/components/shared/StatCard";
import { SectionHeading } from "@/components/shared/SectionHeading";
import styles from "./stats.module.css";

export default function StatsPage() {
  const { games, isLive, playtime } = useAppData();
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
      <PageHeading title="The damage so far" />

      <CompletionClaimBanner />
      <LibraryEnrichmentBanner />

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
          {stats.valueCompletedPercent}% finished · {stats.completedGames} of {stats.totalGames} games ·
          {" "}Steam prices today for {stats.pricedGames} of {stats.totalGames}
        </p>
      </section>

      <StatPanel label="Backlog summary" columns={5}>
        <StatCard label="Hours played" value={formatHours(stats.totalHours)} note="across the whole library" />
        <StatCard
          label="Play streak"
          value={playtime.daysTracked < 2 ? "—" : `${playtime.streakDays}d`}
          note={playtime.daysTracked < 2
            ? "Starts once we have a couple of nights of history"
            : playtime.streakDays
              ? `${Math.round(playtime.minutesLast7Days / 60)}h in the last week`
              : "No play recorded yesterday"}
        />
        <StatCard label="Games completed" value={`${stats.completedPercent}%`} note={`${stats.completedGames} of ${stats.totalGames}`} />
        <StatCard label="Never opened" value={stats.unplayedGames} note={`worth ${formatMoney(stats.unplayedValueCents, stats.currency)}`} />
        <StatCard
          label="Best value"
          value={stats.bestValue ? formatValueRate(stats.bestValue, stats.currency) : "—"}
          note={stats.bestValue ? stats.bestValue.title : "Play something to find out"}
        />
      </StatPanel>

      {bestValueGames.length ? (
        <section className={styles.section}>
          <SectionHeading title="Most value for money" />
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

      <ShareCard />

      <section className={styles.section}>
        <SectionHeading title="Recently finished" />
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
