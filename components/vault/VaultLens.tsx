import Link from "next/link";
import type { VaultEligibilityStage } from "@/lib/vault";
import styles from "./VaultLens.module.css";

type Props = {
  stages: VaultEligibilityStage[];
  selectedCollection: boolean;
  selectedGenres: boolean;
  snoozedCount: number;
  onClearGenres: () => void;
  onUseEntireVault: () => void;
  onClearSnoozes: () => void;
};

export function VaultLens({ stages, selectedCollection, selectedGenres, snoozedCount, onClearGenres, onUseEntireVault, onClearSnoozes }: Props) {
  const finalCount = stages.at(-1)?.count ?? 0;
  const activeCount = stages[0]?.count ?? 0;

  return <div id="vault-lens-panel" className={styles.panel}>
      <div className={styles.heading}>
        <div><p>Deck eligibility</p><h3>{finalCount ? "How this deck was formed" : "No games reached the end of the Lens"}</h3></div>
        <span className={styles.finalCount} aria-live="polite">{finalCount} available</span>
      </div>
      <ol className={styles.funnel} aria-label="Vault eligibility stages">
        {stages.map((stage, index) => <li key={stage.id}>
          <span><strong>{stage.count}</strong>{stage.label}</span>
          {index < stages.length - 1 ? <span className={styles.arrow} aria-hidden="true">→</span> : null}
        </li>)}
      </ol>
      <div className={styles.actions}>
        {selectedGenres ? <button type="button" onClick={onClearGenres}>Clear Genres</button> : null}
        {selectedCollection ? <button type="button" onClick={onUseEntireVault}>Use Entire Vault</button> : null}
        {snoozedCount ? <button type="button" onClick={onClearSnoozes}>Clear Snoozes ({snoozedCount})</button> : null}
        <Link href="/library?tab=slept">View Slept</Link>
        {activeCount >= 40 ? <Link className={styles.purge} href="/purge">Want a more focused backlog? Open Purge</Link> : null}
      </div>
    </div>;
}
