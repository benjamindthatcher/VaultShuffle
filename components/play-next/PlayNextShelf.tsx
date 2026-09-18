"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { keepSlots, type PlayNextPick, type PlayNextTaste } from "@/lib/play-next";
import { SectionHeading } from "@/components/shared/SectionHeading";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ManagePinsDialog } from "@/components/shared/ManagePinsDialog";
import { PlayNextCard } from "./PlayNextCard";
import { usePlayNext, type PlayNextSurface } from "./usePlayNext";
import styles from "./PlayNextShelf.module.css";

type Props = {
  /** Opens the dashboard's own details panel, so a suggestion behaves like every other card there. */
  onOpenGame: (gameId: string) => void;
};

/**
 * The dashboard's answer to "what should I play": four picks, each a different
 * kind of answer, each saying why.
 *
 * Sits directly under the pinned shelf because it feeds it. Pinning is how a
 * suggestion becomes a commitment, and the two read as one idea: what you said
 * you would play next, then what we would put next to it.
 */
export function PlayNextShelf({ onOpenGame }: Props) {
  const next = usePlayNext("dashboard", 4);
  const { result } = next;

  // The order the cards were last shown in, so a rebuild after a dismissal
  // fills the empty slot rather than reshuffling the cards nobody touched.
  // Adjusted during render, which is how React wants state derived from a
  // changing input: no flash of the old order, no effect.
  const [slots, setSlots] = useState<string[]>([]);
  const top = keepSlots(slots, result.top);
  const topIds = top.map((pick) => pick.game.id);
  if (topIds.join() !== slots.join()) setSlots(topIds);

  // Everything is finished, set aside or pinned. Worth saying rather than
  // leaving a gap - it is the rarest and best state a backlog can be in.
  if (!result.candidateCount) {
    return (
      <section className={styles.shelf} aria-labelledby="play-next-title">
        <SectionHeading id="play-next-title" title="What to play next" />
        <p className={styles.allDone}>Nothing left waiting. Every game in play is finished, pinned or set aside.</p>
      </section>
    );
  }

  if (!top.length) return null;

  return (
    <section className={styles.shelf} aria-labelledby="play-next-title">
      <SectionHeading
        id="play-next-title"
        title="What to play next"
        action={(
          <Link className={styles.seeAll} href="/play-next">
            More suggestions<VaultIcon name="chevron-right" size={15} />
          </Link>
        )}
      />
      <p className={styles.basis}>{describeBasis(result.taste, next.isLive)}</p>

      <PlayNextNotice next={next} />
      <PlayNextGrid picks={top} next={next} surface="dashboard" onOpenGame={onOpenGame} />
      <PlayNextPinDialog next={next} />
    </section>
  );
}

type Controller = ReturnType<typeof usePlayNext>;

export function PlayNextGrid({
  picks,
  next,
  onOpenGame,
  showLane = true,
  reasonInHeading = false,
  surface
}: {
  picks: PlayNextPick[];
  next: Controller;
  onOpenGame: (gameId: string) => void;
  showLane?: boolean;
  reasonInHeading?: boolean;
  surface: PlayNextSurface;
}) {
  return (
    <ol className={styles.grid} data-surface={surface}>
      {picks.map((pick, index) => (
        <PlayNextCard
          key={pick.game.id}
          pick={pick}
          pinsFull={next.pinsFull}
          showLane={showLane}
          reasonInHeading={reasonInHeading}
          onOpen={() => { next.opened(pick, index + 1); onOpenGame(pick.game.id); }}
          onPin={() => void next.pin(pick, index + 1)}
          onNotNow={() => void next.notNow(pick, index + 1)}
          onNotForMe={() => void next.notForMe(pick, index + 1)}
          onLaunch={() => next.launched(pick, index + 1)}
        />
      ))}
    </ol>
  );
}

/**
 * What just happened, and the way back.
 *
 * Both dismissals are reversible and both take effect instantly - the card is
 * gone before the request lands - so the undo has to be right where the card
 * was, not in a menu somewhere.
 */
export function PlayNextNotice({ next }: { next: Controller }) {
  const undoRef = useRef<HTMLButtonElement>(null);
  // The card that had focus has just gone, which drops a keyboard user back to
  // the top of the page. The way back is the most useful place to land instead.
  useEffect(() => {
    if (next.undo) undoRef.current?.focus({ preventScroll: true });
  }, [next.undo]);

  const text = next.undo
    ? next.undo.kind === "snoozed"
      ? `${next.undo.title} is hidden for two weeks.`
      : `${next.undo.title} is set aside. You will see fewer games like it.`
    : next.message;

  return (
    <div className={styles.notice} aria-live="polite" data-empty={!text || undefined}>
      {text ? (
        <>
          <span>{text}</span>
          {next.undo ? (
            <button ref={undoRef} type="button" onClick={() => void next.undoLast()}>
              <VaultIcon name="undo" size={14} />Undo
            </button>
          ) : null}
          <button type="button" className={styles.noticeClose} aria-label="Dismiss" onClick={next.dismissNotice}>
            <VaultIcon name="close" size={13} />
          </button>
        </>
      ) : null}
    </div>
  );
}

export function PlayNextPinDialog({ next }: { next: Controller }) {
  if (!next.pinCandidate || !next.pinsFull) return null;
  return (
    <ManagePinsDialog
      pinnedGames={next.pinnedGames}
      candidate={next.pinCandidate}
      onRemove={next.removePin}
      onReplace={next.replacePin}
      onClose={next.closePinDialog}
    />
  );
}

/**
 * One sentence on what the picks are made of.
 *
 * The honest version, including when there is nothing to go on yet: a shelf
 * that looks personal and is not is worse than one that says it is starting
 * from what everybody else loved.
 */
export function describeBasis(taste: PlayNextTaste, isLive: boolean) {
  if (!isLive) return "A preview from the guest catalogue. Mark a game finished or set one aside and watch these change.";
  const parts = [
    taste.finished ? `${taste.finished} finished ${taste.finished === 1 ? "game" : "games"}` : null,
    taste.played ? `${taste.played} you have put real time into` : null,
    taste.setAside ? `${taste.setAside} you set aside` : null
  ].filter(Boolean) as string[];
  if (!parts.length) {
    return "Nothing played long enough to learn from yet, so these start from what other players loved. Finish a few and they become yours.";
  }
  const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `From your own backlog, based on ${listed}.`;
}
