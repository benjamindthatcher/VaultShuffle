import Link from "next/link";
import { SiteGlyph } from "@/components/shared/SiteGlyph";
import { marketingNavigation, type MarketingPageContent } from "@/lib/marketing-pages";
import { siteConfig } from "@/lib/site";
import styles from "./MarketingPage.module.css";

export function MarketingPage({ page }: { page: MarketingPageContent }) {
  const url = `${siteConfig.url}/${page.slug}`;
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${url}#webpage`,
        url,
        name: page.metaTitle,
        description: page.description,
        isPartOf: { "@id": `${siteConfig.url}/#website` },
        about: { "@id": `${siteConfig.url}/#application` },
        inLanguage: "en-GB"
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "VaultShuffle",
            item: siteConfig.url
          },
          {
            "@type": "ListItem",
            position: 2,
            name: page.navLabel,
            item: url
          }
        ]
      },
      {
        "@type": "FAQPage",
        mainEntity: page.faqs.map((faq) => ({
          "@type": "Question",
          name: faq.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: faq.answer
          }
        }))
      }
    ]
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c")
        }}
      />
      <main className={styles.page}>
        <header className={styles.header}>
          <Link className={styles.brand} href="/" aria-label="VaultShuffle home">
            <span className={styles.brandMark}><SiteGlyph name="open-vault" size={23} /></span>
            <span>VaultShuffle</span>
          </Link>
          <nav className={styles.nav} aria-label="Product guides">
            {marketingNavigation.map((link) => (
              <Link
                className={link.href === `/${page.slug}` ? styles.current : undefined}
                href={link.href}
                key={link.href}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <Link className={styles.headerCta} href="/vault">Try guest mode</Link>
        </header>

        <section className={styles.hero} aria-labelledby="marketing-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>{page.eyebrow}</p>
            <h1 id="marketing-title">{page.title}</h1>
            <p className={styles.intro}>{page.intro}</p>
            <div className={styles.actions}>
              <Link className={styles.primaryAction} href="/login">
                <SiteGlyph name="steam" size={23} />
                Connect Steam
                <SiteGlyph name="chevron-right" size={19} />
              </Link>
              <Link className={styles.secondaryAction} href="/vault">
                Try with demo games
              </Link>
            </div>
            <p className={styles.reassurance}>
              <SiteGlyph name="lock" size={18} /> Steam handles sign-in. VaultShuffle never sees your password.
            </p>
          </div>

          <aside className={styles.heroPanel} aria-label={`${page.navLabel} overview`}>
            <div className={styles.heroIcon}><SiteGlyph name={page.icon} size={54} /></div>
            <p className={styles.panelLabel}>Built for the decision before play</p>
            <h2>{page.socialTitle}</h2>
            <div className={styles.highlights}>
              {page.highlights.map((highlight) => (
                <div key={highlight.label}>
                  <strong>{highlight.value}</strong>
                  <span>{highlight.label}</span>
                </div>
              ))}
            </div>
          </aside>
        </section>

        <section className={styles.detailGrid} aria-label={`${page.navLabel} features`}>
          {page.sections.map((section, index) => (
            <article key={section.title}>
              <span className={styles.sectionNumber}>{String(index + 1).padStart(2, "0")}</span>
              <h2>{section.title}</h2>
              <p>{section.body}</p>
              {section.bullets ? (
                <ul>
                  {section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
                </ul>
              ) : null}
            </article>
          ))}
        </section>

        <section className={styles.steps} aria-labelledby="steps-title">
          <p className={styles.eyebrow}>Three simple steps</p>
          <h2 id="steps-title">From indecision to playing</h2>
          <div className={styles.stepGrid}>
            {page.steps.map((step, index) => (
              <article key={step.title}>
                <span>{index + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.faq} aria-labelledby="faq-title">
          <div>
            <p className={styles.eyebrow}>Straight answers</p>
            <h2 id="faq-title">Frequently asked questions</h2>
            <p>Everything important before you connect a Steam account or try the demo.</p>
          </div>
          <div className={styles.faqList}>
            {page.faqs.map((faq) => (
              <details key={faq.question}>
                <summary>{faq.question}<SiteGlyph name="chevron-down" size={19} /></summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={styles.finalCta} aria-labelledby="final-cta-title">
          <div>
            <p className={styles.eyebrow}>Start free</p>
            <h2 id="final-cta-title">{page.ctaTitle}</h2>
            <p>{page.ctaCopy}</p>
          </div>
          <div className={styles.actions}>
            <Link className={styles.primaryAction} href="/vault">Try guest mode</Link>
            <Link className={styles.secondaryAction} href="/login">Connect Steam</Link>
          </div>
        </section>
      </main>
    </>
  );
}
