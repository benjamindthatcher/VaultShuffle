"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { GuestPreviewNotice } from "@/components/guest/GuestPreviewNotice";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import { PageHeading } from "@/components/shared/PageHeading";
import { SectionHeading } from "@/components/shared/SectionHeading";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { usePlayNext } from "@/components/play-next/usePlayNext";
import { PlayNextGrid, PlayNextNotice, PlayNextPinDialog, describeBasis } from "@/components/play-next/PlayNextShelf";
import { PLAY_NEXT_LANES, type PlayNextLane, type PlayNextPick, type PlayNextResult } from "@/lib/play-next";
import styles from "./play-next.module.css";

type Section = {
  id: string;
  title: string;
  blurb?: string;
  picks: PlayNextPick[];
  /** A "because" row names its seed in the heading, so its cards need no badge or reason line. */
  showLane: boolean;
  reasonInHeading: boolean;
};

const PER_SECTION = 4;

/**
 * Every kind of answer the shelf has, with room to say more than four.
 *
 * The dashboard shows one pick per lane. This is the rest: a row for each game
 * someone loved, and a row for each other kind of answer, interleaved so the
 * page does not open with five rows of the same idea. A game appears once, in
 * the first row that wants it.
 */
function buildSections(result: PlayNextResult): Section[] {
  const shown = new Set<string>();
  const take = (picks: PlayNextPick[]) => {
    const fresh = picks.filter((pick) => !shown.has(pick.game.id)).slice(0, PER_SECTION);
    for (const pick of fresh) shown.add(pick.game.id);
    return fresh;
  };

  const because = result.becauseGroups.map((group) => ({
    id: `because-${group.seed.id}`,
    title: group.headline,
    picks: group.picks,
    showLane: false,
    reasonInHeading: true
  }));
  const lane = (id: PlayNextLane) => {
    const meta = PLAY_NEXT_LANES.find((entry) => entry.id === id)!;
    return { id, title: meta.title, blurb: meta.blurb, picks: result.lanes[id], showLane: false, reasonInHeading: false };
  };

  const order = [
    because[0],
    lane("finish"),
    because[1],
    lane("gem"),
    because[2],
    lane("quick"),
    lane("return"),
    because[3],
    because[4],
    lane("acclaimed")
  ].filter((section): section is Section => Boolean(section));

  return order
    .map((section) => ({ ...section, picks: take(section.picks) }))
    .filter((section) => section.picks.length > 0);
}

export default function PlayNextPage() {
  const { games, allGames, collections, isLive, vaultState, recordVaultAction, updateGame, restoreGame, setGameCollection } = useAppData();
  const next = usePlayNext("page", 4);
  const { result } = next;
  const sections = useMemo(() => buildSections(result), [result]);

  const [detailsGameId, setDetailsGameId] = useState<string | null>(null);
  const [savingNotes, setSavingNotes] = useState(false);
  const detailsGame = detailsGameId
    ? games.find((game) => game.id === detailsGameId) ?? allGames.find((game) => game.id === detailsGameId) ?? null
    : null;

  return (
    <div className={styles.page}>
      <PageHeading eyebrow="Play next" title="What to play next">
        {result.candidateCount
          ? `Picked from the ${result.candidateCount} games still waiting in your ${isLive ? "library" : "preview"}, and every one says why.`
          : "Everything in play is finished, pinned or set aside."}
      </PageHeading>

      {!isLive ? (
        <GuestPreviewNotice feature="What to play next" icon="heart">
          Guests have no history to learn from, so this starts from what other players loved. Mark a game finished or set one aside and the suggestions follow.
        </GuestPreviewNotice>
      ) : null}

      <section className={styles.taste} aria-labelledby="play-next-taste">
        <h2 id="play-next-taste">What these are based on</h2>
        <p className={styles.basis}>{describeBasis(result.taste, isLive)}</p>
        {result.taste.likes.length ? (
          <div className={styles.tasteRow}>
            <span className={styles.tasteLabel}><VaultIcon name="heart" size={14} />You keep coming back to</span>
            <ul className={styles.chips} data-tone="like">
              {result.taste.likes.map((tag) => <li key={tag}>{tag}</li>)}
            </ul>
          </div>
        ) : null}
        {result.taste.avoids.length ? (
          <div className={styles.tasteRow}>
            <span className={styles.tasteLabel}><VaultIcon name="sleep" size={14} />You tend to set aside</span>
            <ul className={styles.chips} data-tone="avoid">
              {result.taste.avoids.map((tag) => <li key={tag}>{tag}</li>)}
            </ul>
          </div>
        ) : null}
        <p className={styles.hint}>
          Hiding a suggestion for now snoozes it for two weeks. Setting one aside moves it to your{" "}
          <Link href="/library?tab=slept">Slept shelf</Link>, where it can be restored. To rule out a whole kind of game, use the
          filters on your <Link href="/dashboard">Dashboard</Link>.
        </p>
      </section>

      <PlayNextNotice next={next} />

      {sections.map((section) => (
        <section key={section.id} className={styles.section} aria-labelledby={`play-next-${section.id}`}>
          <SectionHeading id={`play-next-${section.id}`} title={section.title} />
          {section.blurb ? <p className={styles.blurb}>{section.blurb}</p> : null}
          <PlayNextGrid
            picks={section.picks}
            next={next}
            onOpenGame={setDetailsGameId}
            showLane={section.showLane}
            reasonInHeading={section.reasonInHeading}
            surface="page"
          />
        </section>
      ))}

      {result.candidateCount && !sections.length ? (
        <p className={styles.empty}>Nothing stands out yet. Play a little of something and this fills in.</p>
      ) : null}

      <Link className={styles.vaultLink} href="/vault">
        Rather leave it to chance? Draw from the Vault<VaultIcon name="chevron-right" size={16} />
      </Link>

      <LibraryDetailsDrawer
        game={detailsGame}
        previewMode={!isLive}
        variant="library"
        pin={(vaultState.pins ?? []).find((entry) => entry.gameId === detailsGame?.id)}
        collections={collections}
        saving={savingNotes}
        onSave={async (patch) => {
          if (!detailsGame) return;
          setSavingNotes(true);
          try {
            await updateGame(detailsGame.id, patch);
          } finally {
            setSavingNotes(false);
          }
        }}
        onToggleCollection={async (collectionId, assigned) => {
          if (!detailsGame) return;
          await setGameCollection(detailsGame.id, collectionId, assigned);
        }}
        onClose={() => setDetailsGameId(null)}
        pinSlot={detailsGame ? vaultState.pinnedIds.indexOf(detailsGame.id) + 1 || null : null}
        pinCount={vaultState.pinnedIds.length}
        onTogglePin={() => {
          if (!detailsGame) return;
          void recordVaultAction(vaultState.pinnedIds.includes(detailsGame.id) ? "unpinned" : "pinned", detailsGame.id, { source: "play_next", surface: "page" });
        }}
        onComplete={async () => {
          if (!detailsGame) return;
          await updateGame(detailsGame.id, { status: "Completed", completedAt: new Date().toISOString(), sleptAt: null });
        }}
        onRestore={async () => {
          if (!detailsGame) return;
          await restoreGame(detailsGame.id);
        }}
        onSleep={async () => {
          if (!detailsGame) return;
          await updateGame(detailsGame.id, { status: "Slept", sleptAt: new Date().toISOString(), completedAt: null });
        }}
      />
      <PlayNextPinDialog next={next} />
    </div>
  );
}
