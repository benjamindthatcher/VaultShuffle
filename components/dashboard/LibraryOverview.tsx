import Link from "next/link";
import type { ReactNode } from "react";
import { formatHours, formatMoney, formatValueRate, type BacklogOverviewStats } from "@/lib/backlog-stats";
import { ValueDial } from "./ValueDial";
import styles from "./LibraryOverview.module.css";

type OverviewIconName = "overview" | "controller" | "check" | "box" | "tag";

function OverviewIcon({ name }: { name: OverviewIconName }) {
  const paths: Record<OverviewIconName, ReactNode> = {
    overview: <><path d="M3 4h15l-8 16L3 4Zm7 16h10M18 4l2-2M16 15l4-8" /><circle cx="20" cy="19" r="2" /><circle cx="20" cy="4" r="2" /></>,
    controller: <><path d="m7 6-2 1c-2 2-4 10-2 12 2 1 4-4 5-4h8c1 0 3 5 5 4 2-2 0-10-2-12l-2-1H7Z" /><path d="M6 10v4m-2-2h4" /><circle cx="16" cy="10" r=".7" /><circle cx="18" cy="13" r=".7" /></>,
    check: <path d="m4 12 5 5L20 6" />,
    box: <><path d="M4 8v12h16V8M3 4h18v5h-6l-1-3h-4L9 9H3V4Z" /></>,
    tag: <><path d="M3 3h8l10 10-8 8L3 11V3Z" /><circle cx="7.5" cy="7.5" r="1.5" /></>
  };
  return <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function OverviewStat({ icon, label, value, note, rate = false }: {
  icon: OverviewIconName; label: string; value: ReactNode; note: string; rate?: boolean;
}) {
  return (
    <article className={styles.stat}>
      <span className={styles.statIcon}><OverviewIcon name={icon} /></span>
      <div className={styles.statCopy}>
        <p className={styles.statLabel}>{label}</p>
        <p className={`${styles.statValue}${rate ? ` ${styles.rate}` : ""}`}>{value}</p>
        <p className={styles.statNote}>{note}</p>
      </div>
    </article>
  );
}

export function LibraryOverview({ stats }: { stats: BacklogOverviewStats }) {
  return (
    <section className={styles.overview} aria-labelledby="library-overview-heading">
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.headingIcon}><OverviewIcon name="overview" /></span>
          <div>
            <h2 id="library-overview-heading">Your library at a glance</h2>
            <p>A quick overview of your games at a glance.</p>
          </div>
        </div>
        <Link data-vault-control="secondary" className={styles.libraryLink} href="/library">
          View library
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12h15m-5-5 5 5-5 5" /></svg>
        </Link>
      </header>
      <div className={styles.body}>
        <ValueDial percent={stats.valueCompletedPercent} completedValue={formatMoney(stats.completedValueCents, stats.currency)} libraryValue={formatMoney(stats.libraryValueCents, stats.currency)} />
        <div className={styles.stats} role="group" aria-label="Library statistics">
          <OverviewStat icon="controller" label="Hours played" value={formatHours(stats.totalHours)} note={stats.hoursCoverage ?? "across the whole library"} />
          <OverviewStat icon="check" label="Games completed" value={<>{stats.completedGames}<span> / {stats.totalGames}</span></>} note={`${stats.completedPercent}% of your ${stats.familyGames ? "owned " : ""}library${stats.familyGames ? ` · ${stats.familyGames} family not counted` : ""}`} />
          <OverviewStat icon="box" label="Never opened" value={stats.unplayedGames} note={`worth ${formatMoney(stats.unplayedValueCents, stats.currency)}`} />
          <OverviewStat icon="tag" label="Best value" value={stats.bestValue ? formatValueRate(stats.bestValue, stats.currency) : "—"} note={stats.bestValue?.title ?? "Play something to find out"} rate />
        </div>
      </div>
    </section>
  );
}
