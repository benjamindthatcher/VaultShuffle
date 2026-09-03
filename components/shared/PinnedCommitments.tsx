"use client";

import type { CSSProperties } from "react";
import type { DemoGame } from "@/lib/demo-data";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import type { VaultPin } from "@/lib/vault-state";
import { Artwork } from "@/components/shared/Artwork";
import { formatRemainingDuration } from "@/lib/game-duration";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { PinnedPlaytimeRefresh } from "@/components/shared/PinnedPlaytimeRefresh";
import { pinInstrument, pinProgressHours } from "@/lib/completion-celebration";
import { formatTrackedHours } from "@/lib/pinned-run";
import styles from "./PinnedCommitments.module.css";
import { FamilyGameMark } from "@/components/shared/FamilyMark";

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
  // A pin outranks the global filters. Someone said "this is what I am playing
  // next", and a filter set afterwards - five years or newer, single-player only
  // - would otherwise retire that decision without saying so: the shelf would
  // just be a game shorter. So the caller's list is asked first, which keeps
  // whatever it enriched the game with, and the unfiltered library answers for
  // anything the filters have ruled out.
  const { allGames } = useAppData();

  // Defaulted because the state arrives from the API through an unchecked cast:
  // a server response missing this field should degrade to "no progress known",
  // never take the page down.
  const pinned = pinnedIds
    .map((id) => games.find((game) => game.id === id) ?? allGames.find((game) => game.id === id))
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
          const bar = pinInstrument(game, pinFor(game.id));
          const earnedPercent = bar.atPin === null ? null : Math.max(0, bar.percent - bar.atPin);
          const progressStyle = {
            "--pin-before": `${bar.atPin ?? bar.percent}%`,
            "--pin-progress": `${bar.percent}%`
          } as CSSProperties;
          // What is left, rather than the fact that an estimate exists. Falls
          // back to naming the estimate only when the hours cannot be given.
          const remainingLabel = formatRemainingDuration(game.duration, bar.percent);
          const storyCue = earnedPercent === null
            ? remainingLabel ?? "Current estimate"
            : earnedPercent > 0
              ? `+${earnedPercent}% since pinning`
              : progress?.started
                ? "Keep the dial moving"
                : "Play to move it";
          // The run dial's second line says why there is no percentage, rather
          // than repeating the hours the gauge and the line above it already
          // carry. Someone looking at a card without a number on it is asking
          // that question, not asking for the hours a third time.
          const runCue = game.duration?.endless ? "No ending to reach" : "No length estimate yet";
          // A shared game's dial has nothing to fill it, so it says what it is
          // instead of what it measured.
          const isShared = bar.kind === "shared";
          const sharedCue = game.familyOwnerName ? `From ${game.familyOwnerName}` : "From the family shelf";
          const totalHours = Math.max(0, Number(game.hoursPlayed) || 0);
          const isRun = bar.kind === "run";
          const gaugeHours = totalHours >= 10 ? Math.round(totalHours) : Number(totalHours.toFixed(1));
          const readoutLabel = isShared
            ? "Playtime not tracked"
            : isRun
            ? bar.atPin === null
              ? `${formatTrackedHours(totalHours)} played`
              : `${formatTrackedHours(totalHours)} played, ${formatTrackedHours(totalHours * (bar.percent - bar.atPin) / 100)} of it since pinning`
            : bar.atPin === null
              ? `${bar.percent}% through`
              : `${bar.percent}% through, ${bar.percent - bar.atPin}% of it since pinning`;
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
                <span className={styles.art}><Artwork src={game.bannerUrl} sizes="180px" /><FamilyGameMark game={game} overlay /></span>
                <span className={styles.body}>
                  <strong>{game.title}</strong>
                  <small>{label ?? `${Math.round(game.hoursPlayed)}h played`}</small>
                  <span
                    className={styles.progressInstrument}
                    data-kind={bar.kind}
                    role="img"
                    aria-label={readoutLabel}
                    style={progressStyle}
                  >
                    <span className={styles.progressReadout} aria-hidden="true">
                      <span className={styles.progressMeta}>
                        <span>{isShared ? "Family game" : isRun ? "Your run" : "Story progress"}</span>
                        <span data-earned={!isRun && !isShared && earnedPercent !== null && earnedPercent > 0 ? "true" : undefined}>
                          {isShared ? sharedCue : isRun ? runCue : storyCue}
                        </span>
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
                        {isShared ? (
                          <VaultIcon name="family" size={20} />
                        ) : isRun ? (
                          <strong>{gaugeHours}<small>h</small></strong>
                        ) : (
                          <strong>{bar.percent}<small>%</small></strong>
                        )}
                        <span>{isShared ? "shared" : isRun ? "played" : "complete"}</span>
                      </span>
                    </span>
                  </span>
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
