"use client";
import { useState } from "react";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import type { DemoGame } from "@/lib/demo-data";
import type { VaultDraw } from "@/lib/vault-history";
import shell from "./DeckPanel.module.css";
import styles from "./VaultHistoryPanel.module.css";

type Props = {
  draws: VaultDraw[];
  games: DemoGame[];
  isLive: boolean;
  onClear: () => Promise<void>;
  onViewDetails: (game: DemoGame) => void;
};

/**
 * Draw history, in the same panel below the draw bar that the Lens opens into.
 *
 * It used to slide in from the right as a modal, over a backdrop, with the page
 * behind it locked. That is a heavy way to show a list you glance at, and it put
 * a wall between the history and the deck it describes - the two things you are
 * comparing could never be on screen together.
 */
export function VaultHistoryPanel({ draws, games, isLive, onClear, onViewDetails }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? draws.find((draw) => draw.id === selectedId) ?? null : null;
  const game = selected ? games.find((item) => item.steamAppId === selected.steamAppId) ?? null : null;

  return (
    <div id="vault-history-panel" className={shell.panel}>
      <div className={shell.heading}>
        <div>
          <p>Vault deck</p>
          <h3>{selected && game ? game.title : "Draw history"}</h3>
        </div>
        <span className={shell.meta}>
          {draws.length ? `${draws.length} ${draws.length === 1 ? "draw" : "draws"}` : null}
          {draws.length && !isLive ? " · this visit" : null}
        </span>
      </div>

      {selected && game ? (
        <div className={styles.detail}>
          <div className={styles.detailArtwork}>
            <Artwork src={game.bannerUrl} sizes="(max-width: 700px) 100vw, 320px" />
          </div>
          <div className={styles.detailCopy}>
            <p className={styles.detailSetup}>{setupLabel(selected)}</p>
            <p className={styles.detailOutcome}>{eventLabel(selected.events[0]?.eventType)} · {drawTime(selected.drawnAt)}</p>
          </div>
        </div>
      ) : draws.length ? (
        <div className={styles.groups}>
          {groupDraws(draws).map(([label, entries]) => (
            <section key={label}>
              <h4 className={styles.groupLabel}>{label}</h4>
              {/* Across rather than down: inline, the panel is the width of the
                  page, and a single column would leave most of it empty. */}
              <ul className={styles.list}>
                {entries.map((draw) => {
                  const entryGame = games.find((item) => item.steamAppId === draw.steamAppId);
                  return (
                    <li key={draw.id}>
                      <button type="button" className={styles.entry} onClick={() => setSelectedId(draw.id)}>
                        {entryGame ? <span className={styles.thumb}><Artwork src={entryGame.bannerUrl} sizes="96px" /></span> : null}
                        <span className={styles.entryCopy}>
                          <strong>{entryGame?.title ?? `Steam App ${draw.steamAppId}`}</strong>
                          <small>{setupLabel(draw)}</small>
                          <em>{eventLabel(draw.events[0]?.eventType)}</em>
                        </span>
                        <time dateTime={draw.drawnAt}>{drawTime(draw.drawnAt)}</time>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <p className={styles.empty}>Games you draw from the Vault will show up here, with what you did about each one.</p>
      )}

      <div className={shell.actions}>
        {selected ? (
          <button type="button" onClick={() => setSelectedId(null)}><VaultIcon name="back" size={17} />Back to history</button>
        ) : null}
        {selected && game ? (
          <button type="button" onClick={() => onViewDetails(game)}><VaultIcon name="details" size={17} />View details</button>
        ) : null}
        {draws.length && !selected ? (
          <button type="button" className={shell.trailing} onClick={() => void onClear()}>Clear draw history</button>
        ) : null}
      </div>
    </div>
  );
}

function drawTime(drawnAt: string) {
  return new Date(drawnAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setupLabel(draw: VaultDraw) {
  if (draw.collectionId) return "Collection draw";
  const labels = { short: "Short", evening: "Evening", weekend: "Weekend", "brain-off": "Brain-Off", chill: "Chill", intense: "Intense", new: "Something New", finish: "Finish Something", surprise: "Surprise Me" };
  return draw.session && draw.mood && draw.goal
    ? `${labels[draw.session]} · ${labels[draw.mood]} · ${labels[draw.goal]}`
    : "Vault draw";
}

function eventLabel(type?: string) {
  if (!type) return "Drawn";
  return type.split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function groupDraws(draws: VaultDraw[]) {
  const groups = new Map<string, VaultDraw[]>();
  for (const draw of draws) {
    const date = new Date(draw.drawnAt);
    const now = new Date();
    const label = date.toDateString() === now.toDateString()
      ? "Today"
      : date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
    groups.set(label, [...(groups.get(label) ?? []), draw]);
  }
  return [...groups.entries()];
}
