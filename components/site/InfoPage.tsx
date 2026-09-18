import styles from "./InfoPage.module.css";
<<<<<<< Updated upstream
export function InfoPage({ eyebrow, title, intro, sections }: { eyebrow: string; title: string; intro: string; sections: Array<{ title: string; body: string }> }) { return <article className={styles.page}><p className={styles.eyebrow}>{eyebrow}</p><h1>{title}</h1><p className={styles.intro}>{intro}</p><div className={styles.sections}>{sections.map((section) => <section key={section.title}><h2>{section.title}</h2><p>{section.body}</p></section>)}</div></article>; }
=======

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
  /**
   * Omit to inherit the page's icon. `null` renders no icon at all, which a
   * heading that reads as a label rather than as a section wants: "More posts"
   * is a signpost, and an arrow beside it was a second thing to look at
   * pointing at a button that already says where it goes.
   */
  icon?: VaultIconName | null;
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
 *
 * The "article" variant is the exception, and the reason is what the reader is
 * doing. Nobody reads a privacy policy top to bottom - they arrive looking for
 * one clause, so collapsing the rest is a service. A blog post is the opposite:
 * it is read in order, and a dropdown between every heading is an obstacle. So
 * that variant renders the same sections as headings and prose, keeping the
 * surfaces, the measure and the body rules and dropping only the chrome that
 * exists for scanning.
 */
const PAGE_VARIANT_CLASS: Record<"document" | "release" | "article", string> = {
  document: styles.documentPage,
  release: styles.releasePage,
  article: styles.articlePage
};

/** Undefined inherits the page's icon; null means no icon. */
function sectionIcon(section: InfoSection, pageIcon: VaultIconName): VaultIconName | null {
  return section.icon === null ? null : section.icon ?? pageIcon;
}

export function InfoPage({ eyebrow, title, intro, sections, icon = "details", overview, variant = "document" }: {
  eyebrow: string;
  title: string;
  /** Omit it and nothing renders in its place. */
  intro?: string;
  sections: InfoSection[];
  icon?: VaultIconName;
  overview?: InfoOverview;
  variant?: "document" | "release" | "article";
}) {
  return (
    <article className={`${styles.page} ${PAGE_VARIANT_CLASS[variant]}`}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1>{title}</h1>
      {/* A post's standfirst is the header of the pane below rather than a line
          under the headline, so the article variant renders it there instead. */}
      {intro && variant !== "article" ? <p className={styles.intro}>{intro}</p> : null}
      {/* One pane for a post, several cards for a document.
          A legal page is a set of separate answers and looks like one. A post is
          a single continuous read, so the lede and every section share one
          surface with rules between them, rather than being parcelled into
          cards that imply each part stands alone. */}
      {variant === "article" ? (
        <div className={styles.articlePane}>
          {/* The releases page's version bar, which is the header of the
              container that holds a whole release. Here it holds a whole post,
              and what it says is the standfirst. */}
          {intro ? <p className={styles.articleBar}>{intro}</p> : null}
          <div className={styles.articleBody}>
          {overview ? (
            <section className={styles.articleLede}>
              {/* A blog post opens by talking to you, not by labelling itself.
                  An empty title renders no heading, so the lede can just be
                  prose under the headline. */}
              {overview.title ? (
                <div className={styles.articleHeading}>
                  <VaultIcon className={styles.sectionIcon} name={overview.icon ?? icon} size={18} />
                  <h2>{overview.title}</h2>
                </div>
              ) : null}
              <div className={styles.overviewBody}>{overview.body}</div>
            </section>
          ) : null}
          {/* No <details>: an article is read in order, so `open` does not
              apply and every section is simply present. */}
          {sections.map((section, index) => (
            <section key={section.title || index} className={styles.articleSection}>
              {section.title ? (
                <div className={styles.articleHeading}>
                  {sectionIcon(section, icon) ? (
                    <VaultIcon className={styles.sectionIcon} name={sectionIcon(section, icon)!} size={18} />
                  ) : null}
                  <h2>{section.title}</h2>
                </div>
              ) : null}
              <div className={styles.body}>
                <div className={styles.bodyInner}>{section.body}</div>
              </div>
            </section>
          ))}
          </div>
        </div>
      ) : (
        <>
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
                  {sectionIcon(section, icon) ? (
                    <VaultIcon className={styles.sectionIcon} name={sectionIcon(section, icon)!} size={17} />
                  ) : null}
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
        </>
      )}
    </article>
  );
}
>>>>>>> Stashed changes
