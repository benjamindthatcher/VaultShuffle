import type { DemoGame } from "@/lib/demo-data";
import { formatMoney } from "@/lib/backlog-stats";
import { completionMetrics } from "@/lib/completion-history";
import { Artwork } from "@/components/shared/Artwork";
import { FamilyGameMark } from "@/components/shared/FamilyMark";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./FinishedGameCard.module.css";

export function FinishedGameCard({ game, currency, onSelect }: { game: DemoGame; currency: string; onSelect: (id: string) => void }) {
  const { hours, cents, centsPerHour } = completionMetrics(game);
  const validDate = game.completedAt && Number.isFinite(Date.parse(game.completedAt));
  return <li className={styles.card} data-vault-card="interactive">
    <button type="button" className={styles.open} data-vault-card-trigger onClick={() => onSelect(game.id)} aria-label={`Open ${game.title}`} />
    <span className={styles.art}><Artwork src={game.bannerUrl} sizes="(max-width: 540px) 90vw, (max-width: 1100px) 45vw, 260px" /><FamilyGameMark game={game} overlay /></span>
    <strong className={styles.title} title={game.title}>{game.title}</strong>
    <span className={styles.metrics}>
      <span className={styles.value}>{centsPerHour === null ? "—" : formatMoney(centsPerHour, currency)}<small>/hour</small></span>
      <small className={styles.meta}>{hours === null ? "—" : Math.round(hours)}h from {cents === null ? "—" : formatMoney(cents, currency)}</small>
    </span>
    <span className={styles.finished}><VaultIcon name="check" size={15} /><span>Finished {validDate ? <time dateTime={game.completedAt!}>{new Date(game.completedAt!).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</time> : "· Date unknown"}</span></span>
  </li>;
}
