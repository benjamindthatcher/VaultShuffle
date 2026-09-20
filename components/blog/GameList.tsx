import Image from "next/image";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { deckLabel, fetchGameList, type GameListFilter } from "@/lib/blog/game-lists";
import styles from "./GameList.module.css";

/**
 * A game table inside a post, filled from the catalogue at build time.
 *
 * Art is unoptimized and lazy on purpose. These are Steam's own 460x215
 * headers, already the right size and already on a CDN; running forty of them
 * through the image optimiser would bill a transformation each to change
 * nothing. Nothing here is above the fold, so none of it is priority.
 */
export async function GameList({
  filter,
  caption
}: {
  filter: GameListFilter;
  caption?: string;
}) {
  const rows = await fetchGameList(filter);

  if (rows.length === 0) {
    return (
      <p className={styles.empty}>
        No games in the catalogue currently match this list. That is a data gap, not an empty category.
      </p>
    );
  }

  return (
    <figure className={styles.wrap}>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Game</th>
              <th scope="col">Main story</th>
              <th scope="col">Steam Deck</th>
              <th scope="col">Steam reviews</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.appid}>
                <th scope="row" className={styles.gameCell}>
                  {row.headerUrl ? (
                    <Image
                      className={styles.art}
                      src={row.headerUrl}
                      alt=""
                      width={92}
                      height={43}
                      loading="lazy"
                      unoptimized
                    />
                  ) : null}
                  <a
                    className={styles.gameLink}
                    href={`https://store.steampowered.com/app/${row.appid}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span>{row.name}</span>
                    <VaultIcon className={styles.linkIcon} name="external-link" size={13} />
                  </a>
                </th>
                <td data-label="Main story">
                  {row.mainStoryHours === null ? "Unknown" : `${row.mainStoryHours}h`}
                </td>
                <td data-label="Steam Deck">
                  <span
                    className={`${styles.deck} ${
                      row.deckCompatibility === 3 ? styles.deckVerified : styles.deckPlayable
                    }`}
                  >
                    {deckLabel(row.deckCompatibility)}
                  </span>
                </td>
                <td data-label="Steam reviews">
                  <strong>{Math.round(row.positiveShare * 100)}%</strong>
                  <span className={styles.reviewCount}>
                    of {row.reviewTotal.toLocaleString("en-GB")}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {caption ? <figcaption className={styles.caption}>{caption}</figcaption> : null}
    </figure>
  );
}
