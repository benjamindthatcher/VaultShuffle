"use client";

import { useMemo } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { measureLibraryEnrichment } from "@/lib/library-enrichment";
import styles from "./LibraryEnrichmentBanner.module.css";

/** Below this it is not worth saying anything; the gaps are rounding. */
const QUIET_THRESHOLD = 97;

/**
 * Says out loud that the library is still being filled in.
 *
 * The import returns in seconds and enriches in the background, so the app has
 * always claimed to be finished while lengths and genres arrived over the days
 * that followed. That is why a pick can say "no length estimate yet" with nothing
 * to explain it. This disappears on its own once the gaps close.
 */
export function LibraryEnrichmentBanner() {
  const { games, isLive } = useAppData();
  const measure = useMemo(() => measureLibraryEnrichment(games), [games]);

  if (!isLive || !measure.total || measure.percent >= QUIET_THRESHOLD) return null;

  const missing = measure.total - measure.ready;
  return (
    <section className={styles.banner} aria-label="Library details still arriving">
      <span className={styles.icon}><VaultIcon name="clock" size={19} /></span>
      <div className={styles.copy}>
        <strong>Still filling in {missing} {missing === 1 ? "game" : "games"}</strong>
        <small>
          {measure.ready} of {measure.total} have full details.
          {measure.missingLength ? ` ${measure.missingLength} still need a length estimate.` : ""}
          {" "}Draws work now and get sharper as this fills in.
        </small>
      </div>
      <div className={styles.meter} role="img" aria-label={`${measure.percent}% of your library has full details`}>
        <span className={styles.fill} style={{ width: `${Math.max(measure.percent, 2)}%` }} />
        <em>{measure.percent}%</em>
      </div>
    </section>
  );
}
