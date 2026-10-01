import Link from "next/link";
import { VaultIcon } from "@/components/shared/VaultIcon";
import type { VaultEligibilityStage, VaultMatchExplanation } from "@/lib/vault";
import shell from "./DeckPanel.module.css";
import styles from "./VaultLens.module.css";

type Props = {
  stages: VaultEligibilityStage[];
  pickExplanation?: VaultMatchExplanation | null;
  pickTitle?: string;
  selectedCollection: boolean;
  selectedGenres: boolean;
  snoozedCount: number;
  onClearGenres: () => void;
  onUseEntireVault: () => void;
  onClearSnoozes: () => void;
};

export function VaultLens({ pickExplanation, pickTitle, stages, selectedCollection, selectedGenres, snoozedCount, onClearGenres, onUseEntireVault, onClearSnoozes }: Props) {
  const availableCount = stages.find((stage) => stage.id === "available")?.count ?? 0;
  const deckCount = stages.find((stage) => stage.id === "shortlist")?.count ?? availableCount;
  // Purge is worth suggesting based on what is left to play, not the raw library.
  const activeCount = stages.find((stage) => stage.id === "active")?.count ?? stages[0]?.count ?? 0;

  return <div id="vault-lens-panel" className={shell.panel}>
      <div className={shell.heading}>
        <div><p>Deck eligibility</p><h3>{availableCount ? "How this deck was formed" : "No games reached the end of the Lens"}</h3></div>
        <span className={shell.meta} aria-live="polite">{deckCount}{availableCount > deckCount ? ` in deck · ${availableCount} available` : " available"}</span>
      </div>
      <ol className={styles.funnel} aria-label="Vault eligibility stages">
        {stages.map((stage, index) => <li key={stage.id}>
          <span>
            <strong>{stage.count}</strong>
            {stage.label}
            {stage.detail ? <small className={styles.stageDetail}>{stage.detail}</small> : null}
          </span>
          {index < stages.length - 1 ? <VaultIcon name="chevron-right" size={18} className={styles.arrow} /> : null}
        </li>)}
      </ol>
      {pickExplanation ? <p className={styles.stageDetail}>
        Last draw: {pickTitle} · contextual fit {pickExplanation.score}/100 · pool position {pickExplanation.rank} of {pickExplanation.poolSize}.
        Pool order uses fit and appeal; weighted selection can choose another finalist.
      </p> : null}
      <div className={shell.actions}>
        {selectedGenres ? <button type="button" data-vault-control="secondary" onClick={onClearGenres}>Clear Genres</button> : null}
        {selectedCollection ? <button type="button" data-vault-control="secondary" onClick={onUseEntireVault}>Use Entire Vault</button> : null}
        {snoozedCount ? <button type="button" data-vault-control="secondary" onClick={onClearSnoozes}>Clear Snoozes ({snoozedCount})</button> : null}
        <Link data-vault-control="tertiary" href="/library?tab=slept">View Blacklist</Link>
        {activeCount >= 40 ? <Link data-vault-control="tertiary" className={`${shell.trailing} ${styles.purge}`} href="/library?tab=active">Want a more focused backlog? Tidy it in the Library</Link> : null}
      </div>
    </div>;
}
