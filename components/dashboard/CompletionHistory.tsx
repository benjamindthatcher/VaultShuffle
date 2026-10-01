"use client";

import type { DemoGame } from "@/lib/demo-data";
import { formatMoney } from "@/lib/backlog-stats";
import { completionMetrics } from "@/lib/completion-history";
import { Artwork } from "@/components/shared/Artwork";
import { FamilyGameMark } from "@/components/shared/FamilyMark";
import { VaultIcon } from "@/components/shared/VaultIcon";
import shell from "@/components/vault/DeckPanel.module.css";
import history from "@/components/vault/VaultHistoryPanel.module.css";
import styles from "./CompletionHistory.module.css";

export function CompletionHistory({ games, currency, onSelect, total, loadMore, pending, error, retry }: {
  games: DemoGame[]; currency: string; onSelect: (id: string) => void;
  total?: number; loadMore?: () => Promise<void>; pending?: boolean; error?: string | null; retry?: () => void;
}) {
  const groups = new Map<string, DemoGame[]>();
  for (const game of games) {
    const label = game.completedAt && Number.isFinite(Date.parse(game.completedAt))
      ? new Date(game.completedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : "Date unknown";
    const group = groups.get(label);
    if (group) group.push(game);
    else groups.set(label, [game]);
  }

  return <section id="completion-history-panel" className={shell.panel} aria-labelledby="completion-history-title">
    <div className={shell.heading}>
      <div><p>Your library</p><h3 id="completion-history-title">Completion history</h3></div>
      <span className={shell.meta}>{total ?? games.length} finished</span>
    </div>
    {games.length ? <div className={history.groups} tabIndex={0} role="region" aria-label="Completed games, most recent first">
      {[...groups].map(([label, entries]) => <section key={label}>
        <h4 className={history.groupLabel}>{label}</h4>
        <ul className={history.list}>
          {entries.map((game) => {
            const { hours, cents, centsPerHour } = completionMetrics(game);
            return <li key={game.id}>
              <button type="button" data-vault-card="interactive" className={`${history.entry} ${styles.entry}`} onClick={() => onSelect(game.id)} aria-label={`Open ${game.title}, finished ${label}`}>
                <span className={history.thumb}><Artwork src={game.bannerUrl} sizes="96px" /><FamilyGameMark game={game} overlay /></span>
                <span className={history.entryCopy}>
                  <strong title={game.title}>{game.title}</strong>
                  <small><span className={styles.value}>{centsPerHour === null ? "—" : formatMoney(centsPerHour, currency)}/hour</span> · {hours === null ? "—" : Math.round(hours)}h from {cents === null ? "—" : formatMoney(cents, currency)}</small>
                  <span className={styles.finished}><VaultIcon name="check" size={13} />Finished</span>
                </span>
              </button>
            </li>;
          })}
        </ul>
      </section>)}
    </div> : !pending && !error ? <p className={history.empty}>Nothing finished yet.</p> : null}
    {error ? <p role="alert">{error} <button type="button" data-vault-control="secondary" onClick={retry}>Retry</button></p> : null}
    {loadMore ? <button type="button" data-vault-control="secondary" disabled={pending} aria-busy={pending} onClick={() => { void loadMore(); }}>{pending ? <><span data-control-spinner aria-hidden="true" />Loading…</> : "Load more completions"}</button> : pending ? <p role="status">Loading completion history…</p> : null}
  </section>;
}
