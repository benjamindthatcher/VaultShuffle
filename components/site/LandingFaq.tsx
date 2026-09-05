"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import { LANDING_FAQ } from "./landing-faq";
import styles from "./landing-experience.module.css";

export function LandingFaq() {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const measure = measureRef.current;
    if (!list || !measure) return;
    const update = () => {
      const answers = Array.from(measure.querySelectorAll("p"));
      const headings = Array.from(measure.querySelectorAll("button"));
      list.style.setProperty("--faq-answer-height", `${Math.ceil(Math.max(...answers.map((item) => item.getBoundingClientRect().height)))}px`);
      list.style.setProperty("--faq-heading-height", `${Math.ceil(Math.max(...headings.map((item) => item.getBoundingClientRect().height)))}px`);
    };
    const observer = new ResizeObserver(update);
    observer.observe(measure);
    update();
    return () => observer.disconnect();
  }, []);

  return (
    <section id="faq" className={styles.faqSection} aria-labelledby="faq-title">
      <div className={styles.sectionIntro}>
        <h2 id="faq-title">Questions about<span>your Steam backlog.</span></h2>
      </div>
      <div className={styles.faqList} ref={listRef}>
        <div className={styles.faqMeasure} ref={measureRef} aria-hidden="true" inert>
          {LANDING_FAQ.map((item) => (
            <div key={item.question}>
              <button className={styles.faqSummary} tabIndex={-1}><span>{item.question}</span><span className={styles.faqChevron} /></button>
              <p>{item.answer}</p>
            </div>
          ))}
        </div>
        {LANDING_FAQ.map((item, index) => (
          <div key={item.question} className={styles.faqItem} data-open={active === index}>
            <h3 className={styles.faqHeading}>
              <button id={`faq-question-${index}`} className={styles.faqSummary}
                aria-expanded={active === index} aria-controls={`faq-answer-${index}`}
                onClick={() => setActive(index)}>
                <span>{item.question}</span>
                <span className={styles.faqChevron} aria-hidden="true" />
              </button>
            </h3>
            <div id={`faq-answer-${index}`} className={styles.faqAnswer}
              role="region" aria-labelledby={`faq-question-${index}`} hidden={active !== index}>
              <p>{item.answer}</p>
            </div>
          </div>
        ))}
      </div>
      <nav className={styles.faqActions} aria-label="More about VaultShuffle">
        <Link href="/faq"><span>More questions?</span><strong>Read the FAQ →</strong></Link>
        <Link href="/releases"><span>See what’s new</span><strong>View releases →</strong></Link>
      </nav>
    </section>
  );
}
