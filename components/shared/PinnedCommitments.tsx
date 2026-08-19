"use client";

import type { DemoGame } from "@/lib/demo-data";
import type { VaultPin } from "@/lib/vault-state";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { pinProgressHours } from "@/lib/completion-celebration";
import styles from "./PinnedCommitments.module.css";

/**
 * What a pin has actually amounted to.
 *
 * A pin says "this is what I'm playing next", so it should be able to prove
 * itself. Hours are measured from the playtime recorded when the pin was made,
 * which turns a bookmark into a commitment with a visible payoff — and gives the
 * completion moment something to land on.
 */
export function pinProgress(game: DemoGame, pin: VaultPin | undefined) {
  const gained = pinProgressHours(game, pin);
  if (gained === null) return null;
  return { gained, started: gained > 0.1 };
}

export function pinProgressLabel(game: DemoGame, pin: VaultPin | undefined) {
  const progress = pinProgress(game, pin);
  if (!progress) return null;
  if (!progress.started) return "Not started yet";
  const gained = progress.gained;
  return `${gained < 1 ? gained.toFixed(1) : Math.round(gained)}h played since you pinned it`;
}

type Props = {
  games: DemoGame[];
  pins: VaultPin[];
  pinnedIds: string[];
  onSelect?: (gameId: string) => void;
  compact?: boolean;
};

export function PinnedCommitments({ games, pins, pinnedIds, onSelect, compact = false }: Props) {
  const pinned = pinnedIds
    .map((id) => games.find((game) => game.id === id))
    .filter((game): game is DemoGame => Boolean(game));
  if (!pinned.length) return null;

  const pinFor = (gameId: string) => pins.find((pin) => pin.gameId === gameId);

  return (
    <section className={compact ? styles.compact : styles.panel} aria-label="Games you have committed to">
      <header className={styles.header}>
        <p className={styles.label}><VaultIcon name="pin" size={15} />Playing next</p>
        <span className={styles.count}>{pinned.length}/3</span>
      </header>
      <ul className={styles.list}>
        {pinned.map((game) => {
          const label = pinProgressLabel(game, pinFor(game.id));
          const progress = pinProgress(game, pinFor(game.id));
          return (
            <li key={game.id} className={styles.item} data-started={progress?.started ? "yes" : "no"}>
              <button type="button" className={styles.card} onClick={() => onSelect?.(game.id)} disabled={!onSelect}>
                <span className={styles.art}><Artwork src={game.bannerUrl} sizes="180px" /></span>
                <span className={styles.body}>
                  <strong>{game.title}</strong>
                  <small>{label ?? `${Math.round(game.hoursPlayed)}h played`}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
