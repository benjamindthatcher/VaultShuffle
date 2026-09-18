import Image from "next/image";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { deckLabel, type GameListRow } from "@/lib/blog/game-lists";
import { pickStat } from "@/lib/blog/stats";
import styles from "./GamePicks.module.css";

/**
 * The hand-written entries of a list post.
 *
 * IGN's list posts give every entry a heading, a fixed data line ("Time to
 * beat: 1h 20m, on average, for the Main Story") and a paragraph saying why it
 * is there. That paragraph is the reason their lists read as written by someone
 * rather than assembled, and it is the thing a generated table cannot do.
 *
 * So the entry is shaped like a magazine entry and not like a row: rank, name,
 * the one number the post is about, the opinion, and our own figures last. The
 * opinion is committed to the repo and the numbers beside it come from the
 * catalogue on every build, which is the only way round the fact that a note
 * written by hand about a game the filter later drops would otherwise be left
 * stranded.
 *
 * Our own numbers close the entry rather than opening it, and that ordering is
 * the whole argument. Ziff Davis owns HowLongToBeat and Ziff Davis owns IGN, so
 * a list built on duration is us republishing their data on a domain with none
 * of their authority. What they cannot copy is 383,663 owned rows: how long
 * people actually play a game before stopping, and how many of them ever finish
 * it. Celeste is an eight hour game the typical player leaves after three, and
 * that is ours to say.
 *
 * HLTB supplies the length estimate that decided membership and nothing beyond
 * it: no completionist figure, no second opinion on how long anything takes.
 * Where this page says what a game is actually like to play, the number under
 * it is ours.
 */

export type Pick = {
  appid: number;
  /** Why this one, in a sentence or two. Written, not generated. */
  note: string;
};

export function GamePicks({
  picks,
  data
}: {
  picks: readonly Pick[];
  data: Map<number, GameListRow & { qualifies: boolean }>;
}) {
  /* A pick the post's own filter no longer accepts is dropped rather than
     printed: the numbers beside it would contradict the post. */
  const shown = picks
    .map((pick) => ({ pick, game: data.get(pick.appid) }))
    .filter((entry): entry is { pick: Pick; game: GameListRow & { qualifies: boolean } } =>
      Boolean(entry.game?.qualifies)
    );

  if (shown.length === 0) return null;

  return (
    <ol className={styles.picks}>
      {shown.map(({ pick, game }) => {
        const ours = pickStat(game.appid);

        return (
          <li
            key={game.appid}
            className={game.headerUrl ? styles.pick : `${styles.pick} ${styles.pickNoArt}`}
          >
            <div className={styles.head}>
              <div className={styles.titleRow}>
                {/* The rank is drawn by a counter rather than written into the
                    markup, so a pick the filter drops does not leave a hole in
                    the numbering. The <ol> already carries the order for
                    anything not reading the page visually. */}
                <span className={styles.rank} aria-hidden="true" />
                <h3 className={styles.name}>
                  <a
                    href={`https://store.steampowered.com/app/${game.appid}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {game.name}
                    <VaultIcon className={styles.linkIcon} name="external-link" size={14} />
                  </a>
                </h3>
              </div>
              {/* Length leads and wears a chip. The post is a list of lengths,
                  so someone scrolling should be able to read 1.5h, 2.1h, 3.6h
                  down the page without stopping to read anything else. */}
              <div className={styles.meta}>
                <span className={styles.time}>
                  <strong>{game.mainStoryHours}h</strong> main story
                </span>
                <span className={styles.metaRest}>
                  <span>Steam Deck {deckLabel(game.deckCompatibility)}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {Math.round(game.positiveShare * 100)}% of{" "}
                    {game.reviewTotal.toLocaleString("en-GB")} reviews
                  </span>
                </span>
              </div>
            </div>
            {/* Decorative: the name is already a heading beside it. */}
            {game.headerUrl ? (
              <Image
                className={styles.art}
                src={game.headerUrl}
                alt=""
                width={460}
                height={215}
                sizes="(max-width: 860px) 100vw, 276px"
                loading="lazy"
                unoptimized
              />
            ) : null}
            <p className={styles.note}>{pick.note}</p>
            {ours ? (
              <div className={styles.ours}>
                <span className={styles.oursLabel}>
                  {/* The releases page marks its headings with an icon beside the
                      uppercase label. Same device, so the one place the two pages
                      already speak the same language speaks it a little more. */}
                  <VaultIcon name="in-library" size={13} />
                  In our libraries
                </span>
                <span className={styles.oursFigures}>
                  <span>
                    <strong>{ours.pctFinished}%</strong> of {ours.started} players finished it
                  </span>
                  <span aria-hidden="true">·</span>
                  {/* "average" rather than "median", which is the statistic
                      this actually is: readers parse the everyday word without
                      stopping, and a median is an average in the plain English
                      sense. The method doc says which one it is. */}
                  <span>
                    average <strong>{ours.medianHours}h</strong> played
                  </span>
                </span>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
