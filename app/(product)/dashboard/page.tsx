"use client";

import { featureAvailable } from "@/lib/steam-capabilities";
import { useMemo } from "react";
import Link from "next/link";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { GuestPreviewNotice } from "@/components/guest/GuestPreviewNotice";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import { useCompletionClaimNotice } from "@/components/shared/CompletionClaimBanner";
import { useLibraryEnrichmentNotice } from "@/components/shared/LibraryEnrichmentBanner";
import { NoticeStack } from "@/components/shared/NoticeStack";
import { useWelcomeBackNotice } from "@/components/shared/WelcomeBack";
import { useManualProfileAccessNotice } from "@/components/shared/ManualProfileAccessNotice";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ValueDial } from "@/components/dashboard/ValueDial";
import { buildBacklogStats, formatHours, formatMoney, formatValueRate } from "@/lib/backlog-stats";
import { PageHeading } from "@/components/shared/PageHeading";
import { StatCard, StatPanel } from "@/components/shared/StatCard";
import { SectionHeading } from "@/components/shared/SectionHeading";
import { PinnedCommitments } from "@/components/shared/PinnedCommitments";
import { formatGameDuration } from "@/lib/game-duration";
import styles from "./dashboard.module.css";

export default function DashboardPage() {
  const { games, isLive, isLoading, playtime, steamImport, steamImportChecked, capabilities, vaultState, recordVaultAction } = useAppData();
  const enrichmentNotice = useLibraryEnrichmentNotice();
  const completionNotice = useCompletionClaimNotice();
  const welcomeNotice = useWelcomeBackNotice();
  const manualProfileAccessNotice = useManualProfileAccessNotice();

  const stats = useMemo(() => buildBacklogStats(games), [games]);

  const recentCompletions = useMemo(
    () => games
      .filter((game) => game.status === "Completed" && game.completedAt)
      .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))
      .slice(0, 8),
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

  const guestSummary = useMemo(() => ({
    genres: new Set(games.flatMap((game) => game.genres)).size,
    timed: games.filter((game) => formatGameDuration(game.duration)).length,
    reviewed: games.filter((game) => Number(game.reviewTotal ?? 0) > 0).length,
    // Three across, four down.
    featured: games.slice(0, 12)
  }), [games]);

  if (!isLive) {
    return (
      <div className={styles.page}>
        <PageHeading title="Dashboard preview" />

        <GuestPreviewNotice feature="Dashboard" icon="details" catalogueSize={games.length}>
          These are catalogue facts, not claims about your library. Connect a public Steam library whenever you want this dashboard to become yours.
        </GuestPreviewNotice>

        <section className={styles.hero}>
          <p className={styles.heroLabel}>Guest catalogue ready</p>
          <p className={styles.heroValue}>{games.length}<span> popular Steam games</span></p>
          <p className={styles.heroHint}>Browse the catalogue, build a preview collection or ask the Vault to choose one.</p>
        </section>

        <StatPanel label="Guest catalogue summary" columns={4}>
          <StatCard label="Catalogue games" value={games.length} note="Popular games available to explore." />
          <StatCard label="Genres represented" value={guestSummary.genres} note="Useful for trying Vault filters." />
          <StatCard label="Time estimates" value={guestSummary.timed} note="Games with a known playthrough length." />
          <StatCard label="Review signals" value={guestSummary.reviewed} note="Games with public Steam review data." />
        </StatPanel>

        <section className={styles.section}>
          <SectionHeading title="A look inside the guest catalogue" />
          <ol className={`${styles.cardGrid} ${styles.guestGrid}`}>
            {guestSummary.featured.map((game) => (
              <li key={game.id} className={styles.gameCard}>
                <span className={styles.cardArt}><Artwork src={game.bannerUrl} sizes="(max-width: 760px) 45vw, 240px" /></span>
                <strong className={styles.cardTitle}>{game.title}</strong>
                <small className={styles.cardMeta}>{game.genres.slice(0, 3).join(" · ") || "Steam catalogue"}</small>
                <span className={styles.cardValue}>{formatGameDuration(game.duration) ?? "Length unknown"}</span>
              </li>
            ))}
          </ol>
          <Link
            className={styles.centredAction}
            href="/vault"
            onClick={() => trackEvent(ANALYTICS_EVENTS.guestPreviewAction, {
              feature: "dashboard",
              action: "open_vault",
            })}
          >
            Try a Vault draw<VaultIcon name="chevron-right" size={16} />
          </Link>
        </section>
      </div>
    );
  }

  const awaitingFirstLibrary = games.length === 0 && (
    isLoading
    || !steamImportChecked
    || steamImport.status === "idle"
    || steamImport.status === "fetching"
    || steamImport.status === "importing"
    || steamImport.status === "failed"
  );

  return (
    <div className={styles.page}>
      <h1 className="visually-hidden">Dashboard</h1>

      {awaitingFirstLibrary ? null : (
        <>
          {/* The only place in the app that carries these. Everywhere else is
              for doing one thing, and a strip asking you to go and do something
              else at the top of it was in the way. Still capped and ordered:
              something wrong with the import, then something to action, then
              ambient news. */}
          <NoticeStack
            notices={[
              { id: "manual-profile-access", node: manualProfileAccessNotice },
              { id: "enrichment", node: enrichmentNotice },
              { id: "completion", node: completionNotice },
              { id: "welcome", node: welcomeNotice }
            ]}
          />

          {/* Above everything but the notices. What you said you would play next
              is the one thing here you might act on tonight; the library's value
              and its stats are a standing report that keeps. */}
          <PinnedCommitments
            games={games}
            pins={vaultState.pins ?? []}
            pinnedIds={vaultState.pinnedIds}
            onUnpin={(gameId) => void recordVaultAction("unpinned", gameId)}
            compact
          />

          <ValueDial
            percent={stats.valueCompletedPercent}
            completedValue={formatMoney(stats.completedValueCents, stats.currency)}
            libraryValue={formatMoney(stats.libraryValueCents, stats.currency)}
            completedGames={stats.completedGames}
            totalGames={stats.totalGames}
          />

          <StatPanel label="Backlog summary" columns={5}>
            <StatCard label="Hours played" value={formatHours(stats.totalHours)} note="across the whole library" />
            <StatCard
              label="Play streak"
              value={!featureAvailable("playStreak", capabilities) ? "—" : `${playtime.streakDays}d`}
              note={!featureAvailable("playStreak", capabilities)
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
              <ol className={styles.podium}>
                {bestValueGames.slice(0, 3).map(({ game, centsPerHour }, index) => (
                  <li key={game.id} className={styles.podiumCard} data-place={index + 1}>
                    <span className={styles.cardArt}><Artwork src={game.bannerUrl} sizes="(max-width: 760px) 45vw, 300px" /></span>
                    <span className={styles.place}>
                      <VaultIcon name="trophy" size={18} />
                      {index === 0 ? "1st" : index === 1 ? "2nd" : "3rd"}
                    </span>
                    <strong className={styles.cardTitle}>{game.title}</strong>
                    <small className={styles.cardMeta}>{Math.round(game.hoursPlayed)}h from {formatMoney(Number(game.priceInitial), stats.currency)}</small>
                    <span className={styles.cardValue}>{formatMoney(Math.round(centsPerHour), stats.currency)}<small>/hour</small></span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <section className={styles.section}>
            <SectionHeading title="Recently finished" />
            {recentCompletions.length ? (
              <ol className={styles.cardGrid}>
                {recentCompletions.map((game) => (
                  <li key={game.id} className={styles.gameCard}>
                    <span className={styles.cardArt}><Artwork src={game.bannerUrl} sizes="(max-width: 760px) 45vw, 240px" /></span>
                    <strong className={styles.cardTitle}>{game.title}</strong>
                    <small className={styles.cardMeta}>{new Date(String(game.completedAt)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</small>
                    <span className={styles.cardValue}>{formatMoney(Number(game.priceInitial ?? 0), stats.currency)}</span>
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
        </>
      )}
    </div>
  );
}
