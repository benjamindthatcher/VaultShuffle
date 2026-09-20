import Link from "next/link";
import type { ReactNode } from "react";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import infoStyles from "@/components/site/InfoPage.module.css";
import styles from "./BlogPieces.module.css";

/** The headline figures a stats post is built around. */
export function StatGrid({ stats }: { stats: { value: string; label: string; note?: string }[] }) {
  return (
    <div className={styles.statGrid}>
      {stats.map((stat) => (
        <div key={stat.label} className={styles.stat}>
          <strong className={styles.statValue}>{stat.value}</strong>
          <span className={styles.statLabel}>{stat.label}</span>
          {stat.note ? <small className={styles.statNote}>{stat.note}</small> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * A plain data table for figures that are not games - length bands, method
 * notes. Shares the game table's surface so a post does not read as two
 * different documents stitched together.
 */
export function DataTable({
  columns,
  rows,
  caption
}: {
  columns: string[];
  rows: (ReactNode[])[];
  caption?: string;
}) {
  return (
    <figure className={styles.tableWrap}>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  cellIndex === 0
                    ? <th key={cellIndex} scope="row">{cell}</th>
                    : <td key={cellIndex} data-label={columns[cellIndex]}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {caption ? <figcaption className={styles.caption}>{caption}</figcaption> : null}
    </figure>
  );
}

/** A horizontal bar, for when the shape of a number is the point. */
export function BarRow({ label, value, max, display }: { label: string; value: number; max: number; display: string }) {
  const width = max === 0 ? 0 : Math.round((value / max) * 100);
  return (
    <div className={styles.barRow}>
      <span className={styles.barLabel}>{label}</span>
      <span className={styles.barTrack}>
        <span className={styles.barFill} style={{ width: `${width}%` }} />
      </span>
      <span className={styles.barValue}>{display}</span>
    </div>
  );
}

/** What the reader is meant to do next. Every post ends with one. */
export function PostCta({ heading, body }: { heading: string; body: string }) {
  return (
    <aside className={styles.cta} aria-label="Try VaultShuffle">
      <div className={styles.ctaEmblem} aria-hidden="true">
        <VaultIcon name="shuffle" size={28} />
      </div>
      <div className={styles.ctaCopy}>
        <h2>{heading}</h2>
        <p>{body}</p>
      </div>
      <div className={styles.ctaActions}>
        <Link className={styles.ctaPrimary} href="/vault" data-blog-action="try_guest">
          Try it as a guest
          <VaultIcon name="chevron-right" size={18} />
        </Link>
        <Link className={styles.ctaSecondary} href="/faq" data-blog-action="faq">
          FAQ
        </Link>
      </div>
    </aside>
  );
}

/**
 * A post's closing block, on the same pane as its opening. Borrowed straight
 * from InfoPage rather than restated here, the way the privacy page already
 * borrows that stylesheet's inlineAction, so the two ends of an article cannot
 * drift apart.
 */
export function PostOutro({ children }: { children: ReactNode }) {
  return <div className={infoStyles.articleProse}>{children}</div>;
}

/** The way back to the index, at the foot of every post. */
export function AllPostsLink() {
  return (
    <p className={styles.allPostsRow}>
      <Link className={styles.allPosts} href="/blog" data-blog-action="all_posts">
        View all posts
      </Link>
    </p>
  );
}

/** A methodology or caveat box. Used wherever a number needs its limits stated. */
export function Aside({ icon = "details", title, children }: {
  icon?: VaultIconName;
  title: string;
  children: ReactNode;
}) {
  return (
    <aside className={styles.note}>
      <p className={styles.noteHead}>
        <VaultIcon name={icon} size={16} />
        {title}
      </p>
      <div className={styles.noteBody}>{children}</div>
    </aside>
  );
}
