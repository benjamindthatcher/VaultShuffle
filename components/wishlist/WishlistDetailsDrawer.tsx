"use client";

import { GameDetailsDialog } from "@/components/shared/GameDetailsDialog";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { steamHeaderImage, steamStoreUrl } from "@/lib/steam-images";
import { hasFiniteWishlistStory, type WishlistGame, type WishlistInteractionContext } from "@/lib/wishlist";
import { ANALYTICS_EVENTS, trackNavigationEvent } from "@/lib/analytics";
// Use the Library popup's actual layout, artwork, controls and modal behaviour.
import styles from "@/components/library/LibraryDetailsDrawer.module.css";
import actionStyles from "@/components/library/LibraryGameActions.module.css";

export function WishlistDetailsDrawer({ game, saved, owned, disabled, busy, context, onToggle, onClose }: {
  game: WishlistGame | null;
  saved: boolean;
  owned: boolean;
  disabled: boolean;
  busy: boolean;
  context: WishlistInteractionContext;
  onToggle: (game: WishlistGame) => void;
  onClose: () => void;
}) {
  if (!game) return null;

  const duration = hasFiniteWishlistStory(game) ? `~${Math.max(1, Math.round(game.minutes! / 60))}h story` : game.endless ? "Endless" : "Not available";
  return <GameDetailsDialog
    gameId={String(game.appId)} title={game.title} artwork={game.image || steamHeaderImage(game.appId)}
    description={game.description || (game.storeStatus ? "Steam hasn’t supplied a description. Open the store page to learn more." : "Loading Steam description…")}
    actions={<>
        <a data-vault-control="steam" className={styles.steamButton} href={steamStoreUrl(game.appId)} target="_blank" rel="noreferrer" onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.wishlistStoreOpened, { ...context, steam_appid: game.appId, is_saved: saved, in_library: owned, control: "details_store_button" })}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/steam-favicon.ico" alt="" width={20} height={20} /><span>View on Steam</span><VaultIcon name="chevron-right" size={18} className={styles.steamArrow} />
        </a>
        <div className={actionStyles.actions}>
          <button type="button" data-vault-control="selection" data-control-hover="secondary" className={actionStyles.next} disabled={disabled || busy || (owned && !saved)} aria-busy={busy} aria-pressed={saved} aria-label={`${saved ? "Remove" : "Add"} ${game.title} ${saved ? "from" : "to"} wishlist`} onClick={() => onToggle(game)}>
            {busy ? <span data-control-spinner aria-hidden="true" /> : <VaultIcon name={saved ? "check" : "add"} size={18} />}{busy ? "Updating…" : saved ? "Saved" : owned ? "In library" : "Wishlist"}
          </button>
        </div>
    </>}
    stats={[
      { icon: "heart", label: "Wishlist", value: saved ? "Saved" : "Not saved" },
      { icon: "price", label: "Steam price", value: `${game.price?.current || game.release || (game.storeStatus ? "Check on Steam" : "Loading…")}${game.price && game.price.discount > 0 ? ` (${game.price.discount}% off)` : ""}` },
      { icon: "clock", label: "Estimated length", value: duration },
      { icon: "trophy", label: "Steam reviews", value: game.reviews && game.positive != null ? `${Math.round(game.positive / game.reviews * 100)}% positive` : "Not available" },
    ]}
    genres={game.genres} onClose={onClose}
  />;
}
