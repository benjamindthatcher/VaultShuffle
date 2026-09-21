import type { DemoGame } from "@/lib/demo-data";
import { Artwork } from "@/components/shared/Artwork";
import { FamilyGameMark } from "@/components/shared/FamilyMark";
import { formatGameDuration } from "@/lib/game-duration";
import { progressLabel } from "@/lib/progress-display";
import { LibraryGameActions } from "./LibraryGameActions";
import styles from "./LibraryGameCard.module.css";

type Props = {
  game: DemoGame;
  layout: "grid" | "list";
  onSelect: () => void;
  onBlacklist: () => void;
  onComplete: () => void;
  onRestore: () => void;
  onPlayingNext: () => void;
  pinned: boolean;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
};

export function LibraryGameCard({ game, layout, onSelect, onBlacklist, onComplete, onRestore, onPlayingNext, pinned, selectable, selected, onToggleSelect }: Props) {
  const duration = formatGameDuration(game.duration);
  return <article className={styles.card} data-layout={layout} data-selected={selected || undefined} data-game-id={game.id}>
    <div className={styles.detailsWrap}>
      <button type="button" className={styles.details} onClick={selectable ? onToggleSelect : onSelect} aria-pressed={selectable ? selected : undefined} aria-label={`${selectable ? "Select" : "Details for"} ${game.title}`}>
        <span className={styles.artwork}><Artwork src={game.bannerUrl} sizes={layout === "list" ? "240px" : "(max-width: 760px) 100vw, 25vw"} /><FamilyGameMark game={game} overlay /></span>
        <span className={styles.body}>
          <span className={styles.title}>{game.title}</span>
          <span className={styles.status} data-status={game.status}>{game.status === "Slept" ? "Blacklisted" : game.status}</span>
          <span className={styles.meta}>{game.accessSource === "family" ? "Family library" : game.hoursPlayed > 0 ? `${game.hoursPlayed}h played` : "Fresh pick"}{duration ? ` · ${duration}` : ""}</span>
          <span className={styles.progress}>{progressLabel(game)}<span> progress</span></span>
        </span>
      </button>
      {selectable ? <label className={styles.selection}><input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`Select ${game.title}`} /></label> : null}
    </div>
    <LibraryGameActions status={game.status} pinned={pinned} onBlacklist={onBlacklist} onComplete={onComplete} onRestore={onRestore} onPlayingNext={onPlayingNext} />
  </article>;
}
