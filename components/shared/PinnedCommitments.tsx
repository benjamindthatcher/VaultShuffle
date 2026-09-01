"use client";

import type { CSSProperties } from "react";
import type { DemoGame } from "@/lib/demo-data";
import type { VaultPin } from "@/lib/vault-state";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { PinnedPlaytimeRefresh } from "@/components/shared/PinnedPlaytimeRefresh";
import { pinProgressBar, pinProgressHours } from "@/lib/completion-celebration";
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
  pins?: VaultPin[];
  pinnedIds: string[];
  onSelect?: (gameId: string) => void;
  onUnpin?: (gameId: string) => void;
  compact?: boolean;
};

export function PinnedCommitments({ games, pins = [], pinnedIds, onSelect, onUnpin, compact = false }: Props) {
  // Defaulted because the state arrives from the API through an unchecked cast:
  // a server response missing this field should degrade to "no progress known",
  // never take the page down.
  const pinned = pinnedIds
    .map((id) => games.find((game) => game.id === id))
    .filter((game): game is DemoGame => Boolean(game));
  if (!pinned.length) return null;

  const pinFor = (gameId: string) => pins.find((pin) => pin.gameId === gameId);

  return (
    <section className={compact ? styles.compact : styles.panel} aria-label="Games you have committed to">
      <header className={styles.header}>
        <p className={styles.label}>Playing next <span className={styles.count}>{pinned.length}/3</span></p>
        <span className={styles.slotDots} role="img" aria-label={`${pinned.length} of 3 pins used`}>
          {[0, 1, 2].map((slot) => <span key={slot} data-filled={slot < pinned.length || undefined} />)}
        </span>
        <PinnedPlaytimeRefresh />
      </header>
      <ul className={styles.list}>
        {pinned.map((game) => {
          const label = pinProgressLabel(game, pinFor(game.id));
          const progress = pinProgress(game, pinFor(game.id));
          const bar = pinProgressBar(game, pinFor(game.id));
          const earnedPercent = bar?.atPin === null || bar?.atPin === undefined
            ? null
            : Math.max(0, bar.percent - bar.atPin);
          const progressStyle = bar ? {
            "--pin-before": `${bar.atPin ?? bar.percent}%`,
            "--pin-progress": `${bar.percent}%`
          } as CSSProperties : undefined;
          const progressCue = earnedPercent === null
            ? "Current estimate"
            : earnedPercent > 0
              ? `+${earnedPercent}% since pinning`
              : progress?.started
                ? "Keep the dial moving"
                : "Play to move it";
          return (
            <li key={game.id} className={styles.item} data-started={progress?.started ? "yes" : "no"}>
              {onUnpin ? (
                <button
                  type="button"
                  className={styles.unpin}
                  aria-label={`Unpin ${game.title}`}
                  title="Unpin"
                  onClick={() => onUnpin(game.id)}
                ><VaultIcon name="close" size={14} /></button>
              ) : null}
              <button type="button" className={styles.card} onClick={() => onSelect?.(game.id)} disabled={!onSelect}>
                <span className={styles.art}><Artwork src={game.bannerUrl} sizes="180px" /></span>
                <span className={styles.body}>
                  <strong>{game.title}</strong>
                  <small>{label ?? `${Math.round(game.hoursPlayed)}h played`}</small>
                  {bar ? (
                    <span
                      className={styles.progressInstrument}
                      role="img"
                      aria-label={bar.atPin === null
                        ? `${bar.percent}% through`
                        : `${bar.percent}% through, ${bar.percent - bar.atPin}% of it since pinning`}
                      style={progressStyle}
                    >
                      <span className={styles.progressReadout} aria-hidden="true">
                        <span className={styles.progressMeta}>
                          <span>Story progress</span>
                          <span data-earned={earnedPercent !== null && earnedPercent > 0 ? "true" : undefined}>{progressCue}</span>
                        </span>
                        <span className={styles.track}>
                          <span className={styles.fill}>
                            <span className={styles.trackBefore} style={{ width: `${bar.atPin ?? bar.percent}%` }} />
                            {bar.atPin === null ? null : (
                              <span className={styles.trackSince} style={{ left: `${bar.atPin}%`, width: `${bar.percent - bar.atPin}%` }} />
                            )}
                          </span>
                          {/* Only worth marking once there is something on each side
                              of it. At 0% it is a tick against an empty bar. */}
                          {bar.atPin !== null && bar.atPin > 0 && bar.percent > bar.atPin ? (
                            <span className={styles.notch} style={{ left: `${bar.atPin}%` }} />
                          ) : null}
                        </span>
                      </span>
                      <span className={styles.progressGauge} aria-hidden="true">
                        <span className={styles.progressGaugeFace}>
                          <strong>{bar.percent}<small>%</small></strong>
                          <span>complete</span>
                        </span>
                      </span>
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
        {Array.from({ length: Math.max(0, 3 - pinned.length) }, (_, index) => (
          <li key={`empty-${index}`} className={styles.emptySlot}>Empty slot</li>
        ))}
      </ul>
    </section>
  );
}
