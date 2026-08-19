"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import type { DemoGame } from "@/lib/demo-data";
import type { VaultPin } from "@/lib/vault-state";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { Artwork } from "@/components/shared/Artwork";
import { buildBacklogStats, formatMoney } from "@/lib/backlog-stats";
import { completionMilestone } from "@/lib/completion-celebration";
import styles from "./CompletionCelebration.module.css";

type Props = {
  game: DemoGame;
  games: DemoGame[];
  pin: VaultPin | undefined;
  onDismiss: () => void;
  onUndo: () => void;
};

export function CompletionCelebration({ game, games, pin, onDismiss, onUndo }: Props) {
  const stats = buildBacklogStats(games);
  const milestone = completionMilestone(game, stats.completedGames, pin);
  const worth = game.isFree ? 0 : Number(game.priceInitial ?? 0);

  // Held in a ref rather than a dependency. Callers pass an inline arrow, so
  // depending on it re-ran this effect on every parent render — cancelling the
  // animation frame before it could fade the card in, and restarting the
  // auto-dismiss timer indefinitely.
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; });

  // The entry animation is pure CSS. Driving it from requestAnimationFrame meant
  // it never ran on a backgrounded tab — rAF is paused while the document is
  // hidden — so completing a game and switching away left the card stuck at zero
  // opacity until it silently dismissed itself.
  const holdMs = milestone.spectacle === "big" ? 9000 : 6500;
  useEffect(() => {
    const timer = window.setTimeout(() => dismissRef.current(), holdMs);
    return () => window.clearTimeout(timer);
  }, [holdMs]);

  return (
    <div className={styles.wrap} data-spectacle={milestone.spectacle} role="status" aria-live="polite">
      {milestone.spectacle === "big" ? (
        <div className={styles.sparks} aria-hidden="true">
          {Array.from({ length: 14 }, (_, index) => <span key={index} style={{ "--i": index } as React.CSSProperties} />)}
        </div>
      ) : null}

      <div className={styles.card}>
        <span className={styles.art}><Artwork src={game.bannerUrl} sizes="120px" /></span>
        <div className={styles.body}>
          <p className={styles.headline}><VaultIcon name="completed" size={17} />{milestone.headline}</p>
          <p className={styles.title}>{game.title}</p>
          <p className={styles.moved}>
            {worth ? <><strong>{formatMoney(worth, stats.currency)}</strong> added to your completed value · </> : null}
            <strong>{formatMoney(stats.completedValueCents, stats.currency)}</strong> of {formatMoney(stats.libraryValueCents, stats.currency)}
            {" "}({stats.valueCompletedPercent}%)
          </p>
          <div className={styles.track} aria-hidden="true">
            <span className={styles.fill} style={{ width: `${Math.max(stats.valueCompletedPercent, 1.5)}%` }} />
          </div>
        </div>
        <div className={styles.actions}>
          <Link className={styles.statsLink} href="/stats">See stats</Link>
          <button type="button" className={styles.undo} onClick={onUndo}>Undo</button>
          <button type="button" className={styles.close} onClick={onDismiss} aria-label="Dismiss">
            <VaultIcon name="close" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
