import type { ReactNode } from "react";
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
};

/**
 * The information pages: privacy, terms, Steam data.
 *
 * Sections are <details>, so a long document opens as a scannable list of
 * headings rather than a wall of prose. Native elements, deliberately: no
 * JavaScript, the pages stay static, and the closed text is still in the
 * document for search engines and for Ctrl+F in browsers that look inside.
 */
export function InfoPage({ eyebrow, title, intro, sections }: {
  eyebrow: string;
  title: string;
  intro: string;
  sections: InfoSection[];
}) {
  return (
    <article className={styles.page}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1>{title}</h1>
      <p className={styles.intro}>{intro}</p>
      <div className={styles.sections}>
        {sections.map((section) => (
          <details key={section.title} className={styles.section} open={section.open}>
            <summary className={styles.summary}>
              <h2>{section.title}</h2>
              <span className={styles.chevron} aria-hidden="true" />
            </summary>
            <div className={styles.body}>{section.body}</div>
          </details>
        ))}
      </div>
    </article>
  );
}
