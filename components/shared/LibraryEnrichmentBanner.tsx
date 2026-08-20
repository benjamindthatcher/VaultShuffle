"use client";

import { useMemo } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { measureLibraryEnrichment } from "@/lib/library-enrichment";
import styles from "./LibraryEnrichmentBanner.module.css";

/**
 * Shown only while catalogue work is genuinely in flight.
 *
 * It used to report every game without a length, which mostly meant games whose
 * length does not exist — endless titles, or obscure ones no duration database
 * covers. That number never went down, and there was nothing the player could do
 * about it. Now it appears after an import, counts down, and goes away.
 */
export function LibraryEnrichmentBanner() {
  const { games, isLive } = useAppData();
  const measure = useMemo(() => measureLibraryEnrichment(games), [games]);

  if (!isLive || !measure.processing) return null;

  return (
    <section className={styles.banner} aria-label="Library still being set up">
      <span className={styles.icon}><VaultIcon name="clock" size={19} /></span>
      <div className={styles.copy}>
        <strong>Setting up {measure.processing} {measure.processing === 1 ? "game" : "games"}</strong>
        <small>
          Fetching lengths and tags from Steam. You can draw now — these join in as they land.
        </small>
      </div>
      <div className={styles.meter} role="img" aria-label={`${measure.ready} of ${measure.total} games ready`}>
        <span className={styles.fill} style={{ width: `${Math.max(measure.percent, 2)}%` }} />
        <em>{measure.percent}%</em>
      </div>
    </section>
  );
}
