"use client";

import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import type { VaultMatchExplanation, VaultMatchInsightKind } from "@/lib/vault";
import styles from "./VaultMatchReasons.module.css";

const ICONS: Record<VaultMatchInsightKind, VaultIconName> = {
  selection: "all-games",
  session: "clock",
  mood: "details",
  goal: "finish",
  taste: "heart",
  appeal: "new",
  dormancy: "calendar",
  genre: "collections",
  family: "family"
};

/**
 * The case for the pick, rather than a row of bare facts.
 *
 * Finish claims explain the estimated playthrough and hours played, without
 * presenting inferred progress as a measured story position.
 */
export function VaultMatchReasons({ explanation }: { explanation: VaultMatchExplanation }) {
  if (!explanation.insights.length) return null;

  return (
    <section className={styles.panel} aria-label="Why this is a good match">
      <header className={styles.header}>
        <p className={styles.label}>Why it&apos;s a great match</p>
        <span className={styles.score} data-strength={explanation.score >= 82 ? "high" : explanation.score >= 60 ? "mid" : "low"}>
          {explanation.label}
        </span>
      </header>

      <ul className={styles.list}>
        {explanation.insights.map((insight) => (
          <li key={`${insight.kind}-${insight.headline}`} className={styles.item} data-strength={insight.strength}>
            <span className={styles.icon} aria-hidden="true">
              <VaultIcon name={ICONS[insight.kind]} size={17} />
            </span>
            <span className={styles.copy}>
              <strong className={styles.headline}>{insight.headline}</strong>
              <span className={styles.detail}>{insight.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
