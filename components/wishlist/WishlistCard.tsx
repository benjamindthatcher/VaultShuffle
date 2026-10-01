"use client";

import { useState } from "react";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { steamHeaderImage, steamStoreUrl } from "@/lib/steam-images";
import { hasFiniteWishlistStory, type WishlistGame, type WishlistInteractionContext } from "@/lib/wishlist";
import { ANALYTICS_EVENTS, trackNavigationEvent } from "@/lib/analytics";
import styles from "./Wishlist.module.css";

type WishlistCardProps = {
  onOpen: () => void; game: WishlistGame; reason?: string; saved: boolean; owned?: boolean; disabled: boolean; busy?: boolean; context: WishlistInteractionContext; eager?: boolean; onToggle: (game: WishlistGame) => void;
};

export function WishlistCard(props: WishlistCardProps) {
  const { game, reason, saved, owned, disabled, busy = false, context, eager = false, onToggle, onOpen } = props;
  const [failed, setFailed] = useState(false);
  const image = steamHeaderImage(game.appId);
  function trackStoreOpen() {
    trackNavigationEvent(ANALYTICS_EVENTS.wishlistStoreOpened, { ...context, steam_appid: game.appId, is_saved: saved, in_library: Boolean(owned), control: "store_button" });
  }
  return <article className={styles.card} data-vault-card="interactive" data-appid={game.appId}>
    <button type="button" className={styles.detailsTrigger} data-vault-card-trigger aria-label={`Details for ${game.title}`} aria-haspopup="dialog" onClick={onOpen} />
    <div className={styles.art}>
      {/* Native Steam header artwork is already 460×215; preserve its ratio without image optimisation. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {!failed ? <img src={image} alt="" width={460} height={215} loading={eager ? "eager" : "lazy"} onError={() => setFailed(true)} /> : <span className={styles.artFallback}><VaultIcon name="all-games" size={40} />{game.title}</span>}
      {game.source === "steam" ? <span className={styles.source}>From Steam</span> : null}
    </div>
    <div className={styles.cardBody}>
      <h3 title={game.title}>{game.title}</h3>
      <p className={styles.genres}>{game.genres.slice(0, 3).join(" · ") || "Discover on Steam"}</p>
      <p className={styles.reason} title={reason}>{owned ? "Already in your library" : reason || (game.endless ? "A game to keep coming back to" : game.minutes ? `About ${Math.max(1, Math.round(game.minutes / 60))} hours for the main story` : "Something to look forward to")}</p>
      <div className={styles.cardMeta}>
      <p className={styles.metrics}>
        <span>{game.reviews && game.positive != null ? `${Math.round(game.positive / game.reviews * 100)}% positive` : "Reviews unavailable"}</span>
        <span>{hasFiniteWishlistStory(game) ? `~${Math.max(1, Math.round(game.minutes! / 60))}h story` : game.endless ? "Endless" : "Length unknown"}</span>
      </p>
      <div className={styles.price} aria-label="Steam price">
        {game.price ? <><strong>{game.price.current}</strong>{game.price.discount > 0 ? <><del>{game.price.original}</del><span className={styles.discount}>−{game.price.discount}%</span></> : null}</> : <span>{game.release || (game.storeStatus ? "Check price on Steam" : "Loading price…")}</span>}
      </div>
      </div>
      <div className={styles.cardActions}>
        <button type="button" data-vault-control="selection" data-control-hover="secondary" className={styles.saveButton} data-saved={saved} disabled={disabled || busy || (owned && !saved)} aria-busy={busy} aria-pressed={saved} aria-label={`${saved ? "Remove" : "Add"} ${game.title} ${saved ? "from" : "to"} wishlist`} onClick={() => onToggle(game)}>
          {busy ? <span data-control-spinner aria-hidden="true" /> : <VaultIcon name={saved ? "check" : "add"} size={15} />}{busy ? "Updating…" : saved ? "Saved" : owned ? "In library" : "Wishlist"}
        </button>
        <a data-vault-control="steam" className={styles.steamButton} href={steamStoreUrl(game.appId)} target="_blank" rel="noreferrer" onClick={trackStoreOpen}>
          {/* Steam's own favicon supplies the official symbol. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/steam-favicon.ico" alt="" width={18} height={18} />View on Steam
        </a>
      </div>
    </div>
  </article>;
}
