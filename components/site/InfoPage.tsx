import type { ReactNode } from "react";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import styles from "./InfoPage.module.css";

export type InfoSection = {
  title: string;
  /**
   * A node rather than a string, which is the whole point of the change: a
   * string cannot hold a link, and these pages spend their time telling people
   * to go and do things - email support, open Analytics Settings, read the
   * Steam Data page - with no way to get there.
   */
  body: ReactNode;
  /** Expanded on arrival. Reserved for the sections someone came here to read. */
  open?: boolean;
  icon?: VaultIconName;
};

export type InfoOverview = {
  title: string;
  body: ReactNode;
  icon?: VaultIconName;
};

/**
 * The information pages: privacy, terms, Steam data.
 *
 * Sections are <details>, so a long document opens as a scannable list of
 * headings rather than a wall of prose. Native elements, deliberately: no
 * JavaScript, the pages stay static, and the closed text is still in the
 * document for search engines and for Ctrl+F in browsers that look inside.
 */
export function InfoPage({ eyebrow, title, intro, sections, icon = "details", overview, variant = "document" }: {
  eyebrow: string;
  title: string;
  intro: string;
  sections: InfoSection[];
  icon?: VaultIconName;
  overview?: InfoOverview;
  variant?: "document" | "release";
}) {
  return (
    <article className={`${styles.page} ${variant === "release" ? styles.releasePage : styles.documentPage}`}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1>{title}</h1>
      <p className={styles.intro}>{intro}</p>
      {overview ? (
        <section className={styles.overview} aria-labelledby="information-overview-title">
          <div className={styles.overviewInner}>
            <div className={styles.overviewHead}>
              <VaultIcon name={overview.icon ?? icon} size={17} />
              <h2 id="information-overview-title">{overview.title}</h2>
            </div>
            <div className={styles.overviewBody}>{overview.body}</div>
          </div>
        </section>
      ) : null}
      <div className={styles.sections}>
        {sections.map((section) => (
          <details
            key={section.title}
            className={`${styles.section} ${variant === "release" ? styles.sectionRelease : styles.sectionDocument}`}
            open={section.open}
          >
            <summary className={styles.summary}>
              {variant === "release" ? (
                <>
                  <h2>{section.title}</h2>
                  <span className={styles.chevron} aria-hidden="true" />
                </>
              ) : (
                <span className={styles.summaryInner}>
                  <VaultIcon className={styles.sectionIcon} name={section.icon ?? icon} size={17} />
                  <h2>{section.title}</h2>
                  <span className={styles.chevron} aria-hidden="true" />
                </span>
              )}
            </summary>
            <div className={styles.body}>
              {variant === "release" ? section.body : <div className={styles.bodyInner}>{section.body}</div>}
            </div>
          </details>
        ))}
      </div>
    </article>
  );
}
